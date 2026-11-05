// Seed data for the demo plant. Knowledge records are written the way technicians
// actually write: inconsistent part names, abbreviations, and distractors.

export const ROBOTS = [
  { name: 'AdamNow', model: 'ArcMaster W6', robot_type: '6-axis welding robot', location: 'Line A, Cell 1', criticality: 'High', last_service_date: '2026-08-14' },
  { name: 'EveThen', model: 'PX-200', robot_type: 'Pick-and-place robot', location: 'Line B, Cell 2', criticality: 'High', last_service_date: '2026-07-02' },
  { name: 'BobAfter', model: 'PalLift 900', robot_type: 'Palletizing robot', location: 'Warehouse Dock 3', criticality: 'Medium', last_service_date: '2026-09-21' },
  { name: 'JillBefore', model: 'CoatPro C4', robot_type: 'Painting robot', location: 'Line C, Cell 4', criticality: 'Medium', last_service_date: '2026-06-30' },
];

export const FAULT_CODES = [
  { code: 'J3-OVERCURRENT', robot_model: 'ArcMaster W6', component: 'Joint 3 servo motor', part_number: 'SM-400-J3' },
  { code: 'W-GEAR-BACKLASH', robot_model: 'PX-200', component: 'Wrist gear reducer', part_number: 'GR-220-W' },
  { code: 'GRIP-VAC-LOW', robot_model: 'PalLift 900', component: 'Vacuum gripper pump', part_number: 'VP-90-G' },
  { code: 'ATOM-CLOG', robot_model: 'CoatPro C4', component: 'Paint atomizer nozzle', part_number: 'AN-14-C' },
  { code: 'WIRE-FEED-SLIP', robot_model: 'ArcMaster W6', component: 'Wire feed roller kit', part_number: 'WF-12-A' },
  { code: 'TORCH-TEMP-HIGH', robot_model: 'ArcMaster W6', component: 'Torch coolant pump', part_number: 'TC-7-A' },
  { code: 'VAC-CUP-WEAR', robot_model: 'PX-200', component: 'Suction cup set', part_number: 'VC-30-P' },
  { code: 'J1-ENCODER-ERR', robot_model: 'PalLift 900', component: 'Axis 1 encoder', part_number: 'EN-500-J1' },
  { code: 'HOSE-PRESSURE', robot_model: 'CoatPro C4', component: 'Paint supply hose', part_number: 'PH-8-C' },
];

