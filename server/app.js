// HTTP API + static console. Plain node:http, no framework.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, now } from './db.js';
import { recommend } from './knowledge.js';
import { Workflow, STAGES, HttpError } from './workflow.js';
import { attachDemo, runScenario, resetDemo, demoEnabled } from './demo.js';
import { makeWebhookSender } from './integrations.js';
import { llmEnabled } from './llm.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createApp({ dbFile, stepMs, repairMs, vendorMs } = {}) {
  const db = openDb(dbFile);
  let workflow;
  const serialize = (id, opts) => serializeIncident(db, workflow, id, opts);
  workflow = new Workflow(db, { stepMs, onChange: makeWebhookSender(db, serialize) });
  if (demoEnabled()) {
    const opts = {};
    if (repairMs !== undefined) opts.repairMs = repairMs;
    if (vendorMs !== undefined) opts.vendorMs = vendorMs;
    attachDemo(workflow, opts);
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  const findIncident = (key) => {
    const row = /^\d+$/.test(key)
      ? db.prepare('SELECT id FROM incidents WHERE id = ?').get(Number(key))
      : db.prepare('SELECT id FROM incidents WHERE number = ? OR external_number = ? OR external_ref = ?').get(key, key, key);
    if (!row) throw new HttpError(404, `Incident ${key} not found`);
    return row.id;
  };

  // ----- reference data -----
  route('GET', '/api/health', () => ({ ok: true, time: now() }));
  route('GET', '/api/config', async () => ({
    llm: await llmEnabled(), demo: demoEnabled(), auth_required: !!process.env.SPARESPARK_API_KEY,
    webhook: !!process.env.SPARESPARK_WEBHOOK_URL, stages: Object.values(STAGES),
  }));
  route('GET', '/api/robots', () => db.prepare(`SELECT r.*, i.number AS incident_number, i.stage AS incident_stage, i.selected_part_number, i.match_type,
      i.first_time_fix, i.sla_status, i.approval_status
    FROM robots r LEFT JOIN incidents i ON i.id = r.current_incident_id ORDER BY r.id`).all());
  route('GET', '/api/parts', () => db.prepare(`SELECT p.*, p.qty_on_hand - p.qty_reserved AS available, v.name AS vendor_name,
      (SELECT COALESCE(SUM(qty), 0) FROM purchase_orders po WHERE po.part_id = p.id AND po.status IN ('Ordered','Shipped')) AS on_order
    FROM parts p LEFT JOIN vendors v ON v.id = p.vendor_id ORDER BY p.part_number`).all());
  route('GET', '/api/fault-codes', () => db.prepare('SELECT * FROM fault_codes ORDER BY code').all());
  route('GET', '/api/technicians', () => db.prepare('SELECT * FROM technicians').all());
  route('GET', '/api/knowledge', ({ query }) => {
    const q = query.get('q');
    return q
      ? db.prepare("SELECT * FROM knowledge WHERE title LIKE ? OR body LIKE ? ORDER BY created_at DESC").all(`%${q}%`, `%${q}%`)
      : db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all();
  });
  // Ingest knowledge from another system (e.g. ServiceNow KB articles or closed work notes).
  route('POST', '/api/knowledge', ({ body }) => {
    const items = Array.isArray(body) ? body : [body];
    const allowed = new Set(['kb_article', 'work_order', 'tech_note', 'maintenance_history']);
    const up = db.prepare(`INSERT INTO knowledge(ref, source_type, title, body, robot_model, author, created_at, external_ref) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(ref) DO UPDATE SET source_type=excluded.source_type, title=excluded.title, body=excluded.body, robot_model=excluded.robot_model,
        author=excluded.author, external_ref=excluded.external_ref`);
    for (const k of items) {
      if (!k.ref || !k.body || !allowed.has(k.source_type)) throw new HttpError(400, 'Each item needs ref, body and source_type (kb_article | work_order | tech_note | maintenance_history)');
      up.run(k.ref, k.source_type, k.title || k.ref, k.body, k.robot_model ?? null, k.author ?? null, k.created_at || now(), k.external_ref ?? null);
    }
    return { upserted: items.length };
  });
  // Upsert robots from a CMDB.
  route('POST', '/api/robots', ({ body }) => {
    const items = Array.isArray(body) ? body : [body];
    const up = db.prepare(`INSERT INTO robots(name, model, robot_type, location, criticality, external_ci_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET model=excluded.model, robot_type=excluded.robot_type, location=excluded.location, criticality=excluded.criticality, external_ci_id=excluded.external_ci_id`);
    for (const r of items) {
      if (!r.name || !r.model) throw new HttpError(400, 'Each robot needs name and model');
      up.run(r.name, r.model, r.robot_type || 'Industrial robot', r.location || '', r.criticality || 'Medium', r.external_ci_id ?? null);
    }
    return { upserted: items.length };
  });

  // ----- stateless recommendation (used by integrations) -----
  route('POST', '/api/recommendations', ({ body }) => recommend(db, body || {}));

  // ----- incidents -----
  route('GET', '/api/incidents', ({ query }) => {
    const open = query.get('open') === 'true';
    const rows = db.prepare(`SELECT i.id FROM incidents i ${open ? 'WHERE i.stage NOT IN (?, ?)' : ''} ORDER BY i.created_at DESC, i.id DESC LIMIT 200`)
      .all(...(open ? [STAGES.RESOLVED, STAGES.FAILED] : []));
    return rows.map((r) => serialize(r.id, { compact: true }));
  });
  route('POST', '/api/incidents', ({ body, res }) => {
    const { incident, created } = workflow.createIncident(body || {});
    res.statusCode = created ? 201 : 200;
    return serialize(incident.id);
  });
  route('GET', '/api/incidents/:id', ({ params }) => serialize(findIncident(params.id)));
  route('POST', '/api/incidents/:id/approve', ({ params, body }) => { const id = findIncident(params.id); workflow.approve(id, body || {}); return serialize(id); });
  route('POST', '/api/incidents/:id/reject', async ({ params, body }) => { const id = findIncident(params.id); await workflow.reject(id, body || {}); return serialize(id); });
  route('POST', '/api/incidents/:id/confirm-repair', ({ params, body }) => { const id = findIncident(params.id); workflow.confirmRepair(id, body || {}); return serialize(id); });
  route('GET', '/api/incidents/:id/chat', ({ params }) => workflow.chatHistory(findIncident(params.id)));
  route('POST', '/api/incidents/:id/chat', ({ params, body }) => workflow.chat(findIncident(params.id), body || {}));
  route('GET', '/api/notifications', () => db.prepare(`SELECT i.id, i.number, i.failed_part_number, COALESCE(i.selected_part_number, json_extract(i.recommendation_json, '$.recommended.part_number')) AS selected_part_number, i.latest_action, r.name AS robot, i.created_at
      FROM incidents i JOIN robots r ON r.id = i.robot_id WHERE i.stage = ? ORDER BY i.id`).all(STAGES.APPROVAL));
  route('GET', '/api/events', ({ query }) => db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT 100').all(Number(query.get('since') || 0)));
  route('GET', '/api/work-orders', () => db.prepare(`SELECT w.*, i.number AS incident_number, r.name AS robot, p.part_number, t.name AS technician
      FROM work_orders w JOIN incidents i ON i.id = w.incident_id JOIN robots r ON r.id = w.robot_id JOIN parts p ON p.id = w.part_id
      LEFT JOIN technicians t ON t.id = w.technician_id ORDER BY w.created_at DESC, w.id DESC`).all());
  route('GET', '/api/inventory-movements', () => db.prepare(`SELECT m.*, p.part_number, p.description, p.bin FROM inventory_movements m
      JOIN parts p ON p.id = m.part_id ORDER BY m.created_at DESC, m.id DESC LIMIT 300`).all());
  route('GET', '/api/webhooks', () => db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 50').all());
  route('GET', '/api/metrics', () => metrics(db));
  route('GET', '/api/metrics/timeline', ({ query }) => timeline(db, { days: Number(query.get('days')) || 7 }));

  // ----- procurement -----
  route('GET', '/api/vendors', () => db.prepare('SELECT * FROM vendors ORDER BY name').all());
  route('GET', '/api/purchase-orders', ({ query }) => {
    const status = query.get('status');
    const rows = db.prepare(`SELECT id FROM purchase_orders ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 200`).all(...(status ? [status] : []));
    return rows.map((r) => workflow.getPo(r.id));
  });
  route('POST', '/api/purchase-orders', ({ body, res }) => { res.statusCode = 201; return workflow.createPurchaseOrder({ ...(body || {}), incident_id: null }); });
  route('GET', '/api/purchase-orders/:id', ({ params }) => workflow.getPo(params.id));
  route('POST', '/api/purchase-orders/:id/approve', ({ params, body }) => workflow.approvePo(params.id, body || {}));
  route('POST', '/api/purchase-orders/:id/reject', ({ params, body }) => workflow.rejectPo(params.id, body || {}));
  route('POST', '/api/purchase-orders/:id/ship', ({ params, body }) => workflow.shipPo(params.id, body || {}));
  route('POST', '/api/purchase-orders/:id/receive', ({ params, body }) => workflow.receivePo(params.id, body || {}));

  // ----- demo -----
  route('POST', '/api/demo/reset', () => { requireDemo(); resetDemo(workflow); return { ok: true }; });
  route('POST', '/api/demo/:scenario', ({ params, res }) => { requireDemo(); const { incident } = runScenario(workflow, params.scenario); res.statusCode = 201; return serialize(incident.id); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        cors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        checkAuth(req, url.pathname);
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) throw new HttpError(404, 'Not found');
        const m = url.pathname.match(r.re);
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : null;
        const out = await r.handler({ req, res, params, query: url.searchParams, body });
        send(res, res.statusCode || 200, out);
      } else {
        await serveStatic(url.pathname, res);
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message || 'Internal error' });
    }
  });

  workflow.resumeAll();
  return { server, db, workflow };
}

