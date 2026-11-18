# Incremental implementation roadmap

The current increment extends the application foundation with server-authorized
orders and task execution. The approved catalogue remains closed, and financial
snapshots occupy separate Owner-only tables. Historical spreadsheet copies have
been analyzed privately. The Manager integration now reads a full operational
copy in the existing table layout; the original remains untouched.

## Team-workflow release

The replacement Preact frontend, team-task database API and private pay review are implemented together. The Owner's shift, private assignments, Manager queue, confirmation history, Minsk-based reports and editable ledger use the same work-order identities. Operational completion and Owner compensation are independent. Deployment and the workshop acceptance run are tracked per release.

A later increment can populate the Owner's existing Word form from a completed order. Use the order and task IDs, the recorded completion and dated participant history as inputs. Field mapping, repeated rows and document output depend on the supplied example templates and a correctly filled example.

## Rules to preserve

- Two application roles: Owner and Mechanic. Keep the existing `admin` role in
  the database and display it as Owner. Managers use Google Sheets, not app accounts.
- Valid Manager submissions publish automatically into a shared queue.
  Mechanics choose a vehicle order and may work together on an available task until sign-off begins.
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
| 4 — delivered | Manager shared queue and concurrent task claiming | Original single-claim workflow delivered, then extended to personal team participation and unanimous completion |
| 5 — delivered | Existing-layout working copy, catalogue parsing, automatic requests, private identities/retries, Owner review and completion feedback | Manager input stays unchanged; upgraded authorized sync writes verified results to I/J |
| 6 — partial | Owner interpretation/editing, compact source-ordered rows, operational reports, immutable rate snapshots and automatic website deployment | Owner corrections, snapshot reports and tested releases from main are delivered; accounting remains later work |
| 7 | Pilot, legacy history, controlled cutover and installed-client update | Existing identities/job history reconcile; old clients cannot bypass ordered work |

Use versioned migrations rather than rerunning `schema.sql`. Preserve the old
sample catalogue IDs for legacy job references; do not repurpose them as the
approved list. Existing job rows have no proved historical price snapshot or
order boundary, so keep them explicitly as legacy until Owner-confirmed mapping.

Legacy direct job writes are revoked by the order migration and tested. A new
interface alone cannot stop an old cached client using old permissions. Keep rollback capable
of preserving new orders/completions rather than deleting them.

The workshop uses Europe/Minsk. Remaining business decisions include the commercial interpretation of source rates and any promotion or dependency rules. Actual rates and the source financial
workbook remain in restricted project notes, outside this public repository.

The supplied operational sheet uses a completed checkbox, not a submission flag.
Valid unfinished requests from the connected working copy are imported automatically;
completed history and financial extracts never become pending work. Ambiguous
model/work text waits for Owner review. Work selections are moving to the closed
catalogue inside that same layout. Planned date, deadline and actual completion
timestamps remain distinct. Managers need neither app accounts nor a Submit step.
Changes made to the original after copying are not automatically mirrored.

Managers may keep writing free-form requests. The Owner interprets these in the
application using the regular order form and catalogue. Original observations
remain private, later polls preserve Owner decisions, and catalogue selection
calculates the private amount. The catalogue has no separate navigation section.

See [Manager API](manager-api.md) and [private reader setup](../integrations/existing-google-sheet/README.md).
The sync script is a standalone Owner-private Google project. The upgraded
version needs edit authorization to return completion results to I/J of the
working copy; it never changes the original or makes either workbook public.
The Google connector cannot deploy or authorize Apps Script triggers, so one-time
Owner authorization remains required. The app distinguishes a connected source
from its first successful read. Row deletion does not cancel work and a source
checkbox never impersonates mechanic completion.
