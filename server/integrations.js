// Outbound webhooks. Any external system (ServiceNow plugin, Teams bot, ERP) that
// created an incident gets stage-change callbacks. Configure with:
//   SPARESPARK_WEBHOOK_URL      e.g. https://<instance>.service-now.com/api/x_spsk_sparespark/sparespark/events
//   SPARESPARK_WEBHOOK_TOKEN    shared secret, sent as X-SpareSpark-Token
//   SPARESPARK_WEBHOOK_USER / SPARESPARK_WEBHOOK_PASSWORD   optional basic auth (ServiceNow integration user)
// Only incidents with external_system set are sent, so demo/native incidents stay local
// unless SPARESPARK_WEBHOOK_ALL=true.

import { now } from './db.js';

export function makeWebhookSender(db, serialize) {
  return function onChange(incident, event) {
    const url = process.env.SPARESPARK_WEBHOOK_URL;
    if (!url) return;
    if (!incident.external_system && process.env.SPARESPARK_WEBHOOK_ALL !== 'true') return;
    const body = JSON.stringify({ event, sent_at: now(), incident: serialize(incident.id, { compact: true }) });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.SPARESPARK_WEBHOOK_TOKEN) headers['X-SpareSpark-Token'] = process.env.SPARESPARK_WEBHOOK_TOKEN;
    if (process.env.SPARESPARK_WEBHOOK_USER) {
      headers.Authorization = `Basic ${Buffer.from(`${process.env.SPARESPARK_WEBHOOK_USER}:${process.env.SPARESPARK_WEBHOOK_PASSWORD || ''}`).toString('base64')}`;
    }
    const log = db.prepare('INSERT INTO webhook_log(incident_id, event, url, status, error, created_at) VALUES (?,?,?,?,?,?)');
    fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
      .then((res) => log.run(incident.id, event, url, res.status, res.ok ? null : `HTTP ${res.status}`, now()))
      .catch((err) => log.run(incident.id, event, url, null, String(err.message || err), now()));
  };
}