function requireDemo() {
  if (!demoEnabled()) throw new HttpError(403, 'Demo endpoints are disabled (SPARESPARK_DEMO=off)');
}

function checkAuth(req, path) {
  const key = process.env.SPARESPARK_API_KEY;
  if (!key || path === '/api/health' || path === '/api/config') return;
  const given = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(key);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Missing or invalid API key');
}

function cors(req, res) {
  const origin = process.env.SPARESPARK_CORS_ORIGIN;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function send(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(await readFile(file));
}

export function metrics(db) {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const open = q('SELECT COUNT(*) n FROM incidents WHERE stage NOT IN (?, ?)', STAGES.RESOLVED, STAGES.FAILED).n;
  const resolved = q('SELECT COUNT(*) n, SUM(first_time_fix = 1) ftf FROM incidents WHERE stage = ?', STAGES.RESOLVED);
  const repaired = q('SELECT COUNT(*) n FROM incidents WHERE first_time_fix IS NOT NULL').n;
  const sla = q("SELECT SUM(sla_status = 'Met') met, SUM(sla_status IN ('Met','Breached')) total FROM incidents");
  const ai = q("SELECT COUNT(*) n FROM incidents WHERE stage = ? AND match_type IS NOT NULL AND match_type <> 'Exact'", STAGES.RESOLVED).n;
  const robots = db.prepare('SELECT status, COUNT(*) n FROM robots GROUP BY status').all();
  const pending = q('SELECT COUNT(*) n FROM incidents WHERE stage = ?', STAGES.APPROVAL).n;
  const po = q(`SELECT
      SUM(status IN ('Pending Approval','Ordered','Shipped')) open_n,
      SUM(status = 'Pending Approval') pending,
      SUM(status IN ('Ordered','Shipped')) in_transit,
      SUM(status = 'Received') received,
      SUM(CASE WHEN status IN ('Ordered','Shipped','Received') THEN qty * unit_cost ELSE 0 END) spend,
      SUM(CASE WHEN status IN ('Ordered','Shipped') THEN qty * unit_cost ELSE 0 END) on_order_value,
      AVG(CASE WHEN status = 'Received' THEN (julianday(received_at) - julianday(created_at)) * 86400 END) cycle_s,
      SUM(status = 'Received' AND received_at <= expected_at) on_time
    FROM purchase_orders`);
  const stockouts = q('SELECT COUNT(DISTINCT incident_id) n FROM purchase_orders WHERE incident_id IS NOT NULL').n;
  const procuredFixes = q("SELECT COUNT(*) n FROM incidents i WHERE i.stage = ? AND EXISTS (SELECT 1 FROM purchase_orders po WHERE po.incident_id = i.id AND po.status = 'Received')", STAGES.RESOLVED).n;
  // AI-assisted vs manual, over all incidents (seeded history plus new activity).
  const cohort = (ai) => {
    const c = q(`SELECT COUNT(*) n, SUM(stage = ?) resolved, SUM(first_time_fix = 1) ftf, SUM(first_time_fix IS NOT NULL) repaired,
        SUM(sla_status = 'Met') met, SUM(sla_status IN ('Met','Breached')) sla_total,
        AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 86400 END) mttr
      FROM incidents WHERE ai_assisted = ?`, STAGES.RESOLVED, ai ? 1 : 0);
    return { incidents: c.n || 0, resolved: c.resolved || 0, first_time_fix_rate: c.repaired ? (c.ftf || 0) / c.repaired : null,
      sla_attainment: c.sla_total ? (c.met || 0) / c.sla_total : null, avg_resolution_seconds: c.mttr ?? null };
  };
  const today = new Date();
  const daily = [];
  for (let d = 7; d >= 0; d -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d)).toISOString().slice(0, 10);
    const r = q(`SELECT SUM(ai_assisted = 1) ai, SUM(ai_assisted = 0) manual, SUM(sla_status = 'Breached') breached
      FROM incidents WHERE substr(created_at, 1, 10) = ?`, day);
    daily.push({ date: day, ai: r.ai || 0, manual: r.manual || 0, breached: r.breached || 0 });
  }
  const hist = q('SELECT SUM(is_historical = 1) h, SUM(is_historical = 0) l FROM incidents');
  return {
    ai_vs_manual: { ai: cohort(true), manual: cohort(false) },
    daily,
    historical_incidents: hist.h || 0,
    live_incidents: hist.l || 0,
    downtime_hours: (q("SELECT SUM((julianday(COALESCE(resolved_at, ?)) - julianday(created_at)) * 24) h FROM incidents", new Date().toISOString()).h) || 0,
    procurement: {
      open_purchase_orders: po.open_n || 0,
      awaiting_approval: po.pending || 0,
      awaiting_delivery: po.in_transit || 0,
      received: po.received || 0,
      spend: po.spend || 0,
      on_order_value: po.on_order_value || 0,
      avg_cycle_seconds: po.cycle_s ?? null,
      on_time_delivery_rate: po.received ? (po.on_time || 0) / po.received : null,
      stockout_incidents: stockouts,
      repairs_unblocked_by_procurement: procuredFixes,
    },
    open_incidents: open,
    pending_approvals: pending,
    resolved_incidents: resolved.n,
    first_time_fix_rate: repaired ? (resolved.ftf || 0) / repaired : null,
    sla_attainment: sla.total ? sla.met / sla.total : null,
    parts_recovered_by_ai: ai,
    robots_by_status: Object.fromEntries(robots.map((r) => [r.status, r.n])),
    robot_count: robots.reduce((s, r) => s + r.n, 0),
  };
}

