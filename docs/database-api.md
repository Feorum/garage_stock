# Order workflow database API

Apply `supabase/migrations/202611120001_orders.sql` once after the original schema.
The migration is transactional and records version `202611120001` in
`garage_schema_migrations`. It adds `profiles.active` without changing existing
identities, retains the four legacy tables, and revokes old direct job writes.

Before applying, capture and verify restoration of existing application data.
The migration contains operational catalogue labels/availability only; import
actual approved rates separately through a privileged private process.
After an API-based migration, run `notify pgrst, 'reload schema';`.

## Authenticated RPCs

Actors come from `auth.uid()` and must have an active supported profile. Keep
the existing `admin`/`mechanic` roles. Client-supplied identities never establish
the acting user. Private mutation helpers cannot be executed by browser roles.

| RPC | Parameters and behavior |
| --- | --- |
| `garage_list_orders()` | Safe order/task JSON, filtered by caller. Owner sees all orders; Mechanics see published Manager work and their authorized assignments/contributions. No financial fields. |
| `garage_staff()` | Owner-only active mechanic ID/name directory. |
| `garage_create_order(...)` | Owner-only atomic publication; arguments below. |
| `garage_team_action(...)` | Join, start, pause, resume, confirm, leave, add a note, change a roster member. |
| `garage_task_action(...)` | Installed-client compatibility for single-mechanic actions and Owner cancellation. |
| `garage_order_action(...)` | Owner-only close or cancellation of remaining work. |
| `garage_order_financials(order_id)` | Owner-only snapshot amounts. Missing rates produce `needs_pricing` and unknown totals rather than zero. |

Create arguments:

```text
p_vehicle text
p_vehicle_group_code text
p_source text                 owner | manager
p_tasks jsonb                 [{work_code, assigned_to?, instructions?, options?}]
p_request_id uuid
p_instructions text = ''
p_due_date date = null
p_priority text = 'normal'     normal | high | urgent
p_vin text = ''
p_colour text = ''
p_manager_label text = ''
p_planned_date date = null
```

An Owner task requires an active mechanic in `assigned_to`. A Manager task must
not contain a mandatory assignee. `W19` requires exactly an approved
`options.tint_percent` of 5 or 15; other works use empty options. Extra financial
keys and work/group combinations outside the approved list are rejected.

Task-action arguments:

```text
p_task_id uuid
p_action text                 start | block | resume | complete | release | cancel | reassign
p_expected_version integer
p_request_id uuid
p_note text = ''
p_assignee uuid = null
```

Migration `20261118000001_team_workflow.sql` adds one participation history per mechanic and keeps a single completion per catalogue task. Existing single-mechanic jobs retain their identity, timestamps and private rate snapshot. The old single-person action accepts valid solo work, including retries from an older app. A grouped task requires the team API for mechanic and roster actions.

### Team actions

```text
garage_team_action(
  p_task_id uuid, p_action text, p_expected_version integer, p_request_id uuid,
  p_note text = '', p_mechanic_id uuid = null, p_replacement_id uuid = null
)
```

- `join` starts the caller on published Manager work. `start` starts the caller’s private assignment or named replacement. More than one mechanic can join shared work until the first confirmation.
- `block` records a reason and pauses that participant. `resume` resumes them. The task is blocked when every remaining unconfirmed person is blocked. A blocked person resumes before confirming.
- `confirm` records the caller’s contribution. The first confirmation freezes self-joining and self-withdrawal. The last required confirmation creates one permanent completion. One service and its original price count once for the order.
- `leave` returns a shared place before sign-off and requires a reason. The last such departure makes the task available again. Private assignees request relief from the Owner.
- The Owner uses `assign` with `p_mechanic_id` for a private task. `remove` and `replace` take the affected person and a reason. Replacement also takes `p_replacement_id`; the replacement starts and confirms personally. After sign-off begins, excusing an unconfirmed person may finish the task when every remaining participant has personally confirmed. A confirmed contribution remains in the roster.
- `note` appends an operational note for the Owner and current team. A nonparticipant on a published Manager order can see the team’s names and statuses. Private task details, blockers and event notes stay with the Owner and authorized participants.
- The list embeds `participants`, `my_status`, `roster_locked`, `can_see_notes` and `notes` in each task. Participant statuses are `assigned`, `working`, `blocked` and `confirmed`. The aggregate task status keeps its existing vocabulary.
- Completion feedback on the working copy names confirmed people on one line per task. An order with a partly confirmed task keeps the checkbox clear. Owner-attested omitted work explicitly records its origin.

