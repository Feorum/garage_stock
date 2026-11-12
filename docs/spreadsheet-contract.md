# Existing Manager spreadsheet and working copy

The Manager order table already exists. The app uses a **full operational copy
in the same layout**, not a new Orders/Tasks template. The original spreadsheet
is not modified or connected to the new import. Changes made to the original
after copying are not automatically mirrored into the copy.

Raw workbooks, extracted operational records and actual rates stay in private
Owner project notes, outside this public repository. The price and accounting
workbooks are not order feeds.

## Roles and source columns

Managers need no application accounts. Mechanics choose valid Manager work from
the shared queue. Owner orders for other clients retain mandatory assignments.
The operational copy uses these columns on its existing order tab:

| Column | Meaning | Import use |
| --- | --- | --- |
| A | Requested date | Planned visit date; not the server completion date |
| B | Weekday | Ignored; exported derived formulas are unreliable |
| C | Manager | Attribution label, not a verified signed-in identity |
| D | Vehicle | Approved vehicle group, with ambiguous variants held for review |
| E | VIN | Vehicle identity; repeated visits remain separate |
| F | Colour | Operational description |
| G | Wrapping | Requested works from the closed catalogue |
| H | Tinting | Approved rear-hemisphere service with explicit 5% or 15% option |
| I | `Готовность` | Checked means completed, so historical rows are excluded |
| J | Additional instructions | Order context and explicit per-work instructions; partial-work annotations require review |

The importer checks the exact headers before reading orders. It ignores blank
checkbox templates and non-order notices. It never writes UUIDs, Submit flags,
feedback columns, prices or protection rules into either spreadsheet.

## Closed work selection

The work system is moving from arbitrary descriptions to a closed list. Keep
that selection within the existing operational layout: use the approved work
labels or codes, approved vehicle models and permitted tint variants. No new
work type is created from a phrase in a source cell. The approved catalogue has
19 works, 17 vehicle groups and model-specific availability. Blank/dash
work-model combinations remain unavailable until clarified.

During the transition, exact recognized selections can be imported; an unknown
fragment or ambiguous abbreviation holds the whole vehicle request for Owner
review. Do not silently infer a generic Atlas model, matte-film package, hood
width, tint scope or missing percentage. Duplicate mentions of the same approved
work are normalized without adding another task. Notes that indicate partial
execution do not create fresh pending work automatically.

Additional instructions can refer to a selected task with `[W01] instruction`
on its own line in J. Untagged text remains order instructions. A note that
changes dimensions or the chosen package, such as a custom 40 cm hood strip,
is preserved for Owner review; it is not silently converted to full, 25 cm or
45 cm coverage or priced as a different approved work.

## Import and reconciliation

A configured private Google reader checks only the working copy. Eligible
unfinished rows are automatic requests; Managers do not need a separate Submit
step. The request must be unchanged across two reads at least one minute apart
to let source edits settle before publication. Valid complete requests publish into the shared mechanic queue. Unclear
rows appear under the Owner's **Sheet connections → Review rows**.

The server retains visit identities, immutable delivery snapshots, revisions
and accepted order versions privately. A source row number is provenance, not
an order identity. Sorting a sheet does not create another order. Ambiguous or
colliding visit identities wait for reconciliation. Missing/deleted rows are
not automatic cancellation commands.

Checked completed history never becomes new pending work. A checkbox cannot
complete an app task on behalf of a mechanic. An amendment after work has
started, completed, been changed by the Owner or been closed is held for review
and does not erase execution history or booked financial snapshots.

Correct clear model/work selection problems in the working copy; subsequent
reader checks retry them. Identity conflicts or changes to executed work may
require Owner reconciliation rather than a source text correction alone.

## Private reader and status

The Owner connects the working copy once and uses **Set up private reader**.
The app produces a one-time source key and copy/tab settings for a standalone
Owner-private Google Apps Script project. The reader uses the Owner's authorized
Google access, reads only A:J of the configured tab and sends snapshots to the
server. It never changes source cells, comments, validation, protection, sharing
permissions or the original spreadsheet. No extra control workbook is needed.

Keep the copy private. Registration is not proof that the reader is running;
**Waiting for private reader** remains until an actual successful request. The
Owner must authorize the Google reader once because the connected Google tools
cannot install or authorize Apps Script triggers. The trigger targets one-minute
intervals, subject to Google account availability and quotas.

A server-pull mode also exists for sources that are already server-readable.
It does not make a private source public or broaden its sharing. Private sources
use the authorized reader described above.

All prices, totals, tax/discount values, financial source data and remuneration
remain Owner-only. Neither the reader response nor mechanic-readable order data
contains them. See [the reader guide](../integrations/existing-google-sheet/README.md)
and [Manager API](manager-api.md).

## Local workbook preview

Uploaded XLSX files remain passive snapshots, not a live connection. The optional
preview tooling is useful for private analysis and never creates app records:

```sh
python3 -m pip install -r requirements-workbooks.txt
python3 scripts/preview-workbooks.py \
  --alfort /private/path/operational.xlsx \
  --main /private/path/accounting.xlsx \
  --price-list /private/path/prices.xlsx \
  --output /private/path/garage-preview
python3 tests/test-workbook-preview.py
```

Use an output directory outside the checkout. The preview preserves source
provenance, hidden history, repeated VINs and formula expressions for review;
it does not execute formulas or publish orders. Financial/accounting entries
cannot establish authorized tasks, mechanic completion or wages.