// Day-by-day dashboard data for the slider: for each day, the KPIs as of the end of that day
// (window = first day through that day) and the same numbers for that day alone.
// Uses every incident, seeded history and new activity alike.
export function timeline(db, { days = 7, now = new Date() } = {}) {
  const H = 3600000;
  const robots = db.prepare('SELECT COUNT(*) n FROM robots').get().n || 1;
  const rows = db.prepare(`SELECT i.id, i.created_at, i.resolved_at, i.stage, i.ai_assisted, i.match_type, i.first_time_fix, i.sla_status, i.is_historical,
      (SELECT MAX(created_at) FROM events e WHERE e.incident_id = i.id) last_event,
      EXISTS (SELECT 1 FROM purchase_orders po WHERE po.incident_id = i.id AND po.status = 'Received') procured
    FROM incidents i`).all();
  const nowMs = now.getTime();
  const inc = rows.map((r) => {
    const failed = r.stage === STAGES.FAILED;
    const closed = r.resolved_at || (failed ? r.last_event : null);
    let method = null; // how the part was found, for resolved incidents
    if (r.stage === STAGES.RESOLVED) {
      method = !r.ai_assisted ? 'Manual pick by planner'
        : r.procured ? 'Procured after stockout'
          : r.match_type === 'Exact' ? 'Exact match in inventory'
            : r.match_type || 'Exact match in inventory';
    }
    return { ...r, failed, start: Date.parse(r.created_at), end: closed ? Date.parse(closed) : null, method };
  });
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const first = midnight - days * 86400000;
  const overlapH = (a, b) => inc.reduce((sum, i) => {
    const s = Math.max(i.start, a), e = Math.min(i.end ?? nowMs, b);
    return e > s ? sum + (e - s) / H : sum;
  }, 0);
  const kpis = (from, to) => {
    const closedIn = inc.filter((i) => i.end !== null && i.end >= from && i.end <= to);
    const repaired = closedIn.filter((i) => i.first_time_fix !== null);
    const sla = closedIn.filter((i) => i.sla_status === 'Met' || i.sla_status === 'Breached');
    const down = overlapH(from, to);
    const hours = Math.max(0, (to - from) / H);
    const cohort = (ai) => {
      const c = closedIn.filter((i) => !!i.ai_assisted === ai);
      const rep = c.filter((i) => i.first_time_fix !== null);
      const res = c.filter((i) => i.stage === STAGES.RESOLVED);
      return {
        incidents: inc.filter((i) => !!i.ai_assisted === ai && i.start >= from && i.start <= to).length,
        first_time_fix_rate: rep.length ? rep.filter((i) => i.first_time_fix === 1).length / rep.length : null,
        sla_attainment: c.filter((i) => i.sla_status).length ? c.filter((i) => i.sla_status === 'Met').length / c.filter((i) => i.sla_status).length : null,
        avg_resolution_seconds: res.length ? res.reduce((s, i) => s + (i.end - i.start) / 1000, 0) / res.length : null,
      };
    };
    const methods = {};
    for (const i of closedIn) if (i.method) methods[i.method] = (methods[i.method] || 0) + 1;
    return {
      robot_availability: hours ? Math.max(0, 1 - down / (robots * hours)) : null,
      downtime_hours: down,
      new_incidents: inc.filter((i) => i.start >= from && i.start <= to).length,
      resolved_incidents: closedIn.filter((i) => i.stage === STAGES.RESOLVED).length,
      first_time_fix_rate: repaired.length ? repaired.filter((i) => i.first_time_fix === 1).length / repaired.length : null,
      sla_attainment: sla.length ? sla.filter((i) => i.sla_status === 'Met').length / sla.length : null,
      ai_recovered_parts: closedIn.filter((i) => i.stage === STAGES.RESOLVED && i.match_type && i.match_type !== 'Exact').length,
      part_discovery: methods,
      ai_vs_manual: { ai: cohort(true), manual: cohort(false) },
    };
  };
  const out = [];
  for (let d = days; d >= 0; d -= 1) {
    const dayStart = midnight - d * 86400000;
    const dayEnd = Math.min(dayStart + 86400000 - 1, nowMs);
    const open = inc.filter((i) => i.start <= dayEnd && (i.end === null || i.end > dayEnd));
    const created = inc.filter((i) => i.start >= dayStart && i.start <= dayEnd);
    out.push({
      date: new Date(dayStart).toISOString().slice(0, 10),
      today: d === 0,
      open_incidents: open.length,
      robots_down: new Set(open.map((i) => i.id)).size,
      incidents: { total: created.length, ai: created.filter((i) => i.ai_assisted).length, manual: created.filter((i) => !i.ai_assisted).length },
      day: kpis(dayStart, dayEnd),
      to_date: kpis(first, dayEnd),
    });
  }
  return { robots, days: out };
}

