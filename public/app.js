// SpareSpark console. Vanilla JS, polls the API once a second.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

const state = { view: 'console', config: {}, robots: [], incidents: [], metrics: {}, alerts: [], selected: null, popup: null, kbFilter: '' };

// ---------- API ----------
function apiKey() { try { return localStorage.getItem('sparespark.apiKey') || ''; } catch { return ''; } }
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey()) headers['X-API-Key'] = apiKey();
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const key = prompt('This SpareSpark server requires an API key:');
    if (key) { try { localStorage.setItem('sparespark.apiKey', key); } catch {} return api(path, { method, body }); }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
function setHtml(el, html) { if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } }

// ---------- pills ----------
const ROBOT_TONE = { Operational: 'ok', Restored: 'ok', Fault: 'bad', 'Under Repair': 'warn' };
const robotPill = (s) => `<span class="pill ${ROBOT_TONE[s] || 'muted'}">${esc(s.toUpperCase())}</span>`;
function stagePill(stage) {
  const tone = stage === 'Resolved' ? 'ok' : stage === 'Awaiting Human Approval' ? 'warn' : stage?.startsWith('Failed') ? 'bad' : 'info';
  return `<span class="pill ${tone}">${esc(stage === 'Awaiting Human Approval' ? 'Waiting on human' : stage)}</span>`;
}
const MATCH_TONE = { Exact: 'ok', 'Documented Supersession': 'info', 'Potential Alternative': 'warn', 'Insufficient Evidence': 'bad' };
const matchPill = (m) => (m ? `<span class="pill ${MATCH_TONE[m] || 'muted'}">${esc(m)}</span>` : '');
const RELATION = { supersession: 'documents supersession', successful_swap: 'successful swap', tentative_use: 'tentative use', swap_unconfirmed: 'swap, outcome unknown', contradicts: 'does not fit', exact: 'exact match' };

const ROBOT_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="4" y="18" width="10" height="3" rx="1"/><path d="M9 18v-5l5-5"/><circle cx="9" cy="13" r="1.6"/><circle cx="14" cy="8" r="1.6"/><path d="M14 8l4 2m0 0 2-2m-2 2 1 3"/></svg>';

