// Agent workflow: Triage Agent -> Spare Parts Agent -> (human approval) -> Resolution Agent.
// Every stage is persisted on the incident row, so the workflow survives restarts and
// resumes after approval. Every agent decision and tool action is logged to `events`.

import { now, tx, nextNumber } from './db.js';
import { recommend, availability, MATCH, canon } from './knowledge.js';
import { explainRecommendation, answerChat } from './llm.js';

export const STAGES = {
  FAULT: 'Fault Detected',
  TRIAGE: 'Triage',
  INVENTORY: 'Inventory Search',
  KNOWLEDGE: 'Knowledge Search',
  APPROVAL: 'Awaiting Human Approval',
  RESERVED: 'Part Reserved',
  DISPATCHED: 'Technician Dispatched',
  REPAIR: 'Repair in Progress',
  RESOLVED: 'Resolved',
  FAILED: 'Failed / Needs Attention',
};

export const STAGE_OWNER = {
  [STAGES.FAULT]: 'Robot (self-report)',
  [STAGES.TRIAGE]: 'Triage Agent',
  [STAGES.INVENTORY]: 'Spare Parts Agent',
  [STAGES.KNOWLEDGE]: 'Spare Parts Agent',
  [STAGES.APPROVAL]: 'Logistics Parts Coordinator',
  [STAGES.RESERVED]: 'Resolution Agent',
  [STAGES.DISPATCHED]: 'Resolution Agent',
  [STAGES.REPAIR]: 'Maintenance Technician',
  [STAGES.RESOLVED]: 'Resolution Agent',
  [STAGES.FAILED]: 'Logistics Parts Coordinator',
};

const EXACT_PATH = [STAGES.FAULT, STAGES.TRIAGE, STAGES.INVENTORY, STAGES.RESERVED, STAGES.DISPATCHED, STAGES.REPAIR, STAGES.RESOLVED];
const KNOWLEDGE_PATH = [STAGES.FAULT, STAGES.TRIAGE, STAGES.INVENTORY, STAGES.KNOWLEDGE, STAGES.APPROVAL, STAGES.RESERVED, STAGES.DISPATCHED, STAGES.REPAIR, STAGES.RESOLVED];

