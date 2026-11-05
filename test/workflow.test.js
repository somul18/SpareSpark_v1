process.env.SPARESPARK_LLM = 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { recommend, MATCH } from '../server/knowledge.js';
import { runScenario, resetDemo } from '../server/demo.js';
import { STAGES } from '../server/workflow.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error('timed out');
}
const fresh = () => createApp({ dbFile: ':memory:', stepMs: 5, repairMs: 10 });

test('exact part in stock is recommended without approval', () => {
  const { db } = fresh();
  const r = recommend(db, { part_number: 'SM-400-J3', robot_model: 'ArcMaster W6' });
  assert.equal(r.match_type, MATCH.EXACT);
  assert.equal(r.recommended.part_number, 'SM-400-J3');
  assert.equal(r.approval_required, false);
});

test('obsolete part: GR-220-W2 is found in maintenance knowledge with real sources', () => {
  const { db } = fresh();
  const r = recommend(db, { part_number: 'GR-220-W', robot_model: 'PX-200' });
  assert.equal(r.recommended.part_number, 'GR-220-W2');
  assert.equal(r.recommended.match_type, MATCH.SUPERSESSION);
  const refs = r.recommended.evidence.map((e) => e.ref);
  for (const ref of ['TN-0042', 'WO-1187', 'KB0010334']) assert.ok(refs.includes(ref), `missing ${ref}`);
  // Every cited ref exists in the knowledge table.
  for (const ref of refs) assert.ok(db.prepare('SELECT 1 FROM knowledge WHERE ref = ?').get(ref), `invented ref ${ref}`);
  assert.ok(r.install_instructions.some((n) => /shim/i.test(n.text)));
  assert.equal(r.approval_required, true);
  // Lower-confidence alternative and a contradicted part.
  assert.equal(r.candidates.find((c) => c.part_number === 'GR-225-W').match_type, MATCH.POTENTIAL);
  assert.ok(r.excluded.some((c) => c.part_number === 'GR-230-W'));
  // Inconsistent terminology is matched.
  const terms = r.relevant_sources.flatMap((s) => s.matched_terms.map((t) => t.toLowerCase()));
  for (const t of ['wrist gearbox', 'gr220w', 'wrist red.']) assert.ok(terms.includes(t), `term ${t} not matched`);
  assert.doesNotMatch(r.rationale, /\d+\s?%/);
});

test('the engine follows the data, not a hardcoded answer', () => {
  const { db } = fresh();
  db.prepare("UPDATE parts SET qty_on_hand = 0 WHERE part_number = 'GR-220-W2'").run();
  const r = recommend(db, { part_number: 'GR-220-W', robot_model: 'PX-200' });
  assert.equal(r.recommended.part_number, 'GR-225-W');
  assert.equal(r.recommended.match_type, MATCH.POTENTIAL);
  db.prepare("UPDATE parts SET qty_on_hand = 0 WHERE part_number = 'GR-225-W'").run();
  const none = recommend(db, { part_number: 'GR-220-W', robot_model: 'PX-200' });
  assert.equal(none.recommended, null);
  assert.equal(none.match_type, MATCH.INSUFFICIENT);
});

test('happy flow: AdamNow resolves with SM-400-J3, FTF and SLA met', async () => {
  const { db, workflow } = fresh();
  const { incident } = runScenario(workflow, 'happy');
  const done = await until(() => { const i = workflow.get(incident.id); return i.stage === STAGES.RESOLVED && i; });
  assert.equal(done.selected_part_number, 'SM-400-J3');
  assert.equal(done.match_type, MATCH.EXACT);
  assert.equal(done.first_time_fix, 1);
  assert.equal(done.sla_status, 'Met');
  assert.equal(db.prepare("SELECT status FROM robots WHERE name = 'AdamNow'").get().status, 'Restored');
  const wo = db.prepare('SELECT * FROM work_orders WHERE incident_id = ?').get(incident.id);
  assert.equal(wo.bin, 'A-14');
  assert.equal(db.prepare("SELECT qty_on_hand, qty_reserved FROM parts WHERE part_number = 'SM-400-J3'").get().qty_on_hand, 1);
});

test('human-in-the-loop flow pauses, resumes after approval, and resolves with GR-220-W2', async () => {
  const { db, workflow } = fresh();
  const { incident } = runScenario(workflow, 'hitl');
  await until(() => workflow.get(incident.id).stage === STAGES.APPROVAL);
  await wait(50);
  assert.equal(workflow.get(incident.id).stage, STAGES.APPROVAL, 'must stay paused');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
  workflow.approve(incident.id, { approver: 'S. Patel' });
  assert.throws(() => workflow.approve(incident.id, {}), /not awaiting approval/);
  const done = await until(() => { const i = workflow.get(incident.id); return i.stage === STAGES.RESOLVED && i; });
  assert.equal(done.selected_part_number, 'GR-220-W2');
  assert.equal(done.first_time_fix, 1);
  const wo = db.prepare('SELECT * FROM work_orders WHERE incident_id = ?').get(incident.id);
  assert.equal(wo.bin, 'B-12');
  assert.match(wo.install_instructions, /shim/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations WHERE incident_id = ?').get(incident.id).n, 1);
  assert.equal(db.prepare("SELECT status FROM robots WHERE name = 'EveThen'").get().status, 'Restored');
});

test('rejecting the top recommendation offers the next candidate, then fails gracefully', async () => {
  const { workflow } = fresh();
  const { incident } = runScenario(workflow, 'hitl');
  await until(() => workflow.get(incident.id).stage === STAGES.APPROVAL);
  await workflow.reject(incident.id, { comment: 'want OEM only' });
  let inc = workflow.get(incident.id);
  assert.equal(inc.stage, STAGES.APPROVAL);
  assert.equal(JSON.parse(inc.recommendation_json).recommended.part_number, 'GR-225-W');
  await workflow.reject(incident.id, {});
  inc = workflow.get(incident.id);
  assert.equal(inc.stage, STAGES.FAILED);
});

test('a robot cannot get a duplicate open incident, and reset restores the seed', async () => {
  const { db, workflow } = fresh();
  runScenario(workflow, 'hitl');
  assert.throws(() => runScenario(workflow, 'hitl'), /already has open incident/);
  resetDemo(workflow);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM incidents').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM robots WHERE status = 'Operational'").get().n, 4);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM knowledge').get().n >= 10);
});