// ---------- views ----------
function renderConsole() {
  const m = state.metrics;
  const operational = (m.robots_by_status?.Operational || 0) + (m.robots_by_status?.Restored || 0);
  setHtml($('#consoleKpis'), [
    ['Plant 1 robots', m.robot_count ?? '–'], ['Operational', operational], ['Open tickets', m.open_incidents ?? '–'],
    ['Waiting on human', m.pending_approvals ?? 0], ['First-time fix', pct(m.first_time_fix_rate)], ['SLA attainment', pct(m.sla_attainment)],
  ].map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${esc(v)}</div></div>`).join(''));

  setHtml($('#robots'), state.robots.map((r) => {
    const waiting = r.incident_stage === 'Awaiting Human Approval';
    const cls = r.status === 'Fault' ? (waiting ? 'waiting' : 'fault') : '';
    const inc = r.incident_number ? `
      <div class="row"><span class="meta">${esc(r.incident_number)}</span>${stagePill(r.incident_stage)}</div>
      ${r.selected_part_number ? `<div class="row"><span class="meta">Part: <b>${esc(r.selected_part_number)}</b></span>${r.match_type && r.match_type !== 'Exact' ? '<span class="pill info">AI-found part</span>' : ''}</div>` : ''}
      ${r.incident_stage === 'Resolved' ? `<div class="row"><span class="pill ${r.first_time_fix ? 'ok' : 'bad'}">FTF ${r.first_time_fix ? '✓' : '✗'}</span>${r.sla_status ? `<span class="pill ${r.sla_status === 'Met' ? 'ok' : 'bad'}">SLA ${r.sla_status === 'Met' ? '✓' : '✗'}</span>` : ''}</div>` : ''}
      ${waiting ? '<div class="row"><span class="pill warn">Waiting on Logistics Coordinator</span></div>' : ''}` : '';
    return `<div class="robot ${cls} ${r.current_incident_id ? 'clickable' : ''}" data-incident="${r.current_incident_id || ''}">
      <div class="row" style="justify-content:space-between"><div class="icon">${ROBOT_ICON}</div>${robotPill(r.status)}</div>
      <div class="name">${esc(r.name)}</div>
      <div class="meta">${esc(r.robot_type)} · ${esc(r.model)}</div>
      <div class="meta">${esc(r.location)}</div>${inc}</div>`;
  }).join(''));

  setHtml($('#incidentTable'), `<tr><th>Incident</th><th>Robot</th><th>Fault</th><th>Failed part</th><th>Stage</th><th>Selected part</th><th>Match</th><th>FTF</th><th>SLA</th></tr>` +
    (state.incidents.length ? state.incidents.slice(0, 10).map((i) => `<tr class="click" data-incident="${i.id}">
      <td>${esc(i.number)}${i.external_number ? `<br><small>${esc(i.external_number)}</small>` : ''}</td><td>${esc(i.robot.name)}</td><td>${esc(i.fault_code)}</td>
      <td>${esc(i.failed_part_number || '')}</td><td>${stagePill(i.stage)}</td><td>${esc(i.selected_part_number || '')}</td><td>${matchPill(i.match_type)}</td>
      <td>${i.first_time_fix === null ? '' : i.first_time_fix ? 'Yes' : 'No'}</td><td>${esc(i.sla_status || '')}</td></tr>`).join('')
      : '<tr><td colspan="9"><small>No incidents yet. Run a demo flow above.</small></td></tr>'));
}

function renderDashboard() {
  const m = state.metrics;
  setHtml($('#dashKpis'), [
    ['Open robot incidents', m.open_incidents ?? '–', `${m.pending_approvals || 0} waiting on a human`],
    ['First-time fix rate', pct(m.first_time_fix_rate), `${m.resolved_incidents || 0} resolved incidents`],
    ['SLA attainment', pct(m.sla_attainment), 'Resolved within SLA'],
    ['Parts recovered by AI', m.parts_recovered_by_ai ?? 0, 'Substitutes found in maintenance knowledge, not inventory'],
  ].map(([l, v, h]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${esc(v)}</div><div class="hint">${esc(h)}</div></div>`).join(''));
}

async function loadWorkOrders() {
  const wos = await api('/work-orders');
  setHtml($('#woTable'), '<tr><th>Work order</th><th>Incident</th><th>Robot</th><th>Technician</th><th>Part</th><th>Bin</th><th>Location</th><th>Status</th><th>Instructions</th></tr>' +
    (wos.length ? wos.map((w) => `<tr><td>${esc(w.number)}</td><td>${esc(w.incident_number)}</td><td>${esc(w.robot)}</td><td>${esc(w.technician)}</td><td><b>${esc(w.part_number)}</b></td>
      <td>${esc(w.bin)}</td><td>${esc(w.location)}</td><td>${esc(w.status)}</td><td><small>${esc(w.install_instructions).replace(/\n/g, '<br>')}</small></td></tr>`).join('')
      : '<tr><td colspan="9"><small>No work orders yet.</small></td></tr>'));
}

// ---------- coordinator ----------
function renderCoordinatorLists() {
  const badge = $('#alertBadge');
  badge.hidden = !state.alerts.length; badge.textContent = state.alerts.length;
  setHtml($('#alerts'), state.alerts.length ? state.alerts.map((a) => `<div class="alert-item ${state.selected === a.id ? 'selected' : ''}" data-select="${a.id}">
      <div class="t">⚠ ${esc(a.number)} · ${esc(a.robot)}</div><div class="s">No exact match for ${esc(a.failed_part_number)}. Agent suggests ${esc(a.selected_part_number || 'a substitute')}.</div></div>`).join('')
    : '<div class="s"><small>No open alerts.</small></div>');
  setHtml($('#coordIncidents'), state.incidents.slice(0, 15).map((i) => `<div class="inc-item ${state.selected === i.id ? 'selected' : ''}" data-select="${i.id}">
      <div class="t">${esc(i.number)} · ${esc(i.robot.name)}</div><div class="s">${esc(i.stage)}</div></div>`).join('') || '<small>None yet.</small>');
}

