// One week of plant history: incidents, work orders, purchase orders and stock movements
// from the 7 days before the database was created. Every row is marked is_historical = 1,
// so "Reset Demo" keeps it and the dashboard reports history plus new activity together.
//
// The week tells a story: early in the week, faults are handled manually (planner picks a
// part, sometimes the wrong one), later ones go through SpareSpark's agents. That gives the
// dashboard a real AI-assisted vs manual comparison.

import { recommend, MATCH } from './knowledge.js';

const MIN = 60000;

// day = days before today, at = HH:MM (UTC), mins = fault to resolution.
// mode: exact | supersession | procured | po_rejected | manual | manual_wrong
const WEEK = [
  { n: 11001, day: 7, at: '07:12', robot: 'AdamNow', fault: 'J3-OVERCURRENT', mode: 'manual_wrong', mins: 520, wrong: 'SM-380-J3', tech: 'R. Singh',
    why: 'Legacy SM-380-J3 pulled from bin A-11 by mistake; 380 W motor tripped under weld load. Second trip with SM-400-J3.' },
  { n: 11002, day: 7, at: '13:40', robot: 'JillBefore', fault: 'ATOM-CLOG', mode: 'manual', mins: 95, tech: 'A. Chen' },
  { n: 11003, day: 6, at: '02:25', robot: 'EveThen', fault: 'W-GEAR-BACKLASH', mode: 'manual_wrong', mins: 1680, wrong: 'GR-230-W', part: 'GR-220-W2', tech: 'J. Okafor',
    why: 'Night shift found GR-220-W out of stock and tried GR-230-W: wrong bolt pattern, does not fit. Robot down until day shift found the W2 swap in an old tech note.' },
  { n: 11004, day: 6, at: '10:05', robot: 'BobAfter', fault: 'GRIP-VAC-LOW', mode: 'exact', mins: 75, sn: 'INC0010871' },
  { n: 11005, day: 6, at: '15:30', robot: 'AdamNow', fault: 'WIRE-FEED-SLIP', mode: 'manual', mins: 60, tech: 'M. Ortiz' },
  { n: 11006, day: 5, at: '08:50', robot: 'EveThen', fault: 'VAC-CUP-WEAR', mode: 'exact', mins: 40 },
  { n: 11007, day: 5, at: '11:20', robot: 'JillBefore', fault: 'HOSE-PRESSURE', mode: 'manual', mins: 150, tech: 'A. Chen' },
  { n: 11008, day: 5, at: '16:45', robot: 'BobAfter', fault: 'J1-ENCODER-ERR', mode: 'manual_wrong', mins: 460, tech: 'R. Singh',
    why: 'Encoder replaced without the zero-point calibration; axis 1 drifted after restart. Second visit to recalibrate.' },
  { n: 11009, day: 4, at: '06:30', robot: 'AdamNow', fault: 'J3-OVERCURRENT', mode: 'exact', mins: 120, sn: 'INC0010902' },
  { n: 11010, day: 4, at: '09:10', robot: 'EveThen', fault: 'W-GEAR-BACKLASH', mode: 'supersession', mins: 160 },
  { n: 11011, day: 4, at: '14:00', robot: 'JillBefore', fault: 'ATOM-CLOG', mode: 'exact', mins: 50 },
  { n: 11012, day: 4, at: '21:35', robot: 'BobAfter', fault: 'GRIP-VAC-LOW', mode: 'manual', mins: 130, tech: 'J. Okafor' },
  { n: 11013, day: 3, at: '07:45', robot: 'BobAfter', fault: 'J1-ENCODER-ERR', mode: 'procured', mins: 1380, vendor: 'Northline Industrial', poQty: 2, po: 4003,
    note: 'Expedited delivery requested: robot down at Dock 3.' },
  { n: 11014, day: 3, at: '12:15', robot: 'AdamNow', fault: 'WIRE-FEED-SLIP', mode: 'exact', mins: 45 },
  { n: 11015, day: 3, at: '17:00', robot: 'JillBefore', fault: 'HOSE-PRESSURE', mode: 'manual_wrong', mins: 340, tech: 'A. Chen',
    why: 'First hose pulled was the 6 m variant from the wrong shelf; too short for the C4 boom. Second trip with PH-8-C.' },
  { n: 11016, day: 2, at: '05:50', robot: 'EveThen', fault: 'W-GEAR-BACKLASH', mode: 'supersession', mins: 140, sn: 'INC0010957' },
  { n: 11017, day: 2, at: '10:30', robot: 'AdamNow', fault: 'J3-OVERCURRENT', mode: 'procured', mins: 1260, vendor: 'Apex Robotics Supply', poQty: 2, po: 4005,
    note: 'Both SM-400-J3 units were consumed earlier in the week.' },
  { n: 11018, day: 2, at: '13:20', robot: 'JillBefore', fault: 'ATOM-CLOG', mode: 'exact', mins: 35 },
  { n: 11019, day: 2, at: '19:05', robot: 'BobAfter', fault: 'GRIP-VAC-LOW', mode: 'exact', mins: 70 },
  { n: 11020, day: 1, at: '08:00', robot: 'EveThen', fault: 'VAC-CUP-WEAR', mode: 'manual', mins: 55, tech: 'J. Okafor' },
  { n: 11021, day: 1, at: '09:40', robot: 'AdamNow', fault: 'TORCH-TEMP-HIGH', mode: 'po_rejected', mins: 240, vendor: 'Apex Robotics Supply', poQty: 1, po: 4007,
    note: 'Rejected: budget hold until the quarterly maintenance PO. Cell switched to the backup torch and the incident was closed for engineering follow-up.' },
  { n: 11022, day: 1, at: '14:25', robot: 'JillBefore', fault: 'HOSE-PRESSURE', mode: 'exact', mins: 65 },
  { n: 11023, day: 1, at: '16:50', robot: 'BobAfter', fault: 'J1-ENCODER-ERR', mode: 'exact', mins: 90, sn: 'INC0010988' },
];

