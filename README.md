# SpareSpark

When an industrial robot fails, the exact OEM spare part is often out of stock, obsolete or superseded. The knowledge of what else works lives in technician notes, old work orders, maintenance history and the knowledge base, not in the inventory system.

SpareSpark is a standalone maintenance application that finds the right part anyway. A Triage Agent identifies the failed part from the fault code, a Spare Parts Agent checks inventory and, when there is no exact match, mines maintenance knowledge for superseded or substitute parts with cited evidence, a Logistics Parts Coordinator approves the substitute, and a Resolution Agent reserves the part and dispatches the technician with installation notes.

SpareSpark has no dependency on ServiceNow. An optional **ServiceNow plugin** (`servicenow-plugin/`) connects it to a ServiceNow instance.

## Quick start

Requires Node.js 22.13 or later. No other dependencies are required.

```bash
npm install        # optional: installs the Claude SDK for LLM explanations
npm start          # http://localhost:3000
npm test           # 15 tests: engine, all three demo flows, rejection, procurement, ServiceNow plugin contract
```

Or with Docker: `docker build -t sparespark . && docker run -p 3000:3000 -v sparespark:/data sparespark`.

The database (SQLite, `data/sparespark.db`) is created and seeded on first start.

## Demo (under 3 minutes)

1. **Assets Console**: four robots (AdamNow, EveThen, BobAfter, JillBefore).
2. **Run Happy Flow**: AdamNow faults with `J3-OVERCURRENT`. Triage finds `SM-400-J3`, inventory has 2 in bin A-14, one is reserved, M. Ortiz is dispatched, the simulated repair is confirmed, the incident resolves with First-Time Fix = Yes and SLA = Met.
3. **Run Human-in-the-Loop Flow**: EveThen faults with `W-GEAR-BACKLASH`. `GR-220-W` is obsolete with 0 on hand. The Spare Parts Agent searches 10 maintenance records, matches entries written as "wrist gearbox", "GR220W reducer" and "wrist red. W", and recommends `GR-220-W2` as a **Documented Supersession** citing TN-0042, WO-1187, MH-2207 and KB0010334, with the two-shim installation note. It lists `GR-225-W` as a lower-confidence **Potential Alternative** and excludes `GR-230-W` because TN-0061 says it does not fit. The workflow pauses.
4. **Coordinator** tab: chat with the Spare Parts Agent, then **Select this part**. The workflow resumes, reserves one GR-220-W2 from bin B-12, dispatches the technician with the shim instructions, and resolves.
5. **Run Procurement Flow**: simulates a stockout of `SM-400-J3` and faults AdamNow. With no part and no substitute in stock, the Procurement Agent drafts a purchase order (2 x SM-400-J3 from Apex Robotics Supply, $3,700) and the repair pauses for the Procurement Coordinator. Approve it from the popup or the **Procurement** tab; the simulated vendor ships it a few seconds later with a tracking number. Click **Receive**: stock is added to bin A-14, one unit is reserved, and the repair continues to dispatch and resolution. Running the happy flow three times gets you to the same place without the simulated stockout.
6. **Dashboard**: open incidents, first-time fix rate, SLA attainment, parts recovered by AI, plus procurement KPIs (open POs, awaiting delivery, spend, average PO cycle time, on-time delivery, stockouts and repairs unblocked by procurement).
7. **Reset Demo** restores robots, inventory, incidents and purchase orders. Knowledge records are kept.

## How recommendations work

The Spare Parts Agent (`server/knowledge.js`) does not contain the demo answer. It:

1. Looks up the requested part in inventory. Free stock on a non-obsolete part is an **Exact** match.
2. Otherwise searches all knowledge records for the part number written loosely (`GR-220-W`, `GR220W`), the part family (`GR-220 series`), bare revisions in context (`W2 revision`), component synonyms (`wrist gearbox`, `wrist red.`), and other inventory parts of the same kind on the same robot model.
3. Extracts candidate part numbers from each relevant sentence, resolves them against inventory, and classifies the relationship from the sentence: supersession, successful swap, tentative use, or contradiction ("does not fit").
4. Classifies each candidate: **Documented Supersession** (a KB article or inventory record documents it), **Potential Alternative** (field evidence only), **Insufficient Evidence** (contradicted or unsupported). No numerical compatibility percentages.
5. Ranks by class, free stock, model compatibility listed in inventory, then number of supporting sources, and quotes installation notes from the supporting records.

Every claim carries the record it came from. A test changes the stock levels and checks the recommendation follows the data.

**Optional Claude layer.** With `ANTHROPIC_API_KEY` set and `npm install` run, Claude (`claude-opus-5-5` by default, `SPARESPARK_MODEL` to change) writes the explanation and coordinator chat answers from the retrieved evidence only. Answers that mention a part or source not in the evidence, or a percentage, are discarded in favor of the deterministic text. Without a key, everything works in deterministic retrieval mode. The LLM path has not been run against the live API in this build.