async function renderCoordinatorMain() {
  const main = $('#coordMain');
  if (!state.selected) return;
  if (main.dataset.loaded !== String(state.selected)) {
    main.dataset.loaded = state.selected;
    main.innerHTML = `<div class="card" id="cHead"></div><div class="card" id="cRec"></div>
      <div class="card"><h3>Chat with the Spare Parts Agent</h3><div class="chat" id="cChat"></div>
        <form class="chat-form" id="chatForm"><input name="text" placeholder="e.g. Find me a replacement or superseded part for GR-220-W" autocomplete="off"><button class="btn primary">Send</button></form></div>
      <div class="card"><h3>Agent activity log</h3><ul class="timeline" id="cLog"></ul></div>`;
    $('#chatForm').addEventListener('submit', onChat);
  }
  const [inc, chat] = await Promise.all([api(`/incidents/${state.selected}`), api(`/incidents/${state.selected}/chat`)]);
  if (main.dataset.loaded !== String(inc.id)) return;

  setHtml($('#cHead'), `<div class="cand-head"><h3 style="margin:0">${esc(inc.number)} · ${esc(inc.robot.name)}</h3>${stagePill(inc.stage)}<span class="spacer"></span>
      ${inc.external_number ? `<span class="pill muted">ServiceNow ${esc(inc.external_number)}</span>` : ''}</div>
    <div class="meta" style="margin-top:6px">${esc(inc.robot.robot_type)} (${esc(inc.robot.model)}) at ${esc(inc.robot.location)} · fault <b>${esc(inc.fault_code)}</b>
      ${inc.failed_part_number ? ` · failed: ${esc(inc.failed_component)} <b>${esc(inc.failed_part_number)}</b>` : ''}</div>
    <div style="margin-top:6px"><small>Latest: ${esc(inc.latest_action)}</small></div>
    ${inc.stage === 'Repair in Progress' && !inc.demo_scenario ? '<div style="margin-top:10px"><button class="btn ok sm" data-confirm-repair>Confirm repair successful</button></div>' : ''}`);

  setHtml($('#cRec'), recommendationHtml(inc));
  setHtml($('#cChat'), chat.map((m) => `<div class="msg ${m.role}"><div class="who">${esc(m.author || m.role)}</div>${esc(m.text)}</div>`).join('') || '<small>No messages yet.</small>');
  const log = $('#cLog');
  setHtml(log, inc.events.slice().reverse().map((e) => `<li class="kind-${e.kind}"><span class="time">${time(e.created_at)}</span><span class="actor">${esc(e.actor)}</span><span class="msgtxt">${esc(e.message)}</span></li>`).join(''));
}

