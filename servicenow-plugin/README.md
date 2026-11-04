# SpareSpark connector for ServiceNow

Connects a ServiceNow instance to a running SpareSpark service. SpareSpark keeps running and deciding on its own; ServiceNow sends it robot incidents and gets the results back on the incident.

## What it adds

All records are in the **global** scope and ship as one update set (`dist/sparespark-servicenow-update-set.xml`, rebuilt with `npm run build:servicenow`).

| Record | Name | What it does |
|---|---|---|
| Script Include | `SpareSparkClient` | All REST calls to SpareSpark, plus webhook processing. |
| Business Rule (incident, async, insert/update) | SpareSpark: send robot incident | Sends an incident to SpareSpark when it has a CI and a fault code, and is not linked yet. |
| UI Action (incident) | Send to SpareSpark | Manual send or retry. |
| UI Action (incident) | SpareSpark: Approve part | Approves the Spare Parts Agent's recommendation; the workflow resumes in SpareSpark. |
| UI Action (incident) | SpareSpark: Reject part | Rejects it; SpareSpark proposes the next candidate or flags Needs Attention. |
| UI Action (incident) | SpareSpark: Show status | Shows the current stage, recommendation and evidence. |
| UI Action (incident) | SpareSpark: Confirm repair | Technician confirmation; SpareSpark resolves and the incident auto-resolves. |
| UI Action (kb_knowledge) | Send to SpareSpark | Makes a published KB article searchable by the Spare Parts Agent. |
| Scripted REST API | SpareSpark, `POST /events` | Receives SpareSpark stage webhooks and writes work notes, sets the incident In Progress, and resolves it at the end. |
| System Properties | `sparespark.*` | `base_url`, `api_key`, `inbound_token`, `auto_resolve`, `close_code`, `ci_classes`, `timeout_ms`. |

The link is kept in the standard `correlation_id` (SpareSpark number) and `correlation_display` (`SpareSpark`) fields, so no tables or columns are added.

## Install

1. In ServiceNow: **System Update Sets > Retrieved Update Sets > Import Update Set from XML**, upload the XML, open "SpareSpark Connector 1.0.0", **Preview**, then **Commit**.
2. Set the properties (System Properties, filter `sparespark`):
   - `sparespark.base_url`: where SpareSpark runs, e.g. `https://sparespark.example.com`. The instance must be able to reach it (use a MID server REST endpoint if it is on-premises).
   - `sparespark.api_key`: same value as `SPARESPARK_API_KEY` on the SpareSpark server.
   - `sparespark.inbound_token`: a random secret, also set as `SPARESPARK_WEBHOOK_TOKEN` on SpareSpark.
   - Optional `sparespark.ci_classes`, e.g. `cmdb_ci_equipment`, to only send incidents on robot CIs.
3. Open **System Web Services > Scripted REST APIs > SpareSpark** and copy the resource path of `events` (the namespace depends on your instance; the update set proposes `/api/global/sparespark`).
4. On SpareSpark set:
   ```
   SPARESPARK_WEBHOOK_URL=https://<instance>.service-now.com<events path>
   SPARESPARK_WEBHOOK_TOKEN=<same as sparespark.inbound_token>
   SPARESPARK_WEBHOOK_USER=<integration user>        # the resource requires authentication
   SPARESPARK_WEBHOOK_PASSWORD=<password>
   ```
   Give the integration user the `itil` role (it writes incident work notes).
5. Robot names in SpareSpark must match the CI names, or push them with `POST /api/robots` including `external_ci_id` (CI sys_id).

## Use

Create an incident with the robot as Configuration item and `Fault: W-GEAR-BACKLASH` in the short description (or a `u_fault_code` field if you add one). Within seconds the work notes show triage, the inventory result and, when there is no exact match, the recommended substitute with its evidence and installation notes. Approve from the incident form or from the SpareSpark coordinator view; either works, and the other side sees the result.

## Tested, and not tested

`test/servicenow-plugin.test.js` runs these exact scripts against a real SpareSpark server with a mock of the Glide APIs they use (`gs`, `GlideRecord`, `sn_ws.RESTMessageV2`, the Scripted REST request/response), covering send, webhook notes, approval, repair confirmation, auto-resolve and token checks.

They have **not** been run on a real ServiceNow instance. Things to check on first install: that the update set previews without errors, the Scripted REST namespace/path, the `close_code` value your instance uses (`sparespark.close_code`), and that `gs.getProperty` returns the API key (the key properties are private strings readable by admin only).