Order actions take `p_order_id`, `p_action` (`close`/`cancel`),
`p_expected_version`, `p_request_id`, and optional `p_note`. Closing requires
completed work and no unfinished tasks. Cancellation preserves completions and
cancels remaining work with a recorded reason.

All mutations use caller-scoped request IDs and compare the original payload.
Retry an ambiguous response with the same ID and arguments. A changed payload
with that ID is rejected. Locks consistently acquire the parent order before
its task rows. Compatible simultaneous joins or confirmations can both succeed.
The server checks membership and roster state again while holding those locks.
A racing join either joins before the first confirmation or receives a closed
roster result. Profile locks protect against deactivation during assignment.

## Vehicle handoff

`garage_list_orders()` includes `vehicle_workflow` for each visible visit. Its
counts and handoff checklist respect the caller's task visibility.
The inline boards use `garage_check_work(p_task_id,p_request_id)` to record the
signed-in mechanic on a visible service. Two mechanics can confirm the same service
with one completion and one pay item. The operation can be retried with the same
request ID. The order exposes the confirmed executors and their display colors.

A contributor calls `garage_submit_work(p_order_id,p_expected_version,p_request_id,p_note)`
to submit the vehicle directly from the list, including partially finished work.
The database freezes mechanic edits during review. The Owner can return the
vehicle for more work or close it when it has at least one completion and no
unfinished services. Cached clients retain the `garage_vehicle_action` API.
Board updates signal authorized recipients to refresh their own order view.

On an open visit, `garage_uncheck_work(p_task_id,p_expected_version,p_request_id)`
withdraws the caller’s own checklist confirmation. Use the task’s
`can_uncheck_work` flag to enable the control. Replaying the same request
returns its original result. A stale task version requires a refresh.
The last withdrawal reopens the service and removes its current completion
from reports. An Owner’s existing payroll allocation and its audit history
survive a correction and a later recheck.

## Owner calculations

`garage_owner_review_prices(p_order_ids)` accepts up to 100 order IDs per call.
Each non-cancelled service appears once. The review card uses `effective_kopeks`,
the latest agreed customer price, including explicit zero for a gift. Clearing an
adjustment restores the original catalogue rate. History uses that original rate
from `net_kopeks`. An unknown amount is null in either field.

The private order quote and detail show the agreed customer price for each job.
`garage_save_task_pricing` saves a versioned override in integer kopeks and a private
Owner comment. An explicit zero makes the customer charge zero. Clearing the
override restores the original rate. Unpriced work stays unknown until priced.
For an eligible completed job, the order financials include the saved allocation,
the suggested equal split and the mechanics eligible for payment. The Owner
can edit a single job using this order-scoped response.

`garage_pay_save_amounts(p_task_id,p_expected_version,p_amounts,p_reason,p_zero_confirmed,p_request_id)`
accepts one `{mechanic_id, kopeks}` entry per selected mechanic. The server
stores each exact amount and sums them to obtain the job payout. A customer
discount or gift has no effect on this amount. Existing allocations are read
from their saved kopeks. The original allocation RPC remains available to
previously installed clients.

`garage_owner_gift_offer` reads the workshop's privately configured promotion.
The Owner can accept or decline it in the order editor. Accepting calls
`garage_save_order_with_gift`, which verifies eligibility and records both the
service and its zero customer charge in one transaction. Existing task
assignments, original rate, pay proposal and private memo are preserved.
Mechanic RPCs and spreadsheet feedback carry only operational information.

