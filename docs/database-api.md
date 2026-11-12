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
| `garage_task_action(...)` | Atomic start/block/resume/complete/release/cancel/reassign with version and retry checks. |
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

Starting a Manager task claims it; starting Owner work requires its mandatory
assignee. Only its current worker can perform mechanic actions. Owner transfers
require a reason and an active recipient. Pending Manager tasks remain freely
claimable; transfer applies only to work already in progress or blocked and
keeps the mandatory assignee null. Returning to the queue applies to shared work,
not mandatory assignments. Completion creates one immutable ledger record.

Order actions take `p_order_id`, `p_action` (`close`/`cancel`),
`p_expected_version`, `p_request_id`, and optional `p_note`. Closing requires
completed work and no unfinished tasks. Cancellation preserves completions and
cancels remaining work with a recorded reason.

All mutations use caller-scoped request IDs and compare the original payload.
Retry an ambiguous response with the same ID and arguments. A changed payload
with that ID is rejected. Locks consistently acquire the parent order before
its task rows; simultaneous claims have one winner. Actor/assignee profile locks
prevent concurrent deactivation from creating stranded assignments.

## Financial import and confidentiality

Owner-only tables are `garage_price_lists`, `garage_price_matrix`, and
`garage_task_financials`. Operational tables and RPC payloads have no amount
columns. Direct financial reads require active Owner status; Mechanics and
anonymous clients cannot retrieve values, including through the financial RPC.

An approved list has a source fingerprint, BYN currency, its VAT rate, explicit
effective date and status. Matrix keys are list ID, approved vehicle group and
work code. Load numeric source cells only; blank/dash combinations are excluded
from operational availability and never become zero-priced entries.

At order publication, the server freezes the applicable net amount and tax
calculation per task. Used list versions are protected against repricing.
Missing rates are represented explicitly as unknown. Source amounts are recorded
rates, not proof of customer revenue, actual payments, profit or mechanic wages.
Raw financial sources, seed SQL and extracted matrix values must remain outside
the public repository/build.

## Scope of this increment

Orders keep visit-specific vehicle/VIN/colour/group snapshots. They do not merge
visits on a VIN or plate. Legacy jobs retain their original IDs and have no
invented order linkage or historical price snapshot.

Manager/shared orders can currently be registered by the Owner. Live Google
ingestion, versioned source amendments, automatic promotion rules, reopening or
voiding completed work, full accounting/payroll and customer invoicing are later
increments. The supplied historical spreadsheets are private references and
dry-run inputs, not an instruction to create active tasks automatically.
