// SQLite persistence (Node's built-in node:sqlite, no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seed, seedMissing } from './seed.js';
import { seedHistory } from './history.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS robots (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  model TEXT NOT NULL,
  robot_type TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Operational',      -- Operational | Fault | Under Repair | Restored
  criticality TEXT NOT NULL DEFAULT 'High',
  last_service_date TEXT,
  current_incident_id INTEGER,
  external_ci_id TEXT                               -- e.g. ServiceNow cmdb_ci sys_id
);

CREATE TABLE IF NOT EXISTS fault_codes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  robot_model TEXT,                                 -- NULL = applies to any model
  component TEXT NOT NULL,
  part_number TEXT NOT NULL,
  UNIQUE(code, robot_model)
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY,
  part_number TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  compatible_models TEXT NOT NULL DEFAULT '',       -- comma separated
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  qty_reserved INTEGER NOT NULL DEFAULT 0,
  bin TEXT,
  status TEXT NOT NULL DEFAULT 'Active',            -- Active | Obsolete | Superseded
  superseded_by TEXT,                               -- structured supersession, if known to inventory
  install_notes TEXT,
  CHECK (qty_reserved >= 0 AND qty_reserved <= qty_on_hand)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,                         -- KB0010334, WO-1187, TN-0042, MH-2211
  source_type TEXT NOT NULL,                        -- kb_article | work_order | tech_note | maintenance_history
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  robot_model TEXT,
  author TEXT,
  created_at TEXT NOT NULL,
  external_ref TEXT                                 -- e.g. ServiceNow kb_knowledge sys_id when ingested
);

CREATE TABLE IF NOT EXISTS synonyms (
  id INTEGER PRIMARY KEY,
  canonical TEXT NOT NULL,                          -- component concept, e.g. "wrist gear reducer"
  variant TEXT NOT NULL,
  UNIQUE(canonical, variant)
);

CREATE TABLE IF NOT EXISTS technicians (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '',
  location TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  robot_id INTEGER NOT NULL REFERENCES robots(id),
  fault_code TEXT NOT NULL,
  failed_component TEXT,
  failed_part_number TEXT,
  stage TEXT NOT NULL DEFAULT 'Fault Detected',
  stage_owner TEXT,
  latest_action TEXT,
  selected_part_number TEXT,
  match_type TEXT,                                  -- Exact | Documented Supersession | Potential Alternative
  recommendation_json TEXT,
  approval_status TEXT,                             -- Not Required | Pending | Approved | Rejected
  approved_by TEXT,
  approval_comment TEXT,
  technician_id INTEGER REFERENCES technicians(id),
  repair_status TEXT,
  first_time_fix INTEGER,
  sla_status TEXT,                                  -- In Progress | Met | Breached
  sla_due_at TEXT NOT NULL,
  resolution_notes TEXT,
  demo_scenario TEXT,                               -- happy | hitl | NULL (real request)
  external_system TEXT,                             -- e.g. servicenow
  external_ref TEXT,                                -- e.g. incident sys_id
  external_number TEXT,                             -- e.g. INC0012041
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  incident_id INTEGER UNIQUE NOT NULL REFERENCES incidents(id), -- one dispatch per incident
  robot_id INTEGER NOT NULL REFERENCES robots(id),
  technician_id INTEGER REFERENCES technicians(id),
  part_id INTEGER NOT NULL REFERENCES parts(id),
  bin TEXT,
  location TEXT,
  install_instructions TEXT,
  status TEXT NOT NULL DEFAULT 'Dispatched',        -- Dispatched | In Progress | Completed | Cancelled
  repair_confirmation TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER UNIQUE NOT NULL REFERENCES incidents(id), -- prevents duplicate reservations
  part_id INTEGER NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Reserved',          -- Reserved | Consumed | Released
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER REFERENCES incidents(id),
  actor TEXT NOT NULL,                              -- Triage Agent | Spare Parts Agent | ... | human name
  kind TEXT NOT NULL,                               -- stage | tool | decision | human | integration | error
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER REFERENCES incidents(id),
  role TEXT NOT NULL,                               -- user | agent
  author TEXT,
  text TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  contact_email TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  incident_id INTEGER REFERENCES incidents(id),     -- NULL = stock replenishment
  part_id INTEGER NOT NULL REFERENCES parts(id),
  vendor_id INTEGER REFERENCES vendors(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending Approval',  -- Pending Approval | Ordered | Shipped | Received | Rejected
  reason TEXT,
  requested_by TEXT,
  approved_by TEXT,
  approval_comment TEXT,
  tracking_ref TEXT,
  received_qty INTEGER,
  received_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  expected_at TEXT,
  shipped_at TEXT,
  received_at TEXT
);
-- Stock movements: issues to work orders, receipts from POs, cycle-count adjustments.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY,
  part_id INTEGER NOT NULL REFERENCES parts(id),
  qty_change INTEGER NOT NULL,
  kind TEXT NOT NULL,                               -- Issue | Receipt | Return | Adjustment
  ref TEXT,                                         -- work order or PO number
  note TEXT,
  created_at TEXT NOT NULL,
  is_historical INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS po_one_open_per_incident ON purchase_orders(incident_id)
  WHERE incident_id IS NOT NULL AND status NOT IN ('Rejected');
`;

// Columns added after the first release; applied to existing databases on startup.
const MIGRATIONS = [
  ['parts', 'vendor_id', 'INTEGER REFERENCES vendors(id)'],
  ['parts', 'unit_cost', 'REAL'],
  ['parts', 'reorder_qty', 'INTEGER NOT NULL DEFAULT 1'],
  // Historical rows (the seeded week of plant history) survive "Reset Demo".
  ['incidents', 'is_historical', 'INTEGER NOT NULL DEFAULT 0'],
  ['incidents', 'ai_assisted', 'INTEGER NOT NULL DEFAULT 1'],
  ['work_orders', 'is_historical', 'INTEGER NOT NULL DEFAULT 0'],
  ['reservations', 'is_historical', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchase_orders', 'is_historical', 'INTEGER NOT NULL DEFAULT 0'],
  ['events', 'is_historical', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db) {
  for (const [table, col, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

export function now() {
  return new Date().toISOString();
}

export function openDb(file = process.env.SPARESPARK_DB || './data/sparespark.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM robots').get();
  if (n === 0) seed(db);
  else seedMissing(db); // existing databases get new reference data, parts, vendors and costs
  if (process.env.SPARESPARK_HISTORY !== 'off') tx(db, () => seedHistory(db));

  return db;
}

// Run fn inside a transaction (node:sqlite has no helper for this).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function nextNumber(db, name, prefix, start) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  const value = row ? row.value + 1 : start;
  db.prepare('INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
  return `${prefix}${String(value).padStart(7, '0')}`;
}
