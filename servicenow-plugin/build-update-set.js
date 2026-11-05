// Builds servicenow-plugin/dist/sparespark-servicenow-update-set.xml from the sources in src/.
// Run: npm run build:servicenow
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, 'src', f), 'utf8');
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
const SET_NAME = `SpareSpark Connector ${VERSION}`;
const id = (key) => createHash('md5').update(`sparespark:${key}`).digest('hex'); // stable sys_ids across builds
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const field = (k, v) => (v === null || v === undefined || v === '' ? `<${k}/>` : `<${k}>${escXml(v)}</${k}>`);

const records = [];
function add(table, type, key, targetName, fields) {
  const sysId = id(key);
  const all = {
    ...fields,
    sys_class_name: table,
    sys_created_by: 'admin', sys_created_on: stamp, sys_id: sysId, sys_mod_count: 0,
    sys_name: targetName, sys_package: 'global', sys_policy: '', sys_scope: 'global',
    sys_update_name: `${table}_${sysId}`, sys_updated_by: 'admin', sys_updated_on: stamp,
  };
  const inner = Object.entries(all).map(([k, v]) => {
    if (k === 'sys_package' || k === 'sys_scope') return `<${k} display_value="Global" source="global">global</${k}>`;
    if (v && typeof v === 'object' && v.ref) return `<${k} display_value="${escXml(v.display || '')}">${escXml(v.ref)}</${k}>`;
    return field(k, v);
  }).join('');
  const payload = `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE">${inner}</${table}></record_update>`;
  records.push({ table, type, sysId, targetName, payload });
  return sysId;
}

// ---- system properties ----
const props = [
  ['sparespark.base_url', 'Base URL of the SpareSpark service, e.g. https://sparespark.example.com', 'string', ''],
  ['sparespark.api_key', 'API key sent to SpareSpark as X-API-Key (matches SPARESPARK_API_KEY on the server)', 'string', ''],
  ['sparespark.inbound_token', 'Shared secret SpareSpark sends as X-SpareSpark-Token on webhooks (matches SPARESPARK_WEBHOOK_TOKEN). Empty disables the check.', 'string', ''],
  ['sparespark.auto_resolve', 'Resolve the ServiceNow incident when SpareSpark confirms the repair', 'boolean', 'true'],
  ['sparespark.close_code', 'Close code used when auto-resolving', 'string', 'Solution provided'],
  ['sparespark.ci_classes', 'Comma-separated CI classes that are robots (empty = any CI)', 'string', ''],
  ['sparespark.timeout_ms', 'HTTP timeout for calls to SpareSpark, in milliseconds', 'integer', '15000'],
];
for (const [name, description, type, value] of props) {
  add('sys_properties', 'System Property', `prop:${name}`, name, {
    choices: '', description, ignore_cache: false, is_private: name !== 'sparespark.base_url' && /key|token/.test(name), name, read_roles: /key|token/.test(name) ? 'admin' : '', suffix: 'sparespark', type, value, write_roles: 'admin',
  });
}

// ---- script include ----
add('sys_script_include', 'Script Include', 'si:SpareSparkClient', 'SpareSparkClient', {
  access: 'package_private', active: true, api_name: 'global.SpareSparkClient', caller_access: '', client_callable: false,
  description: 'SpareSpark connector: outbound calls to the SpareSpark API and inbound webhook processing.', name: 'SpareSparkClient',
  script: src('script_include_SpareSparkClient.js'),
});

// ---- business rule ----
add('sys_script', 'Business Rule', 'br:send', 'SpareSpark: send robot incident', {
  abort_action: false, access: 'package_private', action_delete: false, action_insert: true, action_query: false, action_update: true,
  active: true, add_message: false, advanced: true, change_fields: false, client_callable: false, collection: 'incident',
  condition: 'new SpareSparkClient().shouldSend(current)', description: 'Sends incidents on robot CIs with a fault code to SpareSpark.',
  execute_function: false, filter_condition: '', is_rest: false, message: '', name: 'SpareSpark: send robot incident', order: 200,
  priority: 100, role_conditions: '', rest_method: '', rest_service: '', rest_variables: '', script: src('business_rule_send_to_sparespark.js'),
  template: '', when: 'async',
});