// Stock replenishment orders placed during the week (not tied to an incident).
const REPLENISHMENT = [
  { n: 4001, day: 6, at: '09:00', part: 'AN-14-C', qty: 20, receivedAfterH: 52, onTime: true, by: 'K. Ramos' },
  { n: 4002, day: 5, at: '10:30', part: 'VC-30-P', qty: 40, receivedAfterH: 110, onTime: false, by: 'K. Ramos' },
  { n: 4004, day: 3, at: '15:10', part: 'GR-220-W2', qty: 2, receivedAfterH: 46, onTime: true, by: 'K. Ramos' },
  { n: 4006, day: 2, at: '11:45', part: 'WF-12-A', qty: 6, receivedAfterH: 30, onTime: true, by: 'K. Ramos' },
];

const ADJUSTMENTS = [
  { day: 4, at: '18:00', part: 'AN-14-C', qty: -2, note: 'Cycle count: 2 nozzles damaged in storage' },
  { day: 2, at: '18:00', part: 'VP-90-G', qty: 1, note: 'Cycle count: 1 pump found in returns cage' },
];

export const HISTORY_TECHNICIANS = [
  { name: 'R. Singh', skills: 'robotics,encoder,welding', location: 'Plant 1' },
  { name: 'J. Okafor', skills: 'robotics,gearbox,pneumatics', location: 'Plant 1' },
];

export function hasHistory(db) {
  return !!db.prepare('SELECT 1 FROM incidents WHERE is_historical = 1 LIMIT 1').get();
}

