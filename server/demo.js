// Demo-only simulation, kept apart from the real workflow.
// It creates the two scripted faults and auto-confirms repairs for demo incidents.
// Disable with SPARESPARK_DEMO=off; real incidents never get auto-confirmed.

import { seedOperational } from './seed.js';
import { tx } from './db.js';

export const SCENARIOS = {
  happy: { robot_name: 'AdamNow', fault_code: 'J3-OVERCURRENT' },
  hitl: { robot_name: 'EveThen', fault_code: 'W-GEAR-BACKLASH' },
  // Stockout: AdamNow's servo is gone from stores, so the Procurement Agent takes over.
  procurement: { robot_name: 'AdamNow', fault_code: 'J3-OVERCURRENT', stockout: 'SM-400-J3' },
};

export function demoEnabled() {
  return process.env.SPARESPARK_DEMO !== 'off';
}

export function attachDemo(workflow, { repairMs = Number(process.env.SPARESPARK_DEMO_REPAIR_MS ?? 2500), vendorMs = Number(process.env.SPARESPARK_DEMO_VENDOR_MS ?? 3000) } = {}) {
  // Simulated vendor: ships demo purchase orders shortly after approval. Receiving stays a human step.
  workflow.hooks.afterPoOrdered.push((po) => {
    if (!po.incident_id) return;
    const inc = workflow.get(po.incident_id);
    if (!inc.demo_scenario) return;
    workflow.log(inc.id, 'Demo simulator', 'tool', `Simulating ${po.vendor_name} shipping ${po.number} in ${vendorMs} ms`);
    workflow.schedule(inc.id, () => workflow.shipPo(po.id, { tracking_ref: `TRK-${po.number.slice(2)}`, actor: `${po.vendor_name} (simulated)` }), vendorMs);
  });
  workflow.hooks.afterRepairStarted.push((inc) => {
    if (!inc.demo_scenario) return;
    workflow.log(inc.id, 'Demo simulator', 'tool', `Simulating technician repair confirmation in ${repairMs} ms`);
    workflow.schedule(inc.id, () => workflow.confirmRepair(inc.id, { success: true, confirmed_by: 'M. Ortiz (simulated)', notes: 'Installed, tested, cell released.' }), repairMs);
  });
}

export function runScenario(workflow, name) {
  const s = SCENARIOS[name];
  if (!s) throw Object.assign(new Error(`Unknown scenario ${name}`), { status: 400 });
  const { stockout, ...input } = s;
  let before = null;
  if (stockout) {
    // Check the robot is free first so a refused scenario leaves stock alone.
    const robot = workflow.db.prepare('SELECT r.*, i.stage FROM robots r LEFT JOIN incidents i ON i.id = r.current_incident_id WHERE r.name = ?').get(input.robot_name);
    if (robot?.stage && !['Resolved', 'Failed / Needs Attention'].includes(robot.stage)) {
      throw Object.assign(new Error(`${robot.name} already has an open incident`), { status: 409 });
    }
    before = workflow.db.prepare('SELECT qty_on_hand, qty_reserved FROM parts WHERE part_number = ?').get(stockout);
    workflow.db.prepare('UPDATE parts SET qty_on_hand = qty_reserved WHERE part_number = ?').run(stockout);
  }
  const out = workflow.createIncident({ ...input, demo_scenario: name, reported_by: 'robot self-report (simulated)' });
  if (stockout && before) workflow.log(out.incident.id, 'Demo simulator', 'tool', `Simulated stockout: ${stockout} free stock set from ${before.qty_on_hand - before.qty_reserved} to 0`);
  return out;
}

// Restore robots and inventory to the seeded state and clear incident history.
// Knowledge records (notes, work orders, KB) are kept.
export function resetDemo(workflow) {
  workflow.cancelAll();
  const db = workflow.db;
  tx(db, () => {
    db.exec(`
      UPDATE robots SET current_incident_id = NULL;
      DELETE FROM chat_messages; DELETE FROM events; DELETE FROM work_orders;
      DELETE FROM reservations; DELETE FROM purchase_orders; DELETE FROM incidents; DELETE FROM webhook_log;
      DELETE FROM counters;
    `);
    seedOperational(db);
  });
}
