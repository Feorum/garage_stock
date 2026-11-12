# Manager spreadsheet worker

This is a **standalone, Owner-private Apps Script project**. Managers edit the
sanitized Orders/Tasks workbook. They must not be given access to this script
project, its Script Properties, or the separate submission-control workbook.
Do not create a spreadsheet-bound project that Managers can edit.

The worker sends explicitly submitted orders to the `manager-orders` Edge
Function. It never receives or supplies rates, totals, tax values, discounts,
staff allocations, or financial source workbooks.

## One-time setup

1. Create a standalone project in Google Apps Script under the Owner's account.
2. Paste `Code.gs` into it and copy `appsscript.json` into the manifest.
3. Add the four private Script Properties produced by the Owner connection UI:
   `SPREADSHEET_ID`, `INTEGRATION_ID`, `INTEGRATION_SECRET`, and `API_URL`.
   A temporary setup function may set these properties and call `install()`;
   remove that setup function after it succeeds.
4. Run `install()` once and grant the requested Google permissions. It validates
   the template, protects technical/feedback columns, creates an Owner-private
   control workbook, and installs one minute-based trigger.
5. The first successful synchronization/status request confirms the connection.
   Even an empty template makes a status check; installation alone is not proof
   that the endpoint or credentials work.

`CONTROL_SPREADSHEET_ID` is optional. When omitted, `install()` creates it. If
provided, the file must be separate from the Manager workbook and have private
sharing with no additional editors/viewers. Keep it private throughout use.
Its Outbox contains immutable operational request snapshots, and Accepted keeps
the last acknowledged revision/version. It contains no integration credential.
The Drive permission is read-only and is used to check the control file's
sharing metadata. Spreadsheet creation and cell/protection changes use the
separate Google Sheets permission.

The Google connector can prepare the workbook but does not deploy/authorize an
Apps Script project. The Owner must perform the one-time authorization above.
Do not mark a source as synchronized until a real server request succeeds.

## Template contract

The first row contains exact machine headers. Orders uses:

```text
request_ref,external_order_id,vehicle,vin,colour,vehicle_group_code,
planned_date,due_date,priority,manager_label,instructions,action,
delivery_state,accepted_revision,app_order_number,order_status,last_feedback
```

Tasks uses:

```text
request_ref,external_task_id,work_code,tint_percent,instructions,
task_status,working_mechanic
```

Catalogue columns A:D are `work_code`, `work_name`, `vehicle_group_code`,
`vehicle_group_name`, with one allowed work/group pair per row. Adjacent
validation lists are allowed and are not sent to the API. No price columns are
part of this workbook.

One Orders row represents a vehicle visit; Tasks rows refer to its unique
`request_ref`. The worker assigns protected UUIDs. Sorting rows preserves those
IDs; copied IDs or duplicate references stop synchronization for Owner review.
Row numbers and vehicle VINs are never used as global order IDs.

## Manager workflow

1. Keep the row in `DRAFT` while editing its vehicle and task rows.
2. Select an approved vehicle group and available work codes. `W19` requires a
   tint value of `5` or `15`; unknown combinations/options are rejected.
3. Set `action` to `SUBMIT` when the whole order is ready.
4. The worker captures the complete order snapshot in the private Outbox and
   returns `action` to `DRAFT`. New edits require another explicit Submit.
5. Delivery/accepted revision/order number appear only after acknowledgement.
   Mechanic execution status is server-owned feedback, not a new submission.

To request cancellation, preserve the order/task identities and set `CANCEL`.
Cancellation/amendments are accepted only under the server's revision and
pending-work rules. Work started, completed, changed or closed in the app goes
to Owner reconciliation; a sheet edit never erases actual work or its history.
Deleting rows is not a cancellation command.

## Delivery guarantees and limits

- The Outbox snapshot is saved before sending. A timeout/lost acknowledgement
  retries the exact same payload, submission UUID and revision with backoff.
- A pending submission for an order is resolved before another is captured.
- Existing Outbox delivery runs independently of later draft/template errors.
  Malformed current input suppresses unsafe feedback and new capture, while
  already captured requests can still be acknowledged.
- Invalid/conflicting submissions wait for correction. They do not advance the
  last accepted source revision.
- Feedback is matched by UUID, not row position. An old response cannot mark a
  newer edited scope as imported. Only protected feedback cells are updated.
- Status polling does not update the accepted amendment base version. Mechanic
  or Owner changes therefore remain detectable by the server.
- Template default-only blank rows are ignored. The historical `Готовность`
  checkbox is not a Submit field and the old workbook is not accepted as this
  template.
- Source notes and Manager-name cells are operational labels, not authenticated
  mechanic assignments or verified human authorship.
- Responses and errors use safe enumerated fields; raw database messages and
  credentials are neither logged nor written to spreadsheet feedback.
- A serialized snapshot must fit the private single-cell Outbox and HTTP body
  limits. Oversized requests stop for review before any delivery; they are not
  silently split or partially imported.

The trigger targets one-minute intervals, subject to Google quotas and the
Owner account remaining enabled. There is no hard delivery-time guarantee.
Monitor the Owner connection's last successful check and review feedback.

## Local checks

```sh
node --test tests/manager-edge.test.mjs tests/google-worker.test.mjs
```

Tests use in-memory Google service stubs and synthetic data; they do not send
requests to Google or Supabase.

Deploy the Edge Function with gateway JWT verification disabled for this
function only. Its custom source credential is required on every request, and
its database RPCs are service-role-only. The service-role key stays within the
Supabase function environment; Script Properties hold only the dedicated source
credential.
