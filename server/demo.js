// Demo-only simulation, kept apart from the real workflow.
// It creates the two scripted faults and auto-confirms repairs for demo incidents.
// Disable with SPARESPARK_DEMO=off; real incidents never get auto-confirmed.

import { seedOperational } from './seed.js';
import { tx } from './db.js';

export const SCENARIOS = {
  happy: { robot_name: 'AdamNow', fault_code: 'J3-OVERCURRENT' },
  hitl: { robot_name: 'EveThen', fault_code: 'W-GEAR-BACKLASH' },
};

export function demoEnabled() {
  return process.env.SPARESPARK_DEMO !== 'off';
}

export function attachDemo(workflow, { repairMs = Number(process.env.SPARESPARK_DEMO_REPAIR_MS ?? 2500) } = {}) {
  workflow.hooks.afterRepairStarted.push((inc) => {
    if (!inc.demo_scenario) return;
    workflow.log(inc.id, 'Demo simulator', 'tool', `Simulating technician repair confirmation in ${repairMs} ms`);
    workflow.schedule(inc.id, () => workflow.confirmRepair(inc.id, { success: true, confirmed_by: 'M. Ortiz (simulated)', notes: 'Installed, tested, cell released.' }), repairMs);
  });
}

export function runScenario(workflow, name) {
  const s = SCENARIOS[name];
  if (!s) throw Object.assign(new Error(`Unknown scenario ${name}`), { status: 400 });
  return workflow.createIncident({ ...s, demo_scenario: name, reported_by: 'robot self-report (simulated)' });
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
      DELETE FROM reservations; DELETE FROM incidents; DELETE FROM webhook_log;
      DELETE FROM counters;
    `);
    seedOperational(db);
  });
}
