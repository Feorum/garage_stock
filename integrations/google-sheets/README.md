# Earlier template worker

This directory contains the earlier standalone worker for a separate
Orders/Tasks/Catalogue template. That template is **not the current Manager
workflow**. Managers already have an operational spreadsheet; the current
integration uses a full working copy in its existing layout and leaves the
original untouched.

Use the [existing-sheet reader](../existing-google-sheet/README.md) for the
current private operational copy. It reads the configured copy without adding
Submit fields, technical identifiers, feedback columns or a control workbook.
Managers need no app accounts. Valid unfinished requests are imported
automatically; completed history and ambiguous work are excluded or reviewed.

The files here remain for compatibility with already configured template
sources. They must not be installed against the original Manager spreadsheet
or the operational copy. The older template connection is separately bound and
can be paused from Owner management; it cannot be silently rebound to a different
spreadsheet.

## Compatibility contract

The legacy `Code.gs` requires exact Orders/Tasks/Catalogue headers and explicit
Submit/Cancel actions. Its source and task UUIDs, feedback fields and separate
Owner-private outbox apply only to that template. Its integration credential
must remain in a private standalone project, never a Manager-editable bound
script or shared spreadsheet. It receives no financial values.

The authenticated `manager-orders` ingestion endpoint remains shared server
infrastructure. It enforces atomic validation, stable identities, immutable
retry receipts, strict revisions and progress conflicts for both adapters.
See [Manager API](../../docs/manager-api.md) for the server protocol.

Run the compatibility tests with:

```sh
node --test tests/manager-edge.test.mjs tests/google-worker.test.mjs
```
