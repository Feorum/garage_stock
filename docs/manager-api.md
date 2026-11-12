# Manager spreadsheet submission API

Migration `202611120002_manager_submissions.sql` follows the existing order
migration. It adds source registration, immutable submission receipts, stable
external-order/task bindings and revision history. It contains no real source
IDs, credentials, uploaded rows or financial rates. Apply it once after local
checks and an appropriate pre-release application snapshot.

## Owner setup

`garage_sheet_sources()` returns the signed-in active Owner's registered sources.
Each safe row contains `id`, `source_id`, `name`, `spreadsheet_id`, `active`,
`version`, `created_at`, `last_success_at`, `last_error_at`, `last_error_code` and
`last_error`. It contains neither credential nor hash. A new registration is not
proof that its worker has connected; `last_success_at` starts null.

Owner-only setup RPCs:

- `garage_register_sheet(p_name text, p_spreadsheet_id text, p_source_id uuid,
  p_secret text)` binds one native spreadsheet to the acting Owner and returns
  its safe source row. The client generates the source UUID and a random URL-safe
  credential of 32–256 characters. Retrying identical settings returns the same
  source; an existing source cannot be overwritten through registration.
- `garage_rotate_sheet_secret(p_source_id uuid, p_secret text,
  p_expected_version integer)` replaces the hash and increments the version.
  A lost-response replay with the same new secret and prior version is recognized.
- `garage_set_sheet_active(p_source_id uuid, p_active boolean,
  p_expected_version integer)` pauses or resumes the source with a version check.

Only a SHA-256 hash of the scoped credential is stored. Its plaintext belongs in
the Owner-controlled standalone worker's private properties, never in the Manager
spreadsheet, public source or static app assets. Rotation invalidates the prior
credential. Pausing a source or deactivating its Owner blocks ingestion/status.

## Service-only ingestion

The Edge Function calls `garage_ingest_sheet(p_source_id uuid, p_secret text,
p_payload jsonb)` with its server credential after validating the HTTP request.
Authenticated browser and anonymous roles cannot execute this RPC, even if they
possess a source credential. The database independently authenticates the source,
checks the spreadsheet binding and validates the full submitted scope.

The v1 payload is:

```text
schema_version: 1
spreadsheet_id: registered native spreadsheet ID
submission_id: UUID for this immutable attempt
external_order_id: stable source order UUID
revision: last accepted source revision + 1
expected_order_version: null for a new order; last accepted application version otherwise
action: submit | cancel
order:
  vehicle, vin?, colour?, vehicle_group_code,
  planned_date?, due_date?, priority?, instructions?, manager_label?
tasks:
  [{external_task_id, work_code, options?, instructions?}]
```

Task options follow the closed catalogue: W19 requires `tint_percent` 5 or 15;
other works use empty options. There may be 1–50 tasks in a submitted order.
Assignment, progress, role and financial fields are rejected. Manager identity
is an attribution label; it is not inferred from the spreadsheet editor.

The server derives its acting Owner from the registered source, temporarily
delegates only the constrained Manager creation operation, and restores caller
claims afterward. It hard-codes shared Manager origin and null mandatory
assignees. Source-scoped external IDs never grant access to another source's
records or an Owner-created order. Sorting or replaying input does not change
identity. A VIN is a vehicle clue, not an order identity.

## Receipts and revisions

The result is a safe JSON object with `status` `accepted`, `rejected` or `conflict`,
submission/order external IDs and revision. An accepted receipt includes
`order_number`, `order_status`, `order_version` and tasks with external IDs,
approved work code and current operational status. No internal task/order UUID,
amount, tax value, private rate reason or credential is returned.

Rejected/conflict receipts add `error: {code, message}` using fixed messages.
Known codes include `INVALID_SUBMISSION`, `UNSUPPORTED_FIELDS`,
`SPREADSHEET_MISMATCH`, `SUBMISSION_ID_REUSED`, `REVISION_CONFLICT`, `ORDER_CHANGED`,
`ORDER_CLOSED`, `TASK_ID_REUSED` and `VALIDATION_FAILED`. Invalid source credentials
raise SQLSTATE `42501`; raw database errors must never be forwarded by the Edge
Function. Rejected attempts do not advance the accepted revision.

The same submission ID and logical JSON payload return the original receipt,
including after a mechanic has progressed the work. Changed content requires a
new submission ID. Source locking serializes concurrent attempts so identical
delivery creates one order and one receipt.

New orders begin at source revision one and publish automatically after complete
validation. Pending amendments require the next accepted revision, the exact
last accepted application version, an open order and all current source tasks
still pending. Any intervening mechanic or Owner action requires Owner review;
status polling does not silently advance the accepted control version.

Within an eligible pending amendment, unchanged work/group/options retain their
task identity and frozen rate snapshot. Cosmetic date/instruction changes do not
reprice them. Removed tasks and material work/group/option changes preserve the
old task as cancelled and create replacement authorization/snapshots. Accepted
scope snapshots and per-revision external-task bindings retain the old context.
One invalid task rolls back the entire scope change; the prior order stays intact.

Explicit cancellation applies only to an untouched open source order. It records
an accepted cancellation receipt and cancels pending work without deleting rows.
Deleting spreadsheet rows is not cancellation. Started, completed or Owner-edited
work cannot be overwritten or erased by a spreadsheet revision.

## Safe feedback

`garage_sheet_status(p_source_id uuid, p_secret text,
p_external_order_ids jsonb default '[]')` is also service-only. It returns
`{source_id, orders:[...]}` containing source external order/task IDs, accepted
revision, application order number/version/status, task work code/status,
performing mechanic display name and completion timestamp. Values remain
operational only. Filter up to 100 external UUIDs per call; an empty filter returns
up to 100 source orders. Larger workbooks should poll explicit batches.

The integration tables have Owner-scoped RLS and no browser write grants. The
credential hash is not a selectable browser column even for the Owner. Manager
workers receive only the explicitly enumerated status/receipt output. Financial
tables and existing order permissions remain unchanged.

## Verification

Run `bash tests/run-manager-tests.sh`. It uses a network-disabled PostgreSQL 17
container with synthetic roles, sources and credentials. Checks cover source
registration/rotation, role and secret denial, source binding, bad/privileged
fields, retries, source/task identity isolation, pending revisions, preserved
scope and prices, progress conflicts, cancellation and safe feedback. A real
two-session duplicate test verifies one resulting order and receipt.