// Note: GR-220-W has no superseded_by value. Inventory does not know about W2;
// that knowledge only exists in the maintenance records below.
export const PARTS = [
  { part_number: 'SM-400-J3', description: 'Servo motor, joint 3, 400 W', compatible_models: 'ArcMaster W6', qty_on_hand: 2, bin: 'A-14', status: 'Active', install_notes: 'Re-home joint 3 and run encoder calibration after installation.' },
  { part_number: 'GR-220-W', description: 'Gear reducer, wrist, W revision', compatible_models: 'PX-200', qty_on_hand: 0, bin: 'B-10', status: 'Obsolete' },
  { part_number: 'GR-220-W2', description: 'Gear reducer, wrist, W2 revision', compatible_models: 'PX-200', qty_on_hand: 3, bin: 'B-12', status: 'Active' },
  { part_number: 'GR-225-W', description: 'Gear reducer, wrist, heavy duty', compatible_models: 'PX-250', qty_on_hand: 1, bin: 'B-15', status: 'Active' },
  { part_number: 'GR-230-W', description: 'Gear reducer, wrist, PX-300 series', compatible_models: 'PX-300', qty_on_hand: 4, bin: 'B-18', status: 'Active' },
  { part_number: 'VP-90-G', description: 'Vacuum pump, gripper', compatible_models: 'PalLift 900', qty_on_hand: 5, bin: 'C-03', status: 'Active' },
  { part_number: 'AN-14-C', description: 'Atomizer nozzle, 1.4 mm', compatible_models: 'CoatPro C4', qty_on_hand: 12, bin: 'D-01', status: 'Active' },
  { part_number: 'WF-12-A', description: 'Wire feed roller kit, 1.2 mm', compatible_models: 'ArcMaster W6', qty_on_hand: 8, bin: 'A-20', status: 'Active', install_notes: 'Set feed roller tension to 3 and run a 30 s wire inch test.' },
  { part_number: 'TC-7-A', description: 'Torch coolant pump, 7 l/min', compatible_models: 'ArcMaster W6', qty_on_hand: 1, bin: 'A-22', status: 'Active', install_notes: 'Bleed the coolant loop before the first weld.' },
  { part_number: 'VC-30-P', description: 'Suction cup set, 30 mm (4 pcs)', compatible_models: 'PX-200', qty_on_hand: 36, bin: 'B-02', status: 'Active' },
  { part_number: 'EN-500-J1', description: 'Absolute encoder, axis 1', compatible_models: 'PalLift 900', qty_on_hand: 1, bin: 'C-07', status: 'Active', install_notes: 'Run the axis 1 zero-point calibration after replacing the encoder.' },
  { part_number: 'PH-8-C', description: 'Paint supply hose, 8 m', compatible_models: 'CoatPro C4', qty_on_hand: 3, bin: 'D-05', status: 'Active', install_notes: 'Flush with solvent and check for leaks at 6 bar.' },
  { part_number: 'SM-380-J3', description: 'Servo motor, joint 3, 380 W (legacy)', compatible_models: 'ArcMaster W5', qty_on_hand: 1, bin: 'A-11', status: 'Superseded', superseded_by: 'SM-400-J3' },
];

export const KNOWLEDGE = [
  { ref: 'TN-0042', source_type: 'tech_note', robot_model: 'PX-200', author: 'J. Okafor', created_at: '2026-03-11T09:40:00Z',
    title: 'Tech note: EveThen sister unit wrist',
    body: 'GR-220-W out again. Swapped in GR-220-W2 from the B-line kit, same flange, needs 2 extra shims. Running fine.' },
  { ref: 'WO-1187', source_type: 'work_order', robot_model: 'PX-200', author: 'M. Ortiz', created_at: '2025-11-19T14:05:00Z',
    title: 'Wrist reducer failure on sister robot EveNext (Line B, Cell 5)',
    body: 'Wrist gear reducer GR-220-W failed with excessive backlash on sister robot EveNext (PX-200). Removed GR-220-W and installed GR-220-W2. Added 2 shims to correct flange height. Backlash test passed and the robot returned to production. Repair successful.' },
  { ref: 'KB0010334', source_type: 'kb_article', robot_model: 'PX-200', author: 'Reliability Engineering', created_at: '2025-06-02T08:00:00Z',
    title: 'Gear Reducer GR-220 Series — Replacement Compatibility',
    body: 'GR-220 series W revision superseded by W2 according to the 2025 OEM bulletin. Verify robot model compatibility and install two additional shims when required.' },
  { ref: 'MH-2201', source_type: 'maintenance_history', robot_model: 'PX-200', author: 'Night shift', created_at: '2025-10-03T02:15:00Z',
    title: 'Wrist gearbox noise',
    body: 'Wrist gearbox noisy on cell 5 unit. Ordered GR220W reducer, none in stock, deferred.' },
  { ref: 'MH-2207', source_type: 'maintenance_history', robot_model: 'PX-200', author: 'Night shift', created_at: '2025-10-09T03:30:00Z',
    title: 'Wrist red. W swap',
    body: 'wrist red. W replaced with W2 revision, 2 shims added, OK.' },
  { ref: 'MH-2215', source_type: 'maintenance_history', robot_model: 'PX-200', author: 'Day shift', created_at: '2026-01-21T10:10:00Z',
    title: 'Gear reducer W revision torque',
    body: 'Gear reducer W revision: torque output flange bolts to 38 Nm in a star pattern.' },
  { ref: 'TN-0057', source_type: 'tech_note', robot_model: 'PX-200', author: 'R. Singh', created_at: '2024-12-02T16:20:00Z',
    title: 'Stopgap wrist reducer during 2024 shutdown',
    body: 'Tried GR-225-W on a PX-200 during the 2024 shutdown as a stopgap for the wrist reducer. Bolts up with adapter plate AP-12, not verified under full payload.' },
  { ref: 'TN-0061', source_type: 'tech_note', robot_model: 'PX-200', author: 'J. Okafor', created_at: '2025-02-14T11:00:00Z',
    title: 'GR-230-W does not fit',
    body: 'GR-230-W does not fit the PX-200 wrist, wrong bolt pattern. Returned to stores.' },
  { ref: 'KB0010101', source_type: 'kb_article', robot_model: 'ArcMaster W6', author: 'Reliability Engineering', created_at: '2025-04-15T08:00:00Z',
    title: 'SM-400 servo motor replacement procedure',
    body: 'After replacing the joint 3 servo motor SM-400-J3, re-home joint 3 and run the encoder calibration routine before releasing the cell.' },
  { ref: 'TN-0070', source_type: 'tech_note', robot_model: 'PalLift 900', author: 'A. Chen', created_at: '2026-05-08T13:45:00Z',
    title: 'BobAfter gripper',
    body: 'Vacuum gripper on BobAfter losing suction, cleaned filter, VP-90-G pump OK.' },
];