// ---- UI actions ----
const uiActions = [
  ['send', 'Send to SpareSpark', 'incident', 'sparespark_send', "current.correlation_display != 'SpareSpark' && !current.cmdb_ci.nil() && current.active == true", 'ui_action_send.js', 300],
  ['approve', 'SpareSpark: Approve part', 'incident', 'sparespark_approve', "current.correlation_display == 'SpareSpark' && current.active == true", 'ui_action_approve.js', 310],
  ['reject', 'SpareSpark: Reject part', 'incident', 'sparespark_reject', "current.correlation_display == 'SpareSpark' && current.active == true", 'ui_action_reject.js', 320],
  ['status', 'SpareSpark: Show status', 'incident', 'sparespark_status', "current.correlation_display == 'SpareSpark'", 'ui_action_refresh.js', 330],
  ['confirm', 'SpareSpark: Confirm repair', 'incident', 'sparespark_confirm', "current.correlation_display == 'SpareSpark' && current.active == true", 'ui_action_confirm_repair.js', 340],
  ['kb', 'Send to SpareSpark', 'kb_knowledge', 'sparespark_push_kb', "current.workflow_state == 'published'", 'ui_action_push_kb.js', 300],
];
for (const [key, name, table, actionName, condition, file, order] of uiActions) {
  add('sys_ui_action', 'UI Action', `ua:${key}`, name, {
    action_name: actionName, active: true, client: false, comments: '', condition, form_action: true, form_button: true, form_context_menu: false,
    form_link: false, hint: '', isolate_script: false, list_action: false, list_banner_button: false, list_button: false, list_choice: false,
    list_context_menu: false, list_link: false, list_save_with_form_button: false, messages: '', name, onclick: '', order,
    script: src(file), show_insert: false, show_multiple_update: false, show_query: false, show_update: true, table, ui11_compatible: true, ui16_compatible: true,
  });
}

// ---- Scripted REST API ----
const apiId = add('sys_ws_definition', 'Scripted REST API', 'ws:def', 'SpareSpark', {
  active: true, base_uri: '/api/global/sparespark', consumes: 'application/json', consumes_customizable: false, default_api_version: '',
  doc_link: '', enforce_acl: '', is_versioned: false, name: 'SpareSpark', namespace: 'global', produces: 'application/json',
  produces_customizable: false, service_id: 'sparespark', short_description: 'Receives SpareSpark workflow webhooks.',
});
add('sys_ws_operation', 'Scripted REST Resource', 'ws:events', 'SpareSpark/events', {
  active: true, consumes: 'application/json', consumes_customizable: false, default_operation_uri: '', enforce_acl: '',
  http_method: 'POST', name: 'events', operation_script: src('rest_events.js'), operation_uri: '/api/global/sparespark/events',
  produces: 'application/json', produces_customizable: false, relative_path: '/events', request_example: '',
  requires_acl_authorization: false, requires_authentication: true, requires_snc_internal_role: false, short_description: 'SpareSpark stage-change webhook',
  web_service_definition: { ref: apiId, display: 'SpareSpark' }, web_service_version: '',
});

// ---- assemble ----
const setId = id(`update_set:${VERSION}`);
const header = `<sys_remote_update_set action="INSERT_OR_UPDATE">${[
  field('application', 'global'), field('application_name', 'Global'), field('application_scope', 'global'), field('application_version', ''),
  field('collisions', ''), field('commit_date', ''), field('deleted', ''),
  field('description', 'SpareSpark connector for ServiceNow: sends robot incidents to the standalone SpareSpark service and writes its parts recommendations, approvals and dispatch updates back to the incident.'),
  field('inserted', ''), field('name', SET_NAME), field('origin_sys_id', ''), field('parent', ''), field('release_date', ''), field('remote_base_update_set', ''),
  field('remote_parent_id', ''), field('remote_sys_id', setId), field('state', 'loaded'), field('summary', ''), field('sys_class_name', 'sys_remote_update_set'),
  field('sys_created_by', 'admin'), field('sys_created_on', stamp), field('sys_id', setId), field('sys_mod_count', 0), field('sys_updated_by', 'admin'),
  field('sys_updated_on', stamp), field('update_set', ''), field('update_source', ''), field('updated', ''),
].join('')}</sys_remote_update_set>`;

const updates = records.map((r) => `<sys_update_xml action="INSERT_OR_UPDATE">${[
  field('action', 'INSERT_OR_UPDATE'), field('application', 'global'), field('category', 'customer'), field('comments', ''),
  field('name', `${r.table}_${r.sysId}`), field('payload', r.payload), field('payload_hash', ''),
  `<remote_update_set display_value="${escXml(SET_NAME)}">${setId}</remote_update_set>`,
  field('replace_on_upgrade', false), field('sys_created_by', 'admin'), field('sys_created_on', stamp), field('sys_id', id(`update:${r.table}:${r.sysId}`)),
  field('sys_mod_count', 0), field('sys_recorded_at', ''), field('sys_updated_by', 'admin'), field('sys_updated_on', stamp), field('table', ''),
  field('target_name', r.targetName), field('type', r.type), field('update_domain', 'global'), field('update_guid', ''), field('update_guid_history', ''),
  field('update_set', ''), field('view', ''),
].join('')}</sys_update_xml>`).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="${stamp}">\n${header}\n${updates}\n</unload>\n`;
mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', 'sparespark-servicenow-update-set.xml');
writeFileSync(out, xml);
console.log(`Wrote ${out} (${records.length} records)`);