## Workflow

```
Fault Detected -> Triage -> Inventory Search -> (Knowledge Search -> Awaiting Human Approval)
  -> (Procurement Requested -> Awaiting PO Approval -> Awaiting Delivery -> Parts Received)
  -> Part Reserved -> Technician Dispatched -> Repair in Progress -> Resolved        (or Failed / Needs Attention)
```

Procurement starts when neither the failed part nor an approved substitute has free stock, including after the coordinator rejects the last candidate. The Procurement Agent orders the failed part, or its documented successor when the part is obsolete, from the part's vendor at its reorder quantity. Nothing is ordered until a person approves the PO. Receiving adds the stock and reserves a unit for the waiting incident in the same step.

Stages are persisted on the incident and the workflow resumes after a restart. Every agent decision and tool call is written to the event log. Reservations are transactional with one reservation and one work order per incident, so duplicates are prevented. Rejecting a recommendation offers the next candidate, or moves the incident to Failed / Needs Attention when none is left.

Demo-only behavior (the scenario buttons, the simulated stockout, vendor shipment and repair confirmation, reset) lives in `server/demo.js` and is applied only to incidents created by the demo buttons. `SPARESPARK_DEMO=off` disables it. Real incidents wait for `POST /api/incidents/:id/confirm-repair`.

## API

All endpoints are JSON under `/api`. Set `SPARESPARK_API_KEY` to require an `X-API-Key` header.

| Method | Path | Purpose |
|---|---|---|
| POST | `/incidents` | Report a fault: `{ robot_name, fault_code, external_system?, external_ref?, external_number? }`. Idempotent per `external_system` + `external_ref`. |
| GET | `/incidents`, `/incidents/:id` | List, or one incident with progress, recommendation, work order and event log. `:id` can be the numeric id, SpareSpark number or external number. |
| POST | `/incidents/:id/approve` | `{ part_number?, approver?, comment? }` approves the recommended part or another candidate. |
| POST | `/incidents/:id/reject` | `{ part_number?, approver?, comment? }` |
| POST | `/incidents/:id/confirm-repair` | `{ success, notes?, confirmed_by? }` |
| GET/POST | `/incidents/:id/chat` | Coordinator chat with the Spare Parts Agent. |
| POST | `/recommendations` | Stateless lookup: `{ part_number, robot_model? }`. |
| GET/POST | `/knowledge` | List or upsert knowledge records (`kb_article`, `work_order`, `tech_note`, `maintenance_history`). |
| GET/POST | `/robots` | List or upsert robots (e.g. from a CMDB). |
| GET | `/parts`, `/fault-codes`, `/work-orders`, `/metrics`, `/notifications`, `/events`, `/webhooks` | Reference data, KPIs, pending approvals, logs. |
| GET/POST | `/purchase-orders` | List POs (`?status=`), or create a replenishment PO: `{ part_number, qty }`. |
| POST | `/purchase-orders/:id/approve`, `/reject` | `{ approver?, comment? }` |
| POST | `/purchase-orders/:id/ship` | Vendor or ERP shipment notice: `{ tracking_ref? }` |
| POST | `/purchase-orders/:id/receive` | Goods receipt: `{ qty?, received_by? }` adds stock and resumes the waiting repair. |
| GET | `/vendors` | Vendors and lead times. |
| POST | `/demo/happy`, `/demo/hitl`, `/demo/procurement`, `/demo/reset` | Demo controls. |

Webhooks: when `SPARESPARK_WEBHOOK_URL` is set, every stage change on an incident created by an external system is POSTed there as `{ event, sent_at, incident }`, with `X-SpareSpark-Token` and optional basic auth.

See `.env.example` for all settings.

## ServiceNow plugin

See [servicenow-plugin/README.md](servicenow-plugin/README.md). In short: import one update set, set `sparespark.base_url` and `sparespark.api_key`, and incidents on robot CIs with `Fault: <CODE>` in the short description are sent to SpareSpark automatically. Recommendations with evidence, dispatch details and resolution arrive back as work notes, and the incident form gets Approve / Reject / Confirm repair buttons.

## Layout

```
server/        index.js, app.js (HTTP API), db.js + seed.js (SQLite), knowledge.js (Spare Parts engine),
               workflow.js (agents + state machine), llm.js (optional Claude), demo.js, integrations.js (webhooks)
public/        Console: assets, workflow popup, coordinator chat/approval, dashboard, knowledge, integrations
servicenow-plugin/  src/ scripts, build-update-set.js, dist/ update set XML
test/          node:test suites
```

## Limits

Out of scope, as in the PRD: real robot telemetry, ERP/procurement integration, mobile app, production security hardening. The console has no user login (the API key protects the API). Knowledge search is lexical with synonym tables, which suits short technician text; a vector index could be added behind `recommend()` for larger corpora.
