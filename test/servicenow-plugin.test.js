// Runs the ServiceNow plugin scripts against a real SpareSpark server, with a small mock of
// the Glide APIs they use (gs, GlideRecord, sn_ws.RESTMessageV2). This checks the integration
// contract end to end; it is not a substitute for testing on a ServiceNow instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SS_PORT = 3901;
const HOOK_PORT = 3902;
const src = (f) => readFileSync(new URL(`../servicenow-plugin/src/${f}`, import.meta.url), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny Glide mock ----------
const tables = { incident: new Map(), cmdb_ci: new Map() };
let seq = 0;
const messages = [];
function makeGr(tableName) {
  const store = tables[tableName];
  let rows = []; let idx = -1; let rec = {}; const queries = [];
  const gr = {
    get(id) { if (!store.has(id)) return false; rec = store.get(id); return true; },
    addQuery(f, v) { queries.push([f, v]); },
    query() { rows = [...store.values()].filter((r) => queries.every(([f, v]) => String(r[f] ?? '') === String(v))); idx = -1; },
    next() { idx += 1; if (idx >= rows.length) return false; rec = rows[idx]; return true; },
    getValue(f) { return rec[f] ?? null; },
    setValue(f, v) { rec[f] = v; },
    getUniqueValue() { return rec.sys_id; },
    isValidField(f) { return f in rec; },
    setWorkflow() {},
    update() { if (rec.__notes) { rec.notes = [...(rec.notes || []), ...rec.__notes]; rec.__notes = []; } store.set(rec.sys_id, rec); },
    insert() { rec.sys_id = rec.sys_id || `sys${++seq}`; store.set(rec.sys_id, rec); return rec.sys_id; },
  };
  return new Proxy(gr, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'cmdb_ci') { const ci = tables.cmdb_ci.get(rec.cmdb_ci) || {}; return { name: ci.name, sys_class_name: ci.sys_class_name, getDisplayValue: () => ci.name }; }
      return rec[k];
    },
    set(t, k, v) { if (k === 'work_notes') { rec.__notes = [...(rec.__notes || []), v]; } else rec[k] = v; return true; },
  });
}
class RESTMessageV2 {
  constructor() { this.headers = {}; }
  setHttpMethod(m) { this.method = m; }
  setEndpoint(u) { this.url = u; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  setHttpTimeout() {}
  setRequestBody(b) { this.body = b; }
  execute() {
    const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', this.method, this.url];
    for (const [k, v] of Object.entries(this.headers)) args.push('-H', `${k}: ${v}`);
    if (this.body) args.push('--data', this.body);
    const out = execFileSync('curl', args, { encoding: 'utf8' });
    const i = out.lastIndexOf('\n');
    return { getStatusCode: () => Number(out.slice(i + 1)), getBody: () => out.slice(0, i), getErrorMessage: () => '' };
  }
}
const props = { 'sparespark.base_url': `http://localhost:${SS_PORT}`, 'sparespark.api_key': 'k-123', 'sparespark.inbound_token': 'tok-456', 'sparespark.auto_resolve': 'true' };
const context = vm.createContext({
  gs: {
    getProperty: (k, d) => props[k] ?? d, getUserDisplayName: () => 'S. Patel',
    addInfoMessage: (m) => messages.push(['info', m]), addErrorMessage: (m) => messages.push(['error', m]), error: (m) => messages.push(['log', m]),
  },
  GlideRecord: function (t) { return makeGr(t); },
  sn_ws: { RESTMessageV2 },
  Class: { create: () => function () { this.initialize?.apply(this, arguments); } },
  JSON, String, parseInt, Error, encodeURIComponent,
});
vm.runInContext(src('script_include_SpareSparkClient.js'), context);

function runAs(file, current, extra = {}) {
  Object.assign(context, { current, previous: null, action: { setRedirectURL() {} }, ...extra });
  vm.runInContext(src(file), context);
}

// ---------- servers ----------
let ss; let hook; const received = [];
before(async () => {
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      // Mimic the Scripted REST resource.
      const request = { getHeader: (h) => req.headers[h.toLowerCase()], body: { data: JSON.parse(body) } };
      const response = { setStatus(s) { this.s = s; }, setBody(b) { this.b = b; } };
      runAs('rest_events.js', null, { request, response });
      received.push({ event: request.body.data.event, status: response.s });
      res.writeHead(response.s, { 'Content-Type': 'application/json' }).end(JSON.stringify(response.b));
    });
  }).listen(HOOK_PORT);
  ss = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(SS_PORT), SPARESPARK_DB: ':memory:', SPARESPARK_STEP_MS: '20', SPARESPARK_API_KEY: 'k-123', SPARESPARK_LLM: 'off',
      SPARESPARK_WEBHOOK_URL: `http://localhost:${HOOK_PORT}/api/global/sparespark/events`, SPARESPARK_WEBHOOK_TOKEN: 'tok-456' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://localhost:${SS_PORT}/api/health`)).ok) return; } catch {} await wait(50); }
  throw new Error('SpareSpark did not start');
});
after(() => { ss?.kill(); hook?.close(); });

