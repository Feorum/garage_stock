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
| G | Wrapping | Catalogue selections and free-written Manager comments |
| H | Tinting | Approved rear-hemisphere service with explicit 5% or 15% option |
| I | `Готовность` | Completed checkbox; upgraded sync reflects verified app task completion |
| J | Completion notes | Protected app output with work/mechanic results; existing notes are preserved |

The importer checks the exact headers before reading orders. It ignores blank
checkbox templates and non-order notices. The upgraded sync uses existing I/J
for execution feedback and protects J. It never adds Submit/feedback columns
or writes UUIDs or prices into cells; the original workbook stays untouched.

## Authoritative catalogue and manager comments

The Owner-provided June 2026 Geely price workbook is the comprehensive source
for selectable works and variants. Its two worksheets agree with the existing
19 work types, 17 model groups and 283 available work-model combinations.
The private workbook and its amounts stay outside the repository. Its promotion
footnote is an Owner pricing condition, not another work type or an automatic
task selected from a Manager comment.

The work system is moving from arbitrary descriptions to a closed list. Keep
that selection within the existing operational layout: use the approved work
labels or codes, approved vehicle models and permitted tint variants. No new
work type is created from a phrase in a source cell. The approved catalogue has
19 works, 17 vehicle groups and model-specific availability. Blank/dash
work-model combinations remain unavailable until clarified.

Recognized catalogue selections become tasks. Other wrapping/tint descriptions
are preserved visibly as Manager comments, with their source column identified.
Comments and ordinary details do not prevent independently valid selected works
from importing. They never create another task, select a different package,
change a price, assign a mechanic or record completion. A row containing only
comments still needs at least one actual catalogue selection.

Do not silently infer a generic Atlas model, matte-film package, hood width,
tint scope or missing percentage. Duplicate mentions of the same approved work
are normalized without adding another task. Invalid vehicle identity, missing
dates, unavailable work-model combinations, contradictory selected packages,
explicit completion conflicts and confidential financial text require review.

The parser recognizes a bounded set of older service spellings as the same
catalogue packages: explicit 45 cm hood strips and partial 25 cm hood strips;
`крылья целиком`, `часть крыльев` / `частично крылья`; `Фары` (front headlights);
`полоса над лобовым [стеклом]`; `стойки А` / `стойки лобового [стекла]`;
`зона маникюра`; and door-edge / inner-sill abbreviations that explicitly say
four pieces. These shortened service names retain the catalogue package scope.
Recognition uses exact catalogue names and approved aliases. A separate trailing
detail stays visible as a comment. The above-windshield work has no width in the
price list, so an explicit width such as 20 cm can accompany that selected work.
This does not extend fixed hood-strip sizes or other defined packages. Generic
`стойки` or `пороги`, a different package quantity, a hood size without its unit
and tint without an explicit rear-hemisphere scope remain comments rather than
silently selecting a catalogue task. Source descriptions remain unchanged in
the snapshot.

New Manager details belong in G on a separate `Comment:` line. Managers may
mention a selected work by name without using task codes. Comments refresh in
their own channel for Owner and Mechanics, without replacing Owner instructions
or amending tasks, prices or completion. Confidential text stays Owner-only.
Legacy `[W01] instruction` lines in J remain understood. Custom dimensions stay visible as
details without changing the selected package. An explicit contradiction of a
selected package still needs clarification. Preparation notes stay visible;
they do not mark work completed. Comments never silently turn a custom 40 cm
hood strip into full, 25 cm or 45 cm coverage or a different price.

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
Google access and sends the configured tab's snapshots to the server. The
upgraded script writes only verified execution results to I/J, protects J as
application output and retains its existing notes. It needs one-time edit
authorization when upgrading from read-only mode. It never changes the original
spreadsheet or sharing. No extra control workbook is needed.

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