## Owner completion acts

`garage_act_get(p_order_id)` reads a closed order’s saved act metadata or suggests the next number and the Minsk closure date. `garage_act_template()` reads the private prepared Word package for an active Owner. The client fills the vehicle, VIN, completed jobs, their agreed BYN prices, and the amount in figures and Russian words before submitting the issue request.

`garage_act_save(p_order_id,p_number,p_contract_number,p_contract_date,p_act_date,p_expected_version,p_expected_order_version,p_expected_amounts,p_vin)` records an issuance or a versioned metadata correction. It compares the order version and the amount in kopeks for each completed task ID with the values used to generate the document. A change requires the Owner to review the updated order. Zero-priced completed work appears on the act. An unknown customer price must be resolved before issuance.

The first component of the number is the cumulative order serial. The second is the two-digit month of the act date. Opening a form leaves the serial available. Concurrent claims must use different serials, including across months and years. The same order keeps its issued number on retry and later downloads.

### Install the private Word master

Run `python scripts/prepare-act-template.py SOURCE.docx MASTER.owner-only.docx` on a trusted workstation. Prepare a private JSON file with `customer_name`, `contractor_name`, `contract_number`, `contract_date` (ISO date), and `reserved_numbers` (a list of previously issued `N/MM` values). Use the parties printed in that form. Keep these files outside the public build.

Run `python scripts/act_seed.py MASTER.owner-only.docx config.private.json PRIVATE_DIRECTORY`. Apply the generated `parts.owner-only.sql` to the database, then apply `activate.owner-only.sql`. Activation checks the SHA-256 of the entire template before enabling the form. Reapplying the same seed preserves issued serials. All installer inputs, company details, historical numbers and generated acts stay private.

## Financial import and confidentiality

Owner-only tables are `garage_price_lists`, `garage_price_matrix`, and
`garage_task_financials`. Operational tables and RPC payloads have no amount
columns. Direct financial reads require active Owner status; Mechanics and
anonymous clients cannot retrieve values, including through the financial RPC.

An approved list has a source fingerprint, BYN currency, explicit
effective date and status. Matrix keys are list ID, approved vehicle group and
work code. Load numeric source cells only; blank/dash combinations are excluded
from operational availability and never become zero-priced entries.

At order publication, the server freezes the applicable catalogue amount per task.
Used list versions are protected against repricing.
Missing rates are represented explicitly as unknown. Source amounts are recorded
rates, not proof of customer revenue, actual payments, profit or mechanic wages.
Raw financial sources, seed SQL and extracted matrix values must remain outside
the public repository/build.

## Scope of this increment

Orders keep visit-specific vehicle/VIN/colour/group snapshots. They do not merge
visits on a VIN or plate. Legacy jobs retain their original IDs and have no
invented order linkage or historical price snapshot.

Manager/shared orders can be registered by the Owner or by a registered
spreadsheet source through migration `202611120002` and its authenticated Edge
endpoint. Pending source amendments are version-checked; work already changed
in the program requires Owner review. See [Manager API](manager-api.md).
Migration `202611130001` reads the existing layout from the approved operational
copy, reserves checked history and keeps ambiguous rows in Owner review. Its
private reader needs one-time Owner Google authorization before the minute
trigger runs. Valid closed-catalogue scope publishes only after two unchanged
reads at least one minute apart. General completion reversals, full accounting/payroll
and customer invoicing remain later increments. Checked historical rows never
become active tasks, and copy-only work does not edit or connect the original.

## Owner interpretation and editing

Migration `20261115015355_owner_manager_order_editing.sql` adds a private Manager
intake beside published orders. It records all substantive unfinished source
requests, including free-text-only requests and rows with incomplete identity.
The original and latest raw source text stay separate. Duplicate occurrences
retain all raw entries and must be clarified before publication. Source row
numbers are provenance and display ordering, never durable order identity.

