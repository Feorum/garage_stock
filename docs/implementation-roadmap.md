# Incremental implementation roadmap

The current increment extends the application foundation with server-authorized
orders and task execution. The approved catalogue remains closed, and financial
snapshots occupy separate Owner-only tables. Historical spreadsheet copies have
been analyzed privately and are supported by a dry-run preview tool.

## Rules to preserve

- Two application roles: Owner and Mechanic. Keep the existing `admin` role in
  the database and display it as Owner. Managers use Google Sheets, not app accounts.
- Valid Manager submissions publish automatically into a shared queue.
  Mechanics choose a vehicle order and claim one available authorized task.
- Owner orders for other clients are mandatory assignments to specific mechanics.
  They never enter the shared queue. Mechanics may report blockers or request
  reassignment; the Owner controls transfers.
- New work choices come from the closed catalogue: 19 work types and 17 vehicle
  groups. Unavailable combinations cannot become zero-priced or arbitrary work.
- Every price, amount, discount, tax value and financial file is Owner-only.
  Keep financial fields outside mechanic-readable tables, responses, events,
  caches, exports and Manager spreadsheets. The public catalogue has labels and
  operational availability only.

## Small implementation steps

| Step | Deliverable | Completion condition |
| --- | --- | --- |
| 1 — delivered | Sign-in, verified profile/role, workspace navigation, approved catalogue | Both role shells work; failed/unknown/inactive profiles do not open a workspace |
| 2 — delivered | Additive order/task schema, RLS and transactional operations | Mandatory assignment, shared claims, private financial access and retry invariants have isolated database checks |
| 3 — delivered | Owner creates, assigns and publishes an order; mechanic starts/blocks/completes | Another mechanic cannot access mandatory work; completion is recorded once |
| 4 — delivered | Manager shared queue and concurrent task claiming | Two mechanics claiming one task produce one winner; Owner registers Manager requests |
| 5 — next | Sanitized Google Sheets feed, authenticated import, stable IDs, retries | Dry-run preview/contract are prepared; live source and submission integration still required |
| 6 — partial | Owner operational reports and immutable rate snapshots | Snapshot reports are delivered; accounting, correction workflows and source-build automation remain later work |
| 7 | Pilot, legacy history, controlled cutover and installed-client update | Existing identities/job history reconcile; old clients cannot bypass ordered work |

Use versioned migrations rather than rerunning `schema.sql`. Preserve the old
sample catalogue IDs for legacy job references; do not repurpose them as the
approved list. Existing job rows have no proved historical price snapshot or
order boundary, so keep them explicitly as legacy until Owner-confirmed mapping.

When replacing the old direct job-entry workflow, close its write policies as
part of the coordinated database cutover. A new interface cannot by itself stop
an old cached client from using old database permissions. Keep rollback capable
of preserving new orders/completions rather than deleting them.

Decisions for the affected steps include whole-order versus per-task assignment,
workshop timezone, exact vehicle identification, commercial meaning of the source
rates, and any promotion/dependency rules. Actual rates and the source financial
workbook remain in restricted project notes, outside this public repository.

The supplied operational sheet uses a completed checkbox, not a submission flag.
Historical completed rows and financial extracts never enter the new queue
automatically. Planned date, deadline and server completion timestamps are distinct.