export function seedHistory(db, { today = new Date() } = {}) {
  if (hasHistory(db)) return 0;
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const at = (day, hhmm, plusMin = 0) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(midnight - day * 86400000 + (h * 60 + m + plusMin) * MIN).toISOString();
  };
  const T = (iso, plusMin) => new Date(new Date(iso).getTime() + plusMin * MIN).toISOString();
  const SLA_MIN = Number(process.env.SPARESPARK_SLA_MINUTES || 240);

  const robot = (name) => db.prepare('SELECT * FROM robots WHERE name = ?').get(name);
  const part = (pn) => db.prepare('SELECT p.*, v.name AS vendor_name, v.lead_time_days FROM parts p LEFT JOIN vendors v ON v.id = p.vendor_id WHERE part_number = ?').get(pn);
  const tech = (name) => db.prepare('SELECT * FROM technicians WHERE name = ?').get(name);
  const insTech = db.prepare('INSERT INTO technicians(name, skills, location) VALUES (?,?,?)');
  for (const t of HISTORY_TECHNICIANS) if (!tech(t.name)) insTech.run(t.name, t.skills, t.location);
  const vendorId = (name) => db.prepare('SELECT id FROM vendors WHERE name = ?').get(name)?.id ?? null;

  const insInc = db.prepare(`INSERT INTO incidents(number, robot_id, fault_code, failed_component, failed_part_number, stage, stage_owner, latest_action,
      selected_part_number, match_type, recommendation_json, approval_status, approved_by, approval_comment, technician_id, repair_status, first_time_fix,
      sla_status, sla_due_at, resolution_notes, external_system, external_ref, external_number, created_at, resolved_at, is_historical, ai_assisted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`);
  const insWo = db.prepare(`INSERT INTO work_orders(number, incident_id, robot_id, technician_id, part_id, bin, location, install_instructions, status,
      repair_confirmation, created_at, completed_at, is_historical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insRes = db.prepare("INSERT INTO reservations(incident_id, part_id, qty, status, created_at, is_historical) VALUES (?,?,1,'Consumed',?,1)");
  const insEv = db.prepare('INSERT INTO events(incident_id, actor, kind, message, data_json, created_at, is_historical) VALUES (?,?,?,?,?,?,1)');
  const insPo = db.prepare(`INSERT INTO purchase_orders(number, incident_id, part_id, vendor_id, qty, unit_cost, status, reason, requested_by, approved_by,
      approval_comment, tracking_ref, received_qty, received_by, created_at, approved_at, expected_at, shipped_at, received_at, is_historical)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insMov = db.prepare('INSERT INTO inventory_movements(part_id, qty_change, kind, ref, note, created_at, is_historical) VALUES (?,?,?,?,?,?,1)');

  let wo = 1001;
  for (const s of WEEK) {
    const r = robot(s.robot);
    const fc = db.prepare('SELECT * FROM fault_codes WHERE code = ? AND (robot_model = ? OR robot_model IS NULL)').get(s.fault, r.model);
    if (!r || !fc) continue;
    const created = at(s.day, s.at);
    const resolved = T(created, s.mins);
    const slaDue = T(created, SLA_MIN);
    const ai = !s.mode.startsWith('manual');
    const failed = s.mode === 'po_rejected';
    const ftf = failed ? null : s.mode === 'manual_wrong' ? 0 : 1;
    const slaStatus = failed ? 'Breached' : s.mins <= SLA_MIN ? 'Met' : 'Breached';
    let rec = null;
    let selected = s.part || fc.part_number;
    let match = null;
    if (ai) {
      if (s.mode === 'supersession') {
        rec = recommend(db, { part_number: fc.part_number, robot_model: r.model, component: fc.component });
        selected = rec.recommended?.part_number || 'GR-220-W2';
        match = rec.recommended?.match_type || MATCH.SUPERSESSION;
      } else {
        match = MATCH.EXACT;
      }
    }
    const p = part(selected);
    const t = s.tech ? tech(s.tech) : tech(fc.component.match(/servo|gear|reducer/i) ? 'M. Ortiz' : fc.component.match(/encoder/i) ? 'R. Singh' : 'A. Chen');
    const ext = s.sn ? ['servicenow', `sys-${s.sn.toLowerCase()}`, s.sn] : [null, null, null];
    const label = match === MATCH.EXACT ? 'exact part' : match ? `${match.toLowerCase()} found in maintenance knowledge` : 'manual dispatch';
    const latest = failed ? s.note
      : ai ? `Right part dispatched: ${selected} (${label}${s.mode === 'procured' ? `, procured on PO000${s.po}` : ''}). First-time fix: Yes. SLA: ${slaStatus}.`
        : `Manually dispatched by the maintenance planner. First-time fix: ${ftf ? 'Yes' : 'No'}. SLA: ${slaStatus}.`;
    const notes = failed ? s.note
      : s.mode === 'manual_wrong' ? `${s.why} Replaced ${fc.part_number === selected ? selected : `${fc.part_number} with ${selected}`}.`
        : `Replaced ${fc.part_number}${selected !== fc.part_number ? ` with ${selected}` : ''}${match ? ` (${match})` : ' (manual)'}.${s.note ? ` ${s.note}` : ''}`;
    const approval = s.mode === 'supersession' ? ['Approved', 'S. Patel (Logistics)', 'Matches TN-0042 and KB0010334. Add the two shims.'] : ai ? ['Not Required', null, null] : [null, null, null];

    const { lastInsertRowid } = insInc.run(`SSI00${s.n}`, r.id, s.fault, fc.component, fc.part_number,
      failed ? 'Failed / Needs Attention' : 'Resolved', failed ? 'Logistics Parts Coordinator' : ai ? 'Resolution Agent' : 'Maintenance Planner', latest,
      failed ? null : selected, match, rec ? JSON.stringify(rec) : null, approval[0], approval[1], approval[2], failed ? null : t?.id ?? null,
      failed ? 'Not Started' : 'Completed', ftf, slaStatus, slaDue, notes, ext[0], ext[1], ext[2], created, failed ? null : resolved, ai ? 1 : 0);
    const id = Number(lastInsertRowid);

    // Event log, so the workflow popup and activity log read like the real thing.
    const ev = (plus, actor, kind, msg, data = null) => insEv.run(id, actor, kind, msg, data ? JSON.stringify(data) : null, T(created, plus));
    const src = s.sn ? ` (via ServiceNow ${s.sn})` : '';
    if (ai) {
      ev(0, 'Robot (self-report)', 'stage', `Fault Detected: ${s.robot} reported fault ${s.fault}${src}`);
      ev(1, 'Triage Agent', 'stage', `Triage: Identified ${fc.component}, part ${fc.part_number}. Requested replacement from Spare Parts Agent.`);
      const stockAtTime = ['procured', 'po_rejected'].includes(s.mode) ? 0 : s.mode === 'supersession' ? 0 : Math.max(1, p?.qty_on_hand || 1);
      ev(2, 'Spare Parts Agent', 'tool', `inventory.lookup(${fc.part_number})`, { status: s.mode === 'supersession' ? 'Obsolete' : 'Active', available: stockAtTime, bin: part(fc.part_number)?.bin });
      ev(2, 'Spare Parts Agent', 'stage', stockAtTime ? `Inventory Search: Exact match ${fc.part_number}, ${stockAtTime} available in bin ${part(fc.part_number)?.bin}.`
        : `Inventory Search: ${fc.part_number} has no free stock. Searching maintenance knowledge.`);
      if (s.mode === 'supersession') {
        ev(3, 'Spare Parts Agent', 'stage', `Knowledge Search: ${fc.part_number} is obsolete with 0 on hand. Searched maintenance knowledge and recommends ${selected} (${match}).`);
        ev(4, 'Spare Parts Agent', 'stage', `Awaiting Human Approval: Recommended ${selected}. Waiting for the Logistics Parts Coordinator.`);
        ev(22, 'S. Patel (Logistics)', 'human', `Approved ${selected}`, { comment: approval[2] });
      }
      let tReady = s.mode === 'supersession' ? 23 : 3;
      if (s.mode === 'procured' || s.mode === 'po_rejected') {
        const pp = part(fc.part_number);
        const poCreated = T(created, 3);
        const approvedAt = T(created, 25);
        const shippedAt = T(created, Math.round(s.mins * 0.55));
        const receivedAt = T(created, s.mins - 70);
        const expected = T(created, s.mins - 30);
        ev(3, 'Spare Parts Agent', 'stage', `Knowledge Search: ${fc.part_number} has no free stock and no documented substitute in stock.`);
        ev(4, 'Procurement Agent', 'tool', `purchase_order.create(PO000${s.po})`, { part: fc.part_number, qty: s.poQty, vendor: s.vendor });
        ev(4, 'Procurement Agent', 'stage', `Procurement Requested: Drafted PO000${s.po} for ${s.poQty} x ${fc.part_number} from ${s.vendor}.`);
        ev(5, 'Procurement Coordinator', 'stage', `Awaiting PO Approval: PO000${s.po} waiting for approval.`);
        if (s.mode === 'po_rejected') {
          insPo.run(`PO000${s.po}`, id, pp.id, vendorId(s.vendor), s.poQty, pp.unit_cost || 0, 'Rejected', `Robot down: ${s.robot} needs ${fc.part_number}; none in stock.`,
            'Procurement Agent', 'L. Novak (Procurement)', s.note.split('.')[0] + '.', null, null, null, poCreated, approvedAt, null, null, null);
          ev(25, 'L. Novak (Procurement)', 'human', `Rejected PO000${s.po}`, { comment: s.note.split('.')[0] });
          ev(26, 'Logistics Parts Coordinator', 'stage', `Failed / Needs Attention: ${s.note}`);
          continue;
        }
        insPo.run(`PO000${s.po}`, id, pp.id, vendorId(s.vendor), s.poQty, pp.unit_cost || 0, 'Received', `Robot down: ${s.robot} needs ${fc.part_number}; none in stock. ${s.note}`,
          'Procurement Agent', 'L. Novak (Procurement)', 'Approved, expedite.', `TRK-${s.po}-${s.n}`, s.poQty, 'Dock 2 Receiving', poCreated, approvedAt, expected, shippedAt, receivedAt);
        insMov.run(pp.id, s.poQty, 'Receipt', `PO000${s.po}`, `Received from ${s.vendor}`, receivedAt);
        ev(25, 'L. Novak (Procurement)', 'human', `Approved PO000${s.po}`);
        ev(26, 'Vendor', 'stage', `Awaiting Delivery: ${s.vendor} confirmed PO000${s.po}, expedited.`);
        ev(Math.round(s.mins * 0.55), s.vendor, 'tool', `purchase_order.shipped(PO000${s.po})`, { tracking_ref: `TRK-${s.po}-${s.n}` });
        ev(s.mins - 70, 'Dock 2 Receiving', 'human', `Received ${s.poQty} x ${fc.part_number} on PO000${s.po}`);
        ev(s.mins - 70, 'Warehouse Receiving', 'stage', `Parts Received: ${s.poQty} x ${fc.part_number} received into bin ${pp.bin}. Resuming repair.`);
        tReady = s.mins - 69;
      }
      ev(tReady, 'Resolution Agent', 'tool', `inventory.reserve(${selected}, 1)`, { bin: p?.bin });
      ev(tReady, 'Resolution Agent', 'stage', `Part Reserved: Reserved 1 x ${selected} from bin ${p?.bin}.`);
      ev(tReady + 1, 'Resolution Agent', 'stage', `Technician Dispatched: ${t?.name} dispatched with ${selected} (bin ${p?.bin}) to ${r.location}. Work order SSWO000${wo}.`);
      ev(tReady + 20, 'Maintenance Technician', 'stage', 'Repair in Progress: Technician on site.');
      ev(s.mins - 1, t?.name || 'Maintenance Technician', 'human', 'Repair confirmed successful');
      ev(s.mins, 'Resolution Agent', 'stage', `Resolved: ${latest}`);
    } else {
      ev(0, s.sn ? 'ServiceNow' : 'Shift Supervisor', 'stage', `Fault Detected: ${s.robot} fault ${s.fault}${s.sn ? src : ' reported by phone to the maintenance desk'}`);
      ev(12, 'Maintenance Planner', 'stage', `Manual Parts Pick: Assigned ${t?.name} and picked ${s.wrong || selected} from stores without a parts check.`);
      ev(20, t?.name, 'stage', `Repair in Progress: ${t?.name} on site with ${s.wrong || selected}.`);
      if (s.mode === 'manual_wrong') {
        ev(Math.round(s.mins * 0.4), t?.name, 'error', s.why);
        ev(Math.round(s.mins * 0.5), 'Maintenance Planner', 'human', `Second trip: ${t?.name} sent back with ${selected}`);
      }
      ev(s.mins, 'Maintenance Planner', 'stage', `Resolved: ${s.robot} back in production. ${ftf ? 'Fixed on the first visit.' : 'Needed a second visit.'}`);
    }

    // Work order, consumed reservation and stock issue.
    const install = ai ? (rec?.install_instructions?.map((x) => `${x.text} [${x.ref}]`).join('\n') || p?.install_notes || 'Standard replacement procedure.')
      : s.mode === 'manual_wrong' ? `Planner note: replace ${fc.component.toLowerCase()}. ${s.why}` : `Planner note: replace ${fc.component.toLowerCase()}.`;
    const woCreated = ai ? T(created, s.mode === 'procured' ? s.mins - 68 : s.mode === 'supersession' ? 24 : 4) : T(created, 12);
    insWo.run(`SSWO000${wo}`, id, r.id, t?.id ?? null, p.id, p.bin, r.location, install, 'Completed',
      `Repair successful (${t?.name})${s.mode === 'manual_wrong' ? ' after a second visit' : ''}`, woCreated, resolved);
    wo += 1;
    insRes.run(id, p.id, woCreated);
    insMov.run(p.id, -1, 'Issue', `SSWO000${wo - 1}`, `Issued for ${`SSI00${s.n}`} (${s.robot})`, woCreated);
    if (s.mode === 'manual_wrong' && s.wrong) {
      const wp = part(s.wrong);
      if (wp) {
        insMov.run(wp.id, -1, 'Issue', `SSWO000${wo - 1}`, `Wrong part issued for SSI00${s.n}`, T(created, 12));
        insMov.run(wp.id, 1, 'Return', `SSWO000${wo - 1}`, 'Returned to stores: did not fit', T(created, Math.round(s.mins * 0.45)));
      }
    }
  }

  for (const o of REPLENISHMENT) {
    const p = part(o.part);
    if (!p) continue;
    const created = at(o.day, o.at);
    const lead = (p.lead_time_days || 5) * 24;
    const received = T(created, o.receivedAfterH * 60);
    const expected = T(created, (o.onTime ? Math.max(lead, o.receivedAfterH + 6) : Math.min(lead, o.receivedAfterH - 30)) * 60);
    insPo.run(`PO000${o.n}`, null, p.id, p.vendor_id, o.qty, p.unit_cost || 0, 'Received', `Replenish ${o.part}: stock below reorder point after this week's repairs.`,
      o.by, 'L. Novak (Procurement)', null, `TRK-${o.n}`, o.qty, 'Dock 2 Receiving', created, T(created, 40), expected, T(created, o.receivedAfterH * 30), received);
    insMov.run(p.id, o.qty, 'Receipt', `PO000${o.n}`, `Received from ${p.vendor_name}`, received);
  }
  for (const a of ADJUSTMENTS) {
    const p = part(a.part);
    if (p) insMov.run(p.id, a.qty, 'Adjustment', 'Cycle count', a.note, at(a.day, a.at));
  }
  return WEEK.length;
}