test('ServiceNow incident flows through SpareSpark and back', async () => {
  tables.cmdb_ci.set('ci1', { sys_id: 'ci1', name: 'EveThen', sys_class_name: 'cmdb_ci_equipment' });
  const inc = makeGr('incident');
  inc.setValue('number', 'INC0012042'); inc.setValue('cmdb_ci', 'ci1'); inc.setValue('state', '1');
  inc.setValue('short_description', 'EveThen wrist backlash. Fault: W-GEAR-BACKLASH');
  inc.setValue('correlation_id', ''); inc.setValue('correlation_display', '');
  const sysId = inc.insert();

  const client = vm.runInContext('new SpareSparkClient()', context);
  assert.equal(client.extractFaultCode(inc), 'W-GEAR-BACKLASH');
  assert.equal(client.shouldSend(inc), true);
  runAs('business_rule_send_to_sparespark.js', inc);
  const row = () => tables.incident.get(sysId);
  assert.equal(row().correlation_display, 'SpareSpark');
  assert.match(row().correlation_id, /^SSI/);
  assert.equal(client.shouldSend(inc), false, 'must not resend once linked');

  // Wait for the approval request webhook.
  for (let i = 0; i < 100 && !received.some((r) => r.event === 'incident.approval_requested'); i++) await wait(50);
  assert.ok(received.some((r) => r.event === 'incident.approval_requested'));
  assert.ok(received.every((r) => r.status === 200));
  const notes = row().notes.join('\n');
  assert.match(notes, /GR-220-W2 \(Documented Supersession\)/);
  assert.match(notes, /WO-1187/);
  assert.match(notes, /shim/i);
  assert.equal(row().state, 2);

  // Coordinator approves from ServiceNow.
  const cur = makeGr('incident'); cur.get(sysId);
  runAs('ui_action_approve.js', cur);
  assert.ok(messages.some(([t, m]) => t === 'info' && /Approved GR-220-W2/.test(m)), JSON.stringify(messages));

  // Technician confirms repair in ServiceNow once it is in progress.
  let ssInc;
  for (let i = 0; i < 100; i++) {
    ssInc = await (await fetch(`http://localhost:${SS_PORT}/api/incidents/${row().correlation_id}`, { headers: { 'X-API-Key': 'k-123' } })).json();
    if (ssInc.stage === 'Repair in Progress') break;
    await wait(50);
  }
  assert.equal(ssInc.stage, 'Repair in Progress');
  assert.equal(ssInc.demo_scenario, null, 'real incidents are never auto-confirmed');
  const cur2 = makeGr('incident'); cur2.get(sysId);
  runAs('ui_action_confirm_repair.js', cur2);
  for (let i = 0; i < 100 && row().state !== 6; i++) await wait(50);
  assert.equal(row().state, 6, 'auto-resolved');
  assert.match(row().close_notes, /GR-220-W2/);
  assert.match(row().close_notes, /First-time fix: Yes/);
});

test('webhook with a bad token is refused', () => {
  const request = { getHeader: () => 'wrong', body: { data: { incident: {} } } };
  const response = { setStatus(s) { this.s = s; }, setBody(b) { this.b = b; } };
  runAs('rest_events.js', null, { request, response });
  assert.equal(response.s, 401);
});

test('API key is enforced', async () => {
  const res = await fetch(`http://localhost:${SS_PORT}/api/robots`);
  assert.equal(res.status, 401);
});
