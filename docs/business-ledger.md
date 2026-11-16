# Business ledger

The Business ledger is an Owner-only editable working copy of an imported XLSX
workbook. It is separate from workshop orders, mechanic completions and frozen
task prices. Editing historical allocations does not change those records.

## Working with the page

Open **Учёт бизнеса** in the Owner navigation. The application interface is
Russian-only, including validation and account setup messages. Dates and numbers
use Russian formatting; original source text and user entries retain their wording.
Choose a workbook version,
worksheet and section. The newest explicitly dated month opens by default.
Records retain source order, with search, pagination and expandable details.
Hidden source worksheets are included.

Entry forms preserve the source column labels. Supporting expenses, advances,
balances and film sections use their own labels. Currency columns remain
separate. Source headers and unused formula templates are reference sections.

Each edit needs a reason. Inputs can be changed, and calculated results can be
overridden explicitly. Source formulas and imported values remain available.
Archive retains the record; restoring a source or earlier revision creates a
new audited version. A version conflict preserves entered values and requires
review before merging them with the latest record. Retried saves reuse a request
ID, preventing an uncertain network response from duplicating a change.

## Calculations and interpretation

The expression reader supports arithmetic, percentages, cell/range references,
cross-sheet references, SUM, MIN and AVERAGE. It executes no JavaScript or
spreadsheet macros. Decimal-comma text is supported in arithmetic operands;
SUM continues to ignore text in referenced cells.

Broken references, cycles, missing sheets, invalid numeric inputs and unsupported
expressions produce an unavailable result. They never fall back to stale cached
answers. Dependent results refresh from a consistent workbook revision after a
save. A failed refresh requires reloading before calculated results are usable.

Current entry totals include active manual entries. Original worksheet formulas
retain their original address ranges, so their results are displayed separately.
Blank prices keep the price total incomplete, with a known-values subtotal.
Column totals retain their source meanings; they are not automatically labelled
recognized revenue, net profit, tax liabilities or payroll paid.

Payment/payroll automation, interpretation of historical allocation exceptions
and reviewed links to Garage orders require separately confirmed business rules.

## Private import and storage

The importer is read-only: it does not modify or recalculate the uploaded XLSX.
An exclusive private snapshot retains the original bytes, SHA-256 fingerprint,
typed values, formulas, cached results, source XML details and compressed layout.
All populated cells are retained, including unclassified sections and errors.

```powershell
python scripts/ledger_import.py '<source.xlsx>' --output-directory '<private-directory>'
python scripts/ledger_sql.py '<private-directory>/main-workbook.private.json' --output '<private-directory>/sql'
```

Private directories must be outside the checkout. SQL batches use escaped
literals, deterministic import/sheet/row IDs and immutable-source integrity
checks. A staged import remains inaccessible until the final batch verifies
sheet/row/cell counts and cell types. Exact retries preserve existing rows and
working edits. A different source fingerprint creates a separate import version.
Apply batches only through an authorized administrative database connection.

The `garage_ledger` schema is not exposed through the Data API. All tables have
RLS, and public RPC wrappers use invoker security. Mutation implementations check
the active Owner, lock the actor and workbook, validate fields and record audit
history. Anonymous and mechanic access is denied, including known record IDs.
Private data is excluded from public assets and service-worker caches.

## Verification

Run the synthetic importer/SQL-preparation tests, Node calculation tests,
`tests/run-ledger-tests.mjs` and `tests/browser-ledger.py`. The database runner
uses the locked `tests/ledger-runtime` dependency and supports an optional private
SQL directory for isolated complete-import and exact-retry verification. It prints
counts and status only. These fixtures must never be run in production.