export const SYNONYMS = [
  ['wrist gear reducer', ['wrist gearbox', 'wrist reducer', 'wrist red.', 'wrist red', 'gear reducer', 'reducer', 'gearbox']],
  ['joint 3 servo motor', ['j3 servo', 'joint 3 motor', 'joint 3 servo', 'servo motor', 'servo']],
  ['vacuum gripper pump', ['vacuum pump', 'gripper pump']],
  ['paint atomizer nozzle', ['atomizer', 'nozzle']],
  ['axis 1 encoder', ['encoder', 'j1 encoder']],
  ['paint supply hose', ['paint hose', 'hose']],
];

export const VENDORS = [
  { name: 'Apex Robotics Supply', contact_email: 'orders@apex-robotics.example', lead_time_days: 3 },
  { name: 'Meridian Motion Parts', contact_email: 'po@meridian-motion.example', lead_time_days: 5 },
  { name: 'Northline Industrial', contact_email: 'sales@northline.example', lead_time_days: 7 },
];

// part_number -> [vendor, unit cost, reorder quantity]
export const PART_SOURCING = {
  'SM-400-J3': ['Apex Robotics Supply', 1850, 2],
  'SM-380-J3': ['Apex Robotics Supply', 1500, 1],
  'GR-220-W': ['Meridian Motion Parts', 2200, 1],
  'GR-220-W2': ['Meridian Motion Parts', 2400, 2],
  'GR-225-W': ['Meridian Motion Parts', 2950, 1],
  'GR-230-W': ['Meridian Motion Parts', 2600, 1],
  'VP-90-G': ['Northline Industrial', 420, 2],
  'AN-14-C': ['Northline Industrial', 65, 10],
  'WF-12-A': ['Apex Robotics Supply', 180, 6],
  'TC-7-A': ['Apex Robotics Supply', 640, 1],
  'VC-30-P': ['Northline Industrial', 35, 40],
  'EN-500-J1': ['Northline Industrial', 760, 2],
  'PH-8-C': ['Northline Industrial', 140, 4],
};

export function seedProcurement(db) {
  const insV = db.prepare('INSERT OR IGNORE INTO vendors(name, contact_email, lead_time_days) VALUES (?,?,?)');
  for (const v of VENDORS) insV.run(v.name, v.contact_email, v.lead_time_days);
  const up = db.prepare(`UPDATE parts SET vendor_id = COALESCE(vendor_id, (SELECT id FROM vendors WHERE name = ?)),
    unit_cost = COALESCE(unit_cost, ?), reorder_qty = CASE WHEN vendor_id IS NULL THEN ? ELSE reorder_qty END WHERE part_number = ?`);
  for (const [pn, [vendor, cost, qty]] of Object.entries(PART_SOURCING)) up.run(vendor, cost, qty, pn);
}