test('external systems are de-duplicated by external_ref', () => {
  const { workflow } = fresh();
  const a = workflow.createIncident({ robot_name: 'AdamNow', fault_code: 'J3-OVERCURRENT', external_system: 'servicenow', external_ref: 'abc' });
  const b = workflow.createIncident({ robot_name: 'AdamNow', fault_code: 'J3-OVERCURRENT', external_system: 'servicenow', external_ref: 'abc' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.incident.id, b.incident.id);
  workflow.cancelAll();
});

test('LLM answers that cite unknown sources, parts or percentages are rejected', async () => {
  const { isGrounded } = await import('../server/llm.js');
  const { db } = fresh();
  const r = recommend(db, { part_number: 'GR-220-W', robot_model: 'PX-200' });
  assert.equal(isGrounded('Use GR-220-W2 per KB0010334 and WO-1187; add 2 shims.', r), true);
  assert.equal(isGrounded('Use GR-220-W2 per WO-9999.', r), false);
  assert.equal(isGrounded('GR-999-X also fits.', r), false);
  assert.equal(isGrounded('GR-220-W2 is a 95% match.', r), false);
});

test('procurement flow: stockout -> PO approval -> vendor ships -> receive updates inventory -> resolved', async () => {
  const { db, workflow } = createApp({ dbFile: ':memory:', stepMs: 5, repairMs: 10, vendorMs: 10 });
  const { incident } = runScenario(workflow, 'procurement');
  await until(() => workflow.get(incident.id).stage === STAGES.PO_APPROVAL);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE incident_id = ?').get(incident.id);
  assert.equal(po.status, 'Pending Approval');
  assert.equal(po.qty, 2);
  await wait(50);
  assert.equal(workflow.get(incident.id).stage, STAGES.PO_APPROVAL, 'waits for the human');
  assert.throws(() => workflow.receivePo(po.id, {}), /only ordered or shipped/);
  workflow.approvePo(po.id, { approver: 'R. Diaz' });
  assert.equal(workflow.get(incident.id).stage, STAGES.DELIVERY);
  await until(() => workflow.getPo(po.id).status === 'Shipped');
  assert.equal(workflow.get(incident.id).stage, STAGES.DELIVERY, 'receiving stays a human step');
  const before = db.prepare("SELECT qty_on_hand FROM parts WHERE part_number = 'SM-400-J3'").get().qty_on_hand;
  workflow.receivePo(po.id, { received_by: 'Dock 2' });
  const after = db.prepare("SELECT qty_on_hand, qty_reserved FROM parts WHERE part_number = 'SM-400-J3'").get();
  assert.equal(after.qty_on_hand, before + 2);
  assert.equal(after.qty_reserved, 1, 'reserved right after receipt');
  const done = await until(() => { const i = workflow.get(incident.id); return i.stage === STAGES.RESOLVED && i; });
  assert.equal(done.selected_part_number, 'SM-400-J3');
  assert.match(done.latest_action, /procured on PO/);
  assert.match(db.prepare('SELECT install_instructions FROM work_orders WHERE incident_id = ?').get(incident.id).install_instructions, /encoder calibration/);
  const m = (await import('../server/app.js')).metrics(db);
  assert.equal(m.procurement.received, 1);
  assert.equal(m.procurement.spend, 2 * 1850);
  assert.equal(m.procurement.repairs_unblocked_by_procurement, 1);
});

test('repeated happy flows run out of stock and hand over to procurement instead of failing', async () => {
  const { workflow } = fresh();
  for (let n = 0; n < 2; n++) {
    const { incident } = runScenario(workflow, 'happy');
    await until(() => workflow.get(incident.id).stage === STAGES.RESOLVED);
  }
  const { incident } = runScenario(workflow, 'happy');
  await until(() => workflow.get(incident.id).stage === STAGES.PO_APPROVAL);
});

test('obsolete part with no stock anywhere orders the documented successor; rejected PO needs attention', async () => {
  const { db, workflow } = fresh();
  db.prepare("UPDATE parts SET qty_on_hand = 0 WHERE part_number IN ('GR-220-W2','GR-225-W')").run();
  const { incident } = runScenario(workflow, 'hitl');
  await until(() => workflow.get(incident.id).stage === STAGES.PO_APPROVAL);
  const po = db.prepare('SELECT po.*, p.part_number FROM purchase_orders po JOIN parts p ON p.id = po.part_id WHERE incident_id = ?').get(incident.id);
  assert.equal(po.part_number, 'GR-220-W2');
  workflow.rejectPo(po.id, { comment: 'budget' });
  assert.equal(workflow.get(incident.id).stage, STAGES.FAILED);
});