function recommendationHtml(inc) {
  const rec = inc.recommendation;
  if (!rec) return '<h3>Recommendation</h3><small>The Spare Parts Agent has not produced a recommendation yet.</small>';
  const awaiting = inc.stage === 'Awaiting Human Approval' && inc.approval_status !== 'Approved';
  const cands = rec.match_type === 'Exact' ? [rec.recommended] : rec.candidates || [];
  const cardHtml = (c, i) => `
    <div class="cand ${i === 0 && !c.rejected ? 'top' : ''} ${c.rejected ? 'rejected' : ''}">
      <div class="cand-head"><span class="pn">${esc(c.part_number)}</span>${matchPill(c.match_type)}
        <span class="pill ${c.available > 0 ? 'ok' : 'bad'}">${c.available} available · bin ${esc(c.bin)}</span>
        ${c.compatibility === 'listed' ? `<span class="pill muted">listed for ${esc(rec.robot_model)}</span>` : ''}
        ${c.rejected ? '<span class="pill bad">Rejected</span>' : ''}
        <span class="spacer"></span>
        ${awaiting && !c.rejected && c.available > 0 ? `<button class="btn ok sm" data-approve="${esc(c.part_number)}">Select this part</button>${rec.recommended?.part_number === c.part_number ? `<button class="btn danger sm" data-reject="${esc(c.part_number)}">Reject</button>` : ''}` : ''}
        ${inc.selected_part_number === c.part_number && inc.approval_status === 'Approved' ? `<span class="pill ok">Approved by ${esc(inc.approved_by)}</span>` : ''}
      </div>
      <ul class="evidence">${(c.evidence || []).map((e) => `<li><span class="ref">${esc(e.ref)}</span><span class="rel">${esc(e.source_label)} · ${esc(RELATION[e.relation] || e.relation)}${e.date ? ` · ${esc(e.date)}` : ''}</span><br><q>${esc(e.excerpt)}</q></li>`).join('')}</ul>
      ${c.warnings?.length ? `<div class="warnings">⚠ ${c.warnings.map(esc).join(' ')}</div>` : ''}
      ${c.install_instructions?.length ? `<div style="margin-top:8px"><b>Installation notes</b><ul class="install">${c.install_instructions.map((n) => `<li>${esc(n.text)} <small>[${esc(n.ref)}]</small></li>`).join('')}</ul></div>` : ''}
    </div>`;
  const excluded = (rec.excluded || []).map((x) => `<li><b>${esc(x.part_number)}</b>: ${esc(x.reason)} <q>${esc(x.evidence?.[0]?.excerpt || '')}</q></li>`).join('');
  const terms = (rec.relevant_sources || []).map((s) => `<span class="pill muted" title="${esc(s.title)}">${esc(s.ref)}: ${s.matched_terms.map(esc).join(', ')}</span>`).join(' ');
  return `<div class="cand-head"><h3 style="margin:0">Spare Parts Agent recommendation</h3>${matchPill(rec.match_type)}<span class="spacer"></span><small>${esc(rec.method || '')}</small></div>
    <p style="margin:8px 0 0">${esc(rec.rationale_llm || rec.rationale)}</p>
    ${rec.match_type !== 'Exact' ? `<div style="margin-top:8px"><small>Searched ${rec.sources_searched} records, ${rec.relevant_sources.length} relevant. Matched terms:</small><div class="row" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${terms}</div></div>` : ''}
    ${cands.filter(Boolean).map(cardHtml).join('')}
    ${excluded ? `<div style="margin-top:10px"><small><b>Excluded</b></small><ul class="install">${excluded}</ul></div>` : ''}`;
}

async function onChat(e) {
  e.preventDefault();
  const input = e.target.elements.text;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try { await api(`/incidents/${state.selected}/chat`, { method: 'POST', body: { text, author: 'S. Patel (Logistics)' } }); await renderCoordinatorMain(); }
  catch (err) { toast(err.message); }
  const chat = $('#cChat'); chat.scrollTop = chat.scrollHeight;
}

// ---------- knowledge ----------
async function renderKnowledge() {
  const [parts, kb] = await Promise.all([api('/parts'), api('/knowledge')]);
  setHtml($('#partsTable'), '<tr><th>Part</th><th>Description</th><th>Models</th><th class="num">On hand</th><th class="num">Reserved</th><th>Bin</th><th>Status</th><th>Superseded by</th></tr>' +
    parts.map((p) => `<tr><td><b>${esc(p.part_number)}</b></td><td>${esc(p.description)}</td><td>${esc(p.compatible_models)}</td><td class="num">${p.qty_on_hand}</td><td class="num">${p.qty_reserved}</td>
      <td>${esc(p.bin)}</td><td><span class="pill ${p.status === 'Active' ? 'ok' : p.status === 'Obsolete' ? 'bad' : 'warn'}">${esc(p.status)}</span></td><td>${esc(p.superseded_by || '–')}</td></tr>`).join(''));
  const f = state.kbFilter.toLowerCase();
  const LABEL = { kb_article: 'KB article', work_order: 'Work order', tech_note: 'Tech note', maintenance_history: 'Maint. history' };
  setHtml($('#kbList'), kb.filter((k) => !f || `${k.ref} ${k.title} ${k.body}`.toLowerCase().includes(f)).map((k) => `<div class="kb">
    <div class="h"><span class="ref">${esc(k.ref)}</span><span class="pill muted">${esc(LABEL[k.source_type] || k.source_type)}</span><b>${esc(k.title)}</b></div>
    <div class="body">${esc(k.body)}</div><div class="by">${esc(k.author || '')} · ${esc(k.robot_model || '')} · ${esc(k.created_at.slice(0, 10))}</div></div>`).join(''));
}