function serializeIncident(db, workflow, id, { compact = false } = {}) {
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!inc) throw new HttpError(404, 'Incident not found');
  const robot = db.prepare('SELECT id, name, model, robot_type, location, status, external_ci_id FROM robots WHERE id = ?').get(inc.robot_id);
  const tech = inc.technician_id ? db.prepare('SELECT id, name FROM technicians WHERE id = ?').get(inc.technician_id) : null;
  const wo = db.prepare('SELECT w.*, p.part_number FROM work_orders w JOIN parts p ON p.id = w.part_id WHERE w.incident_id = ?').get(id) || null;
  const reservation = db.prepare('SELECT r.*, p.part_number, p.bin FROM reservations r JOIN parts p ON p.id = r.part_id WHERE r.incident_id = ?').get(id) || null;
  const seq = db.prepare('SELECT MAX(id) m FROM events WHERE incident_id = ?').get(id).m || 0;
  const poRow = db.prepare('SELECT id FROM purchase_orders WHERE incident_id = ? ORDER BY id DESC LIMIT 1').get(id);
  const rec = inc.recommendation_json ? JSON.parse(inc.recommendation_json) : null;
  const out = {
    ...inc,
    recommendation_json: undefined,
    first_time_fix: inc.first_time_fix === null ? null : !!inc.first_time_fix,
    seq,
    robot,
    technician: tech,
    work_order: wo,
    reservation,
    purchase_order: poRow ? workflow.getPo(poRow.id) : null,
    progress: workflow.stagePath(inc),
    recommendation: rec && (compact ? compactRec(rec) : rec),
  };
  if (!compact) out.events = db.prepare('SELECT * FROM events WHERE incident_id = ? ORDER BY id').all(id).map((e) => ({ ...e, data: e.data_json ? JSON.parse(e.data_json) : null, data_json: undefined }));
  return out;
}

function compactRec(rec) {
  const c = rec.recommended;
  return {
    requested_part: rec.requested_part,
    match_type: rec.match_type,
    recommended_part: c?.part_number || null,
    available: c?.available ?? null,
    bin: c?.bin ?? null,
    approval_required: rec.approval_required,
    rationale: rec.rationale_llm || rec.rationale,
    sources: c ? c.evidence.map((e) => ({ ref: e.ref, type: e.source_label, excerpt: e.excerpt })) : [],
    install_instructions: rec.install_instructions || [],
    other_candidates: (rec.candidates || []).filter((x) => x.part_number !== c?.part_number).map((x) => ({ part_number: x.part_number, match_type: x.match_type, available: x.available, rejected: !!x.rejected })),
  };
}