The service-only `garage_capture_manager_rows(source_id, lease_token,
expected_version, rows)` checks the active import lease and version before
capturing observations. A valid date/VIN source key identifies a draft; otherwise
a content hash excluding position and weekday identifies the observation.
Capture leaves importer CAS state unchanged and returns Owner-managed keys and
current-snapshot row numbers so the reader can suppress its own obsolete work.

Owner RPCs use the same selected catalogue works and order fields as creation:

| RPC | Behavior |
| --- | --- |
| `garage_manager_intakes()` | Owner-only original/latest requests, source provenance, version, suggested selections, linked order and interpretation state. |
| `garage_publish_manager_intake(p_intake_id, p_expected_version, p_order, p_tasks, p_request_id)` | Publish a complete interpreted Manager request with at least one catalogue task, preserving the original text privately. |
| `garage_edit_order(p_order_id, p_expected_version, p_order, p_tasks, p_request_id)` | Edit an open order. Existing tasks are supplied with `id`; new tasks omit it. |
| `garage_quote_order(p_vehicle_group_code, p_tasks, p_order_id = null)` | Owner-only preview using frozen retained snapshots and active approved rates for new work. Missing rates remain unknown. |

`p_order` contains `vehicle`, `vehicle_group_code`, `vin`, `colour`,
`manager_label`, `instructions`, `planned_date`, `due_date` and `priority`.
`p_tasks` contains `id?`, `work_code`, `options`, `instructions` and
`assigned_to?`. Manager tasks remain shared; Owner assignments require an active
mechanic. Raw intake text never automatically populates financial values, work
choices or completion. Commercial text is stripped from suggested operational
instructions and rejected if submitted to the published instruction fields.

Unchanged tasks retain their IDs and frozen prices. Removed or replaced pending
work is cancelled and retained in history; replacement work receives a new task
and snapshot. Started, blocked and completed tasks must remain unchanged, and
their vehicle-group pricing context is frozen. Completed ledger entries and
financial snapshots are never deleted or repriced by editing.

Owner saves are version-checked and request-ID idempotent. They reserve both
original and corrected source identities, and mark the order as Owner-managed.
Migration `20261115022416_owner_intake_identity_guards.sql` retains every prior
Owner date/VIN identity privately, including identities later changed or cleared.
The backfill also recovers earlier interpretations from successful request receipts.
Historical aliases remain reserved against automatic submissions and other Owner
orders; missing or expired capture leases are rejected explicitly.
A source-locked service guard prevents a later or previously captured spreadsheet
submission from overwriting or duplicating that order, even with a new external
ID. Previously recorded receipts remain exactly replayable. Source polls update
the private latest observation without changing Owner decisions. Missing source
rows never cancel application work.

## Omitted completed work and Manager comments

The `20261116203155`, `20261116203249` and `20261116203339` migrations add an
independent sanitized Manager comment channel, source-bound completion feedback
and audited recording of omitted, already-performed work. Apply them in order
before the corresponding Edge and frontend release.

Owner-only `garage_record_omitted_completion(order_id,expected_version,work_code,
options,mechanic_id,completed_at,note,request_id)` adds one available catalogue
task and completion to an open or closed order. A reason and recorded time are
required. When exact physical time is unknown, use the Owner confirmation time
and say so in the reason. Existing tasks, completions, close time and snapshots
remain unchanged. The added work receives a new snapshot at the current approved
rate; this does not recreate an unproven historical price. The source Owner,
version and retry checks prevent unauthorized or duplicate corrections.

Manager comments update independently without incrementing the operational
order version. The existing permission-filtered order list exposes only safe
comments and their timestamp. Issued sheet feedback blocks remain in a private,
RLS-enabled table inaccessible to either browser role or direct service access;
the lease-scoped function is the only feedback interface.

Ordinary order JSON contains only safe source name/ID/row metadata for table
ordering. Private original text and quote amounts require Owner authorization;
Mechanics receive neither. Run isolated synthetic checks with
`bash tests/run-owner-edit-tests.sh` after preloading the pinned PostgreSQL image.