async function onLookup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const rec = await api('/recommendations', { method: 'POST', body: { part_number: fd.get('part_number'), robot_model: fd.get('robot_model') || null } });
    setHtml($('#lookupResult'), `<div class="card" style="margin-top:12px">${recommendationHtml({ recommendation: rec, stage: 'lookup' })}</div>`);
  } catch (err) { toast(err.message); }
}

// ---------- integrations ----------
async function renderIntegration() {
  const hooks = await api('/webhooks');
  const c = state.config;
  setHtml($('#configBox'), `<div class="card"><h3>This server</h3>
    <div>API key required: <b>${c.auth_required ? 'yes' : 'no'}</b></div>
    <div>Outbound webhook configured: <b>${c.webhook ? 'yes' : 'no'}</b></div>
    <div>LLM explanations (Claude): <b>${c.llm ? 'on' : 'off, deterministic retrieval only'}</b></div>
    <div>Demo endpoints: <b>${c.demo ? 'on' : 'off'}</b></div></div>`);
  setHtml($('#webhookTable'), '<tr><th>Time</th><th>Incident</th><th>Event</th><th>Status</th></tr>' +
    (hooks.length ? hooks.map((h) => `<tr><td>${time(h.created_at)}</td><td>${h.incident_id}</td><td>${esc(h.event)}</td><td>${h.error ? `<span class="pill bad">${esc(h.error)}</span>` : `<span class="pill ok">${h.status}</span>`}</td></tr>`).join('')
      : '<tr><td colspan="4"><small>No webhooks sent. Only incidents created by an external system (for example ServiceNow) are sent.</small></td></tr>'));
}

// ---------- workflow popup ----------
const STEP_LABEL = {
  'Fault Detected': 'Malfunction detected', Triage: 'Failed part identified', 'Inventory Search': 'Inventory searched', 'Knowledge Search': 'Maintenance knowledge searched',
  'Awaiting Human Approval': 'Human approval', 'Part Reserved': 'Part reserved', 'Technician Dispatched': 'Technician dispatched', 'Repair in Progress': 'Repair in progress', Resolved: 'Ticket resolved',
};
function openPopup(id) {
  state.popup = id;
  const d = $('#workflowDialog');
  if (!d.open) d.showModal();
  renderPopup();
}
async function renderPopup() {
  if (!state.popup) return;
  const inc = await api(`/incidents/${state.popup}`);
  const lastStageMsg = {};
  for (const e of inc.events) if (e.kind === 'stage') lastStageMsg[e.message.split(':')[0]] = e.message.slice(e.message.indexOf(':') + 1).trim();
  setHtml($('#wfTitle'), `Workflow: ${esc(inc.robot.name)} · ${esc(inc.number)}`);
  setHtml($('#wfSub'), `${inc.demo_scenario === 'hitl' ? 'Human-in-the-loop flow' : inc.demo_scenario === 'happy' ? 'Happy flow' : 'Live incident'} · fault ${esc(inc.fault_code)}`);
  const failed = inc.stage.startsWith('Failed');
  setHtml($('#wfSteps'), inc.progress.map((s, i) => {
    let status = s.status;
    if (failed && i === inc.progress.findIndex((p) => p.status !== 'done')) status = 'failed';
    const mark = status === 'done' ? '✓' : status === 'waiting' ? 'H' : status === 'failed' ? '!' : i + 1;
    const det = status === 'waiting' ? inc.latest_action : lastStageMsg[s.stage] || '';
    return `<li class="step ${status}"><span class="dot">${mark}</span><div><div class="lbl">${esc(STEP_LABEL[s.stage] || s.stage)}</div>${det ? `<div class="det">${esc(det)}</div>` : ''}</div><span class="owner">${esc(s.owner)}</span></li>`;
  }).join('') + (failed ? `<li class="step failed"><span class="dot">!</span><div><div class="lbl">Needs attention</div><div class="det">${esc(inc.latest_action)}</div></div><span class="owner">${esc(inc.stage_owner)}</span></li>` : ''));
  const resolved = inc.stage === 'Resolved';
  setHtml($('#wfFoot'), `<div class="summary">${resolved ? `<span class="pill ok">First-time fix: ${inc.first_time_fix ? 'YES' : 'NO'}</span><span class="pill ${inc.sla_status === 'Met' ? 'ok' : 'bad'}">SLA: ${esc(inc.sla_status?.toUpperCase())}</span><span class="pill info">${esc(inc.selected_part_number)}</span>` : ''}</div>
    ${inc.stage === 'Awaiting Human Approval' ? '<button class="btn accent" data-goto-coord>Open coordinator view</button>' : ''}
    <button class="btn" id="wfClose2">Close</button>`);
}
function closePopup() { state.popup = null; $('#workflowDialog').close(); }