const SLA_MINUTES = Number(process.env.SPARESPARK_SLA_MINUTES || 240);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Workflow {
  constructor(db, { stepMs = Number(process.env.SPARESPARK_STEP_MS ?? 1500), onChange = () => {} } = {}) {
    this.db = db;
    this.stepMs = stepMs;
    this.onChange = onChange; // (incident, eventName) -> void; used for webhooks
    this.timers = new Map();
    this.hooks = { afterRepairStarted: [] }; // demo simulator attaches here
  }

  // ---------- helpers ----------
  get(id) {
    const inc = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    if (!inc) throw new HttpError(404, `Incident ${id} not found`);
    return inc;
  }

  log(incidentId, actor, kind, message, data = null) {
    this.db.prepare('INSERT INTO events(incident_id, actor, kind, message, data_json, created_at) VALUES (?,?,?,?,?,?)')
      .run(incidentId, actor, kind, message, data ? JSON.stringify(data) : null, now());
  }

  setStage(id, stage, latestAction, extra = {}) {
    const fields = { stage, stage_owner: STAGE_OWNER[stage], latest_action: latestAction, ...extra };
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE incidents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    this.log(id, STAGE_OWNER[stage], 'stage', `${stage}: ${latestAction}`);
    this.emit(id, 'incident.stage_changed');
  }

  emit(id, eventName) {
    try { this.onChange(this.get(id), eventName); } catch (e) { console.warn('[workflow] onChange failed', e.message); }
  }

  schedule(id, fn, ms = this.stepMs) {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(async () => {
      this.timers.delete(id);
      try { await fn(); } catch (err) { this.fail(id, err); }
    }, ms);
    t.unref?.();
    this.timers.set(id, t);
  }

  fail(id, err) {
    console.error(`[workflow] incident ${id}:`, err);
    this.log(id, 'System', 'error', err.message || String(err));
    this.setStage(id, STAGES.FAILED, `Workflow error: ${err.message || err}`);
  }

  cancelAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- entry point ----------
  createIncident({ robot_id, robot_name, fault_code, demo_scenario = null, external_system = null, external_ref = null, external_number = null, reported_by = null }) {
    if (!fault_code) throw new HttpError(400, 'fault_code is required');
    const robot = robot_id
      ? this.db.prepare('SELECT * FROM robots WHERE id = ?').get(robot_id)
      : this.db.prepare('SELECT * FROM robots WHERE lower(name) = lower(?) OR external_ci_id = ?').get(robot_name ?? '', robot_name ?? '');
    if (!robot) throw new HttpError(404, 'Robot not found');

    if (external_system && external_ref) {
      const dup = this.db.prepare('SELECT id FROM incidents WHERE external_system = ? AND external_ref = ?').get(external_system, external_ref);
      if (dup) return { incident: this.get(dup.id), created: false };
    }
    if (robot.current_incident_id) {
      const open = this.db.prepare('SELECT * FROM incidents WHERE id = ? AND stage NOT IN (?, ?)').get(robot.current_incident_id, STAGES.RESOLVED, STAGES.FAILED);
      if (open) throw new HttpError(409, `${robot.name} already has open incident ${open.number}`);
    }

    const id = tx(this.db, () => {
      const created = new Date();
      const number = nextNumber(this.db, 'incident', 'SSI', 12041);
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO incidents(number, robot_id, fault_code, stage, stage_owner, latest_action, sla_status, sla_due_at, demo_scenario, external_system, external_ref, external_number, created_at, approval_status, repair_status)
        VALUES (?,?,?,?,?,?, 'In Progress', ?, ?, ?, ?, ?, ?, NULL, 'Open')`)
        .run(number, robot.id, String(fault_code).trim().toUpperCase(), STAGES.FAULT, STAGE_OWNER[STAGES.FAULT], `${robot.name} reported fault ${fault_code}`,
          new Date(created.getTime() + SLA_MINUTES * 60000).toISOString(), demo_scenario, external_system, external_ref, external_number, created.toISOString());
      const incId = Number(lastInsertRowid);
      this.db.prepare("UPDATE robots SET status = 'Fault', current_incident_id = ? WHERE id = ?").run(incId, robot.id);
      return incId;
    });
    this.log(id, STAGE_OWNER[STAGES.FAULT], 'stage', `${STAGES.FAULT}: ${robot.name} reported fault ${fault_code}${reported_by ? ` (via ${reported_by})` : ''}`);
    this.emit(id, 'incident.created');
    this.schedule(id, () => this.runTriage(id));
    return { incident: this.get(id), created: true };
  }

  // ---------- Agent 1: Triage ----------
  runTriage(id) {
    const inc = this.get(id);
    const robot = this.db.prepare('SELECT * FROM robots WHERE id = ?').get(inc.robot_id);
    const mapping = this.db.prepare('SELECT * FROM fault_codes WHERE code = ? AND (robot_model = ? OR robot_model IS NULL) ORDER BY robot_model IS NULL LIMIT 1').get(inc.fault_code, robot.model);
    this.log(id, 'Triage Agent', 'tool', `fault_codes.lookup(${inc.fault_code}, ${robot.model})`, mapping || { result: 'no mapping' });
    if (!mapping) {
      this.setStage(id, STAGES.FAILED, `Unknown fault code ${inc.fault_code} for ${robot.model}. Needs manual triage.`);
      return;
    }
    this.setStage(id, STAGES.TRIAGE, `Identified ${mapping.component}, part ${mapping.part_number}. Requested replacement from Spare Parts Agent.`, {
      failed_component: mapping.component,
      failed_part_number: mapping.part_number,
    });
    this.log(id, 'Triage Agent', 'decision', 'Handoff to Spare Parts Agent', { robot: robot.name, fault_code: inc.fault_code, failed_component: mapping.component, required_part: mapping.part_number, triage_status: 'Complete' });
    this.schedule(id, () => this.runInventorySearch(id));
  }

  // ---------- Agent 2: Spare Parts ----------
  runInventorySearch(id) {
    const inc = this.get(id);
    const part = this.db.prepare('SELECT * FROM parts WHERE part_number = ?').get(inc.failed_part_number);
    const free = availability(part);
    this.log(id, 'Spare Parts Agent', 'tool', `inventory.lookup(${inc.failed_part_number})`, part ? { status: part.status, on_hand: part.qty_on_hand, reserved: part.qty_reserved, available: free, bin: part.bin } : { result: 'not in inventory' });
    if (part && free > 0 && part.status !== 'Obsolete') {
      const robot = this.db.prepare('SELECT * FROM robots WHERE id = ?').get(inc.robot_id);
      const rec = recommend(this.db, { part_number: part.part_number, robot_model: robot.model, component: inc.failed_component });
      this.setStage(id, STAGES.INVENTORY, `Exact match ${part.part_number}: ${free} on hand in bin ${part.bin}.`, {
        match_type: MATCH.EXACT, selected_part_number: part.part_number, approval_status: 'Not Required', recommendation_json: JSON.stringify(rec),
      });
      this.schedule(id, () => this.reserveAndContinue(id));
    } else {
      const why = !part ? 'not in inventory' : `${part.status}, ${free} available`;
      this.setStage(id, STAGES.INVENTORY, `No exact match for ${inc.failed_part_number} (${why}). Searching maintenance knowledge.`);
      this.schedule(id, () => this.runKnowledgeSearch(id));
    }
  }

  async runKnowledgeSearch(id, { excludeParts = [] } = {}) {
    const inc = this.get(id);
    const robot = this.db.prepare('SELECT * FROM robots WHERE id = ?').get(inc.robot_id);
    const rec = recommend(this.db, { part_number: inc.failed_part_number, robot_model: robot.model, component: inc.failed_component });
    applyRejections(rec, excludeParts);
    const llmText = rec.recommended ? await explainRecommendation(rec) : null;
    if (llmText) { rec.rationale_llm = llmText; rec.method = 'retrieval + LLM explanation'; }
    this.log(id, 'Spare Parts Agent', 'tool', `knowledge.search(${inc.failed_part_number})`, { searched: rec.sources_searched, relevant: rec.relevant_sources.map((s) => s.ref) });

    if (!rec.recommended) {
      this.setStage(id, STAGES.FAILED, `No in-stock substitute with supporting evidence for ${inc.failed_part_number}. Escalate to procurement.`, { recommendation_json: JSON.stringify(rec), approval_status: 'Not Available' });
      return;
    }
    const c = rec.recommended;
    this.log(id, 'Spare Parts Agent', 'decision', `Recommend ${c.part_number} (${c.match_type})`, { sources: c.evidence.map((e) => e.ref), approval_required: true });
    this.setStage(id, STAGES.KNOWLEDGE, `Found ${c.part_number} (${c.match_type}) in ${c.supporting_sources} maintenance records.`, {
      recommendation_json: JSON.stringify(rec), match_type: c.match_type,
    });
    this.setStage(id, STAGES.APPROVAL, `Waiting on Logistics Parts Coordinator to approve ${c.part_number}.`, { approval_status: 'Pending' });
    this.log(id, 'Spare Parts Agent', 'notification', `Coordinator alerted: ${robot.name} needs a part with no exact match (${inc.failed_part_number}).`);
    this.db.prepare('INSERT INTO chat_messages(incident_id, role, author, text, data_json, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, 'agent', 'Spare Parts Agent', rec.rationale_llm || rec.rationale, JSON.stringify({ candidates: rec.candidates.map(cardOf), excluded: rec.excluded.map(cardOf) }), now());
    this.emit(id, 'incident.approval_requested');
  }

  // ---------- Human in the loop ----------
  approve(id, { part_number, approver = 'Logistics Parts Coordinator', comment = null } = {}) {
    const inc = this.get(id);
    if (inc.stage !== STAGES.APPROVAL || inc.approval_status === 'Approved') throw new HttpError(409, `Incident ${inc.number} is not awaiting approval (stage: ${inc.stage}, approval: ${inc.approval_status})`);
    const rec = JSON.parse(inc.recommendation_json);
    const choice = part_number ? rec.candidates.find((c) => canon(c.part_number) === canon(part_number)) : rec.recommended;
    if (!choice) throw new HttpError(400, `${part_number} is not one of the recommended candidates`);
    if (choice.rejected) throw new HttpError(400, `${choice.part_number} was already rejected`);
    this.log(id, approver, 'human', `Approved ${choice.part_number}${comment ? `: ${comment}` : ''}`);
    this.setStage(id, STAGES.APPROVAL, `${approver} approved ${choice.part_number}. Resuming workflow.`, {
      approval_status: 'Approved', approved_by: approver, approval_comment: comment, selected_part_number: choice.part_number, match_type: choice.match_type,
    });
    this.schedule(id, () => this.reserveAndContinue(id));
    return this.get(id);
  }

  async reject(id, { part_number, approver = 'Logistics Parts Coordinator', comment = null } = {}) {
    const inc = this.get(id);
    if (inc.stage !== STAGES.APPROVAL || inc.approval_status === 'Approved') throw new HttpError(409, `Incident ${inc.number} is not awaiting approval (stage: ${inc.stage}, approval: ${inc.approval_status})`);
    const rec = JSON.parse(inc.recommendation_json);
    const target = part_number || rec.recommended?.part_number;
    const rejected = [...(rec.rejected_parts || []), target];
    this.log(id, approver, 'human', `Rejected ${target}${comment ? `: ${comment}` : ''}`);
    this.db.prepare('UPDATE incidents SET approval_status = ?, approved_by = ?, approval_comment = ? WHERE id = ?').run('Rejected', approver, comment, id);
    // Look for the next candidate, keeping the rejection history.
    const next = recommend(this.db, { part_number: inc.failed_part_number, robot_model: rec.robot_model, component: inc.failed_component });
    applyRejections(next, rejected);
    if (!next.recommended) {
      this.setStage(id, STAGES.FAILED, `${approver} rejected ${target}; no other in-stock candidate has supporting evidence. Escalate to procurement.`, { recommendation_json: JSON.stringify(next) });
      return this.get(id);
    }
    this.setStage(id, STAGES.APPROVAL, `${approver} rejected ${target}. Next candidate: ${next.recommended.part_number} (${next.recommended.match_type}).`, {
      recommendation_json: JSON.stringify(next), approval_status: 'Pending', match_type: next.recommended.match_type,
    });
    this.db.prepare('INSERT INTO chat_messages(incident_id, role, author, text, data_json, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, 'agent', 'Spare Parts Agent', `Understood, ${target} is out. ${next.rationale}`, JSON.stringify({ candidates: next.candidates.map(cardOf) }), now());
    return this.get(id);
  }

  // ---------- Agent 3: Resolution / Dispatcher ----------
  reserveAndContinue(id) {
    const inc = this.get(id);
    const part = this.db.prepare('SELECT * FROM parts WHERE part_number = ?').get(inc.selected_part_number);
    if (!part) throw new Error(`Selected part ${inc.selected_part_number} not found`);
    const reservation = tx(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM reservations WHERE incident_id = ?').get(id);
      if (existing) return { ...existing, duplicate: true };
      const res = this.db.prepare('UPDATE parts SET qty_reserved = qty_reserved + 1 WHERE id = ? AND qty_on_hand - qty_reserved >= 1').run(part.id);
      if (res.changes === 0) return null;
      const { lastInsertRowid } = this.db.prepare('INSERT INTO reservations(incident_id, part_id, qty, status, created_at) VALUES (?,?,1,?,?)').run(id, part.id, 'Reserved', now());
      return { id: Number(lastInsertRowid) };
    });
    this.log(id, 'Resolution Agent', 'tool', `inventory.reserve(${part.part_number}, 1)`, reservation || { result: 'no free stock' });
    if (!reservation) {
      this.setStage(id, STAGES.FAILED, `${part.part_number} has no free stock left to reserve.`);
      return;
    }
    this.setStage(id, STAGES.RESERVED, `Reserved 1 x ${part.part_number} from bin ${part.bin}.`);
    this.schedule(id, () => this.dispatch(id));
  }

  dispatch(id) {
    const inc = this.get(id);
    const robot = this.db.prepare('SELECT * FROM robots WHERE id = ?').get(inc.robot_id);
    const part = this.db.prepare('SELECT * FROM parts WHERE part_number = ?').get(inc.selected_part_number);
    const rec = inc.recommendation_json ? JSON.parse(inc.recommendation_json) : null;
    const chosen = rec?.recommended?.part_number === part.part_number ? rec.recommended : rec?.candidates?.find((c) => c.part_number === part.part_number);
    const notes = (chosen?.install_instructions || rec?.install_instructions || []).map((n) => `${n.text} [${n.ref}]`);
    const instructions = notes.length ? notes.join('\n') : 'Standard replacement procedure.';
    const component = (inc.failed_component || '').toLowerCase();
    const techs = this.db.prepare('SELECT * FROM technicians').all();
    const tech = techs.find((t) => t.skills.split(',').some((s) => component.includes(s))) || techs[0];

    const wo = tx(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM work_orders WHERE incident_id = ?').get(id);
      if (existing) return existing;
      const number = nextNumber(this.db, 'work_order', 'SSWO', 2001);
      this.db.prepare('INSERT INTO work_orders(number, incident_id, robot_id, technician_id, part_id, bin, location, install_instructions, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(number, id, robot.id, tech?.id ?? null, part.id, part.bin, robot.location, instructions, 'Dispatched', now());
      this.db.prepare('UPDATE incidents SET technician_id = ? WHERE id = ?').run(tech?.id ?? null, id);
      return this.db.prepare('SELECT * FROM work_orders WHERE incident_id = ?').get(id);
    });
    this.log(id, 'Resolution Agent', 'tool', `work_order.create(${wo.number})`, { technician: tech?.name, part: part.part_number, bin: part.bin, location: robot.location });
    this.setStage(id, STAGES.DISPATCHED, `${tech?.name ?? 'Technician'} dispatched with ${part.part_number} (bin ${part.bin}) to ${robot.location}. Work order ${wo.number}.`);
    this.schedule(id, () => this.startRepair(id));
  }

  startRepair(id) {
    const inc = this.get(id);
    this.db.prepare("UPDATE robots SET status = 'Under Repair' WHERE id = ?").run(inc.robot_id);
    this.db.prepare("UPDATE work_orders SET status = 'In Progress' WHERE incident_id = ?").run(id);
    this.setStage(id, STAGES.REPAIR, 'Technician on site. Waiting for repair confirmation.', { repair_status: 'In Progress' });
    for (const hook of this.hooks.afterRepairStarted) hook(this.get(id));
  }

  confirmRepair(id, { success = true, notes = null, confirmed_by = 'Maintenance Technician' } = {}) {
    const inc = this.get(id);
    if (inc.stage === STAGES.RESOLVED) return inc; // idempotent
    if (inc.stage !== STAGES.REPAIR) throw new HttpError(409, `Incident ${inc.number} is not in repair (stage: ${inc.stage})`);
    const resolvedAt = new Date();
    const slaMet = resolvedAt <= new Date(inc.sla_due_at);
    tx(this.db, () => {
      const r = this.db.prepare("SELECT * FROM reservations WHERE incident_id = ? AND status = 'Reserved'").get(id);
      if (r) {
        if (success) {
          this.db.prepare('UPDATE parts SET qty_on_hand = qty_on_hand - ?, qty_reserved = qty_reserved - ? WHERE id = ?').run(r.qty, r.qty, r.part_id);
          this.db.prepare("UPDATE reservations SET status = 'Consumed' WHERE id = ?").run(r.id);
        }
      }
      this.db.prepare('UPDATE work_orders SET status = ?, repair_confirmation = ?, completed_at = ? WHERE incident_id = ?')
        .run(success ? 'Completed' : 'Cancelled', `${success ? 'Repair successful' : 'Repair failed'} (${confirmed_by})${notes ? `: ${notes}` : ''}`, resolvedAt.toISOString(), id);
      if (success) {
        this.db.prepare("UPDATE robots SET status = 'Restored', last_service_date = ? WHERE id = ?").run(resolvedAt.toISOString().slice(0, 10), inc.robot_id);
      }
    });
    this.log(id, confirmed_by, 'human', success ? 'Repair confirmed successful' : 'Repair failed', { notes });
    if (success) {
      const part = inc.selected_part_number;
      const label = inc.match_type === MATCH.EXACT ? 'exact part' : `${inc.match_type.toLowerCase()} found in maintenance knowledge`;
      this.setStage(id, STAGES.RESOLVED, `Right part dispatched: ${part} (${label}). First-time fix: Yes. SLA: ${slaMet ? 'Met' : 'Breached'}.`, {
        repair_status: 'Completed', first_time_fix: 1, sla_status: slaMet ? 'Met' : 'Breached', resolved_at: resolvedAt.toISOString(),
        resolution_notes: `Replaced ${inc.failed_part_number} with ${part} (${inc.match_type}).${notes ? ` ${notes}` : ''}`,
      });
    } else {
      this.setStage(id, STAGES.FAILED, `Repair with ${inc.selected_part_number} failed. Needs attention.`, { repair_status: 'Failed', first_time_fix: 0 });
    }
    return this.get(id);
  }

  // ---------- Coordinator chat with the Spare Parts Agent ----------
  async chat(id, { text, author = 'Logistics Parts Coordinator' }) {
    if (!text || !String(text).trim()) throw new HttpError(400, 'text is required');
    const inc = this.get(id);
    this.db.prepare('INSERT INTO chat_messages(incident_id, role, author, text, created_at) VALUES (?,?,?,?,?)').run(id, 'user', author, text, now());
    const robot = this.db.prepare('SELECT * FROM robots WHERE id = ?').get(inc.robot_id);
    const mentioned = String(text).match(/\b[A-Z]{1,4}[-\s]?\d{2,4}(?:[-\s]?[A-Z]\d{0,2})?\b/i)?.[0];
    const prior = inc.recommendation_json ? JSON.parse(inc.recommendation_json) : null;
    const isCandidate = mentioned && prior?.candidates?.concat(prior.excluded || []).find((c) => canon(c.part_number) === canon(mentioned));
    const partToSearch = !mentioned || isCandidate ? inc.failed_part_number : mentioned;
    const rec = recommend(this.db, { part_number: partToSearch, robot_model: robot.model, component: partToSearch === inc.failed_part_number ? inc.failed_component : null });
    applyRejections(rec, prior?.rejected_parts || []);
    this.log(id, 'Spare Parts Agent', 'tool', `knowledge.search(${partToSearch})`, { question: text, relevant: rec.relevant_sources.map((s) => s.ref) });

    let answer = await answerChat(text, rec);
    if (!answer) answer = deterministicAnswer(text, rec, isCandidate ? isCandidate.part_number : null);
    const data = { candidates: rec.candidates.map(cardOf), excluded: rec.excluded.map(cardOf), method: answer && rec.method };
    this.db.prepare('INSERT INTO chat_messages(incident_id, role, author, text, data_json, created_at) VALUES (?,?,?,?,?,?)').run(id, 'agent', 'Spare Parts Agent', answer, JSON.stringify(data), now());
    return this.chatHistory(id);
  }

  chatHistory(id) {
    return this.db.prepare('SELECT * FROM chat_messages WHERE incident_id = ? ORDER BY id').all(id)
      .map((m) => ({ ...m, data: m.data_json ? JSON.parse(m.data_json) : null, data_json: undefined }));
  }

  // Resume in-flight workflows after a restart.
  resumeAll() {
    const open = this.db.prepare('SELECT id, stage FROM incidents WHERE stage NOT IN (?,?,?,?)').all(STAGES.RESOLVED, STAGES.FAILED, STAGES.APPROVAL, STAGES.REPAIR);
    const next = {
      [STAGES.FAULT]: (id) => this.runTriage(id),
      [STAGES.TRIAGE]: (id) => this.runInventorySearch(id),
      [STAGES.INVENTORY]: (id) => (this.get(id).selected_part_number ? this.reserveAndContinue(id) : this.runKnowledgeSearch(id)),
      [STAGES.KNOWLEDGE]: (id) => this.runKnowledgeSearch(id),
      [STAGES.RESERVED]: (id) => this.dispatch(id),
      [STAGES.DISPATCHED]: (id) => this.startRepair(id),
    };
    for (const { id, stage } of open) if (next[stage]) this.schedule(id, () => next[stage](id));
    // Approved but not yet reserved.
    const approved = this.db.prepare("SELECT id FROM incidents WHERE stage = ? AND approval_status = 'Approved'").all(STAGES.APPROVAL);
    for (const { id } of approved) this.schedule(id, () => this.reserveAndContinue(id));
    return open.length + approved.length;
  }

  stagePath(inc) {
    const knowledge = (inc.match_type && inc.match_type !== MATCH.EXACT) || inc.demo_scenario === 'hitl'
      || [STAGES.KNOWLEDGE, STAGES.APPROVAL].includes(inc.stage);
    const path = knowledge ? KNOWLEDGE_PATH : EXACT_PATH;
    const idx = path.indexOf(inc.stage);
    return path.map((stage, i) => ({
      stage,
      owner: STAGE_OWNER[stage],
      status: inc.stage === STAGES.FAILED ? (i === 0 ? 'done' : 'pending')
        : inc.stage === STAGES.RESOLVED ? 'done'
          : i < idx ? 'done'
            : i === idx ? (stage === STAGES.APPROVAL ? 'waiting' : stage === STAGES.REPAIR ? 'in_progress' : 'done')
              : i === idx + 1 && inc.stage !== STAGES.APPROVAL && inc.stage !== STAGES.REPAIR ? 'in_progress' : 'pending',
    }));
  }
}

function applyRejections(rec, rejected) {
  if (!rejected?.length) return rec;
  const set = new Set(rejected.map(canon));
  rec.rejected_parts = rejected;
  for (const c of rec.candidates) if (set.has(canon(c.part_number))) c.rejected = true;
  const best = rec.candidates.find((c) => !c.rejected && c.available > 0);
  rec.recommended = best || null;
  rec.match_type = best ? best.match_type : MATCH.INSUFFICIENT;
  rec.install_instructions = best ? best.install_instructions : [];
  if (best) {
    rec.rationale = `Excluding rejected ${rejected.join(', ')}. Next best: ${best.part_number} (${best.match_type}), ${best.available} available in bin ${best.bin}. Evidence: ${best.evidence.filter((e) => e.relation !== 'contradicts').map((e) => `${e.ref}: "${e.excerpt}"`).join(' ')}${best.warnings.length ? ` Check: ${best.warnings.join(' ')}` : ''}`;
  } else {
    rec.rationale = `Excluding rejected ${rejected.join(', ')}, no in-stock candidate with supporting evidence remains.`;
  }
  return rec;
}

export function cardOf(c) {
  return {
    part_number: c.part_number, match_type: c.match_type, available: c.available, bin: c.bin, status: c.status,
    compatibility: c.compatibility, warnings: c.warnings, rejected: !!c.rejected, reason: c.reason,
    evidence: (c.evidence || []).map((e) => ({ ref: e.ref, source_label: e.source_label, relation: e.relation, excerpt: e.excerpt, date: e.date })),
    install_instructions: c.install_instructions,
  };
}

function deterministicAnswer(text, rec, focusPart) {
  if (focusPart) {
    const c = rec.candidates.concat(rec.excluded).find((x) => x.part_number === focusPart);
    if (c) {
      const ev = c.evidence.map((e) => `${e.ref} (${e.source_label.toLowerCase()}): "${e.excerpt}"`).join(' ');
      return `${c.part_number} is classified as ${c.match_type}${c.reason ? ` (${c.reason})` : ''}. ${c.available} available in bin ${c.bin}. Evidence: ${ev}${c.warnings?.length ? ` Check: ${c.warnings.join(' ')}` : ''}`;
    }
  }
  return rec.rationale;
}