export const TECHNICIANS = [
  { name: 'M. Ortiz', skills: 'robotics,welding,servo,gearbox', location: 'Plant 1' },
  { name: 'A. Chen', skills: 'robotics,pneumatics,paint', location: 'Plant 1' },
];

export function seedReference(db) {
  const insFault = db.prepare('INSERT OR IGNORE INTO fault_codes(code, robot_model, component, part_number) VALUES (?,?,?,?)');
  for (const f of FAULT_CODES) insFault.run(f.code, f.robot_model, f.component, f.part_number);
  const insKb = db.prepare('INSERT OR IGNORE INTO knowledge(ref, source_type, title, body, robot_model, author, created_at) VALUES (?,?,?,?,?,?,?)');
  for (const k of KNOWLEDGE) insKb.run(k.ref, k.source_type, k.title, k.body, k.robot_model, k.author, k.created_at);
  const insSyn = db.prepare('INSERT OR IGNORE INTO synonyms(canonical, variant) VALUES (?,?)');
  for (const [canon, variants] of SYNONYMS) {
    insSyn.run(canon, canon);
    for (const v of variants) insSyn.run(canon, v);
  }
  const insTech = db.prepare('INSERT INTO technicians(name, skills, location) VALUES (?,?,?)');
  if (db.prepare('SELECT COUNT(*) n FROM technicians').get().n === 0) {
    for (const t of TECHNICIANS) insTech.run(t.name, t.skills, t.location);
  }
}

// Robots and inventory: the operational state that "Reset Demo" restores.
export function seedOperational(db) {
  const upRobot = db.prepare(`INSERT INTO robots(name, model, robot_type, location, status, criticality, last_service_date, current_incident_id)
    VALUES (?,?,?,?, 'Operational', ?, ?, NULL)
    ON CONFLICT(name) DO UPDATE SET model=excluded.model, robot_type=excluded.robot_type, location=excluded.location,
      status='Operational', criticality=excluded.criticality, last_service_date=excluded.last_service_date, current_incident_id=NULL`);
  for (const r of ROBOTS) upRobot.run(r.name, r.model, r.robot_type, r.location, r.criticality, r.last_service_date);

  const upPart = db.prepare(`INSERT INTO parts(part_number, description, compatible_models, qty_on_hand, qty_reserved, bin, status, superseded_by, install_notes)
    VALUES (?,?,?,?,0,?,?,?,?)
    ON CONFLICT(part_number) DO UPDATE SET description=excluded.description, compatible_models=excluded.compatible_models,
      qty_on_hand=excluded.qty_on_hand, qty_reserved=0, bin=excluded.bin, status=excluded.status,
      superseded_by=excluded.superseded_by, install_notes=excluded.install_notes`);
  for (const p of PARTS) upPart.run(p.part_number, p.description, p.compatible_models, p.qty_on_hand, p.bin, p.status, p.superseded_by ?? null, p.install_notes ?? null);
}

export function seed(db) {
  seedReference(db);
  seedOperational(db);
  seedProcurement(db);
}

// Existing databases: add reference data and parts introduced in later releases
// without touching current stock levels.
export function seedMissing(db) {
  seedReference(db);
  const ins = db.prepare(`INSERT OR IGNORE INTO parts(part_number, description, compatible_models, qty_on_hand, qty_reserved, bin, status, superseded_by, install_notes)
    VALUES (?,?,?,?,0,?,?,?,?)`);
  for (const p of PARTS) ins.run(p.part_number, p.description, p.compatible_models, p.qty_on_hand, p.bin, p.status, p.superseded_by ?? null, p.install_notes ?? null);
  seedProcurement(db);
}