// ---------- polling ----------
async function refresh() {
  try {
    const [robots, incidents, metrics, alerts] = await Promise.all([api('/robots'), api('/incidents'), api('/metrics'), api('/notifications')]);
    Object.assign(state, { robots, incidents, metrics, alerts });
    renderConsole(); renderDashboard(); renderCoordinatorLists();
    if (state.view === 'coordinator') await renderCoordinatorMain();
    if (state.view === 'dashboard') await loadWorkOrders();
    if (state.view === 'integration') await renderIntegration();
    if (state.popup) await renderPopup();
  } catch (err) { console.warn(err); }
}

function showView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'knowledge') renderKnowledge();
  refresh();
}

function selectIncident(id) {
  state.selected = Number(id);
  showView('coordinator');
}

async function runDemo(name) {
  try {
    const inc = await api(`/demo/${name}`, { method: 'POST' });
    if (name === 'hitl') state.selected = inc.id;
    openPopup(inc.id);
    refresh();
  } catch (err) { toast(err.message); }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-view],[data-incident],[data-select],[data-approve],[data-reject],[data-goto-coord],[data-confirm-repair],#wfClose,#wfClose2');
  if (!t) return;
  if (t.dataset.view) return showView(t.dataset.view);
  if (t.id === 'wfClose' || t.id === 'wfClose2') return closePopup();
  if (t.hasAttribute('data-goto-coord')) { const id = state.popup; closePopup(); return selectIncident(id); }
  if (t.dataset.select) return selectIncident(t.dataset.select);
  if (t.dataset.incident) return openPopup(Number(t.dataset.incident));
  try {
    if (t.dataset.approve) {
      t.disabled = true;
      await api(`/incidents/${state.selected}/approve`, { method: 'POST', body: { part_number: t.dataset.approve, approver: 'S. Patel (Logistics)' } });
      toast(`Approved ${t.dataset.approve}. Workflow resumed.`);
      openPopup(state.selected);
    } else if (t.dataset.reject) {
      const comment = prompt(`Why reject ${t.dataset.reject}? (optional)`) ?? null;
      await api(`/incidents/${state.selected}/reject`, { method: 'POST', body: { part_number: t.dataset.reject, approver: 'S. Patel (Logistics)', comment } });
    } else if (t.hasAttribute('data-confirm-repair')) {
      await api(`/incidents/${state.selected}/confirm-repair`, { method: 'POST', body: { success: true, confirmed_by: 'Maintenance Technician' } });
    }
  } catch (err) { toast(err.message); }
  refresh();
});

$('#btnHappy').addEventListener('click', () => runDemo('happy'));
$('#btnHitl').addEventListener('click', () => runDemo('hitl'));
$('#btnReset').addEventListener('click', async () => {
  if (!confirm('Reset robots, inventory and incidents to the starting state? Knowledge records are kept.')) return;
  try { await api('/demo/reset', { method: 'POST' }); closePopup(); state.selected = null; $("#coordMain").dataset.loaded = ""; $('#coordMain').innerHTML = '<div class="empty">No incident selected.</div>'; toast('Demo reset'); refresh(); }
  catch (err) { toast(err.message); }
});
$('#lookupForm').addEventListener('submit', onLookup);
$('#kbFilter').addEventListener('input', (e) => { state.kbFilter = e.target.value; renderKnowledge(); });
$('#workflowDialog').addEventListener('close', () => { state.popup = null; });

(async function init() {
  try {
    state.config = await api('/config');
    $('#modeLabel').textContent = state.config.llm ? 'Retrieval + Claude explanations' : 'Deterministic retrieval mode';
    if (!state.config.demo) $('#demoActions').hidden = true;
  } catch {}
  await refresh();
  setInterval(refresh, 1000);
})();
