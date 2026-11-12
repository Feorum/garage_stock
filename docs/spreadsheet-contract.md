# Workbook references and future spreadsheet submission

The uploaded files have different purposes. Their raw contents and extracted
records stay in private Owner project notes, outside this public repository.
The application receives approved operational fields only.

| Source role | What it establishes | What it does not establish |
| --- | --- | --- |
| Approved price workbook | Closed work/model combinations and Owner-only rates | A vehicle order, payment, task completion, or mechanic remuneration |
| Alfort operational workbook | Vehicle/date/manager label, VIN, colour, requested scope, completed checkbox, notes | A new submitted order, a verified Manager identity, or authenticated mechanic assignments |
| Main accounting workbook | Owner accounting/history with financial and staff extracts | A reliable authorized task list or execution status |

## Owner-confirmed rules

- Checked `Готовность` means **work completed**. It is not a submit-ready flag.
- Unchecked alone does not submit an order. Historical rows never enter the
  active queue automatically.
- Work choices remain the closed 19-item catalogue across 17 vehicle groups.
  Blank/dash work-model combinations remain unavailable until clarified.
- The tint service permits only the defined rear-hemisphere package with an
  explicit 5% or 15% option. An unsupported percentage or generic tint text
  requires review; it does not create an additional work type.
- Model and work abbreviations are review candidates. Do not silently guess a
  generic Atlas group, matte-film variant, hood width, package size, or task.
- Mechanics and Managers never receive prices, totals, VAT/discount amounts,
  financial extracts, or the financial source workbook.

## Local dry-run preview

Install the optional tooling dependency with
`python3 -m pip install -r requirements-workbooks.txt`, then select source roles
explicitly:

```sh
python3 scripts/preview-workbooks.py \
  --alfort /private/path/operational.xlsx \
  --main /private/path/accounting.xlsx \
  --price-list /private/path/prices.xlsx \
  --output /private/path/garage-preview
```

Use an output directory **outside the checkout**. The command creates a private
directory with mode 0700 and JSON files with mode 0600. Standard output contains
counts only. No database or network operation is performed. No application
record is created, no price list is activated, and no task is assigned.

The Alfort v1 mapping reads actual row content, not the unreliable table extent
or worksheet visibility. It ignores checkbox-only templates, retains hidden
historical rows and repeated VINs, and preserves non-order notices separately.
Weekday is derived from a valid date rather than the exported weekday formula.
Required header changes stop parsing so shifted columns cannot be misread.

Each candidate retains workbook SHA-256, sheet, row/cell references, original
scope, and review issues. A fully recognized row can produce a nonpublishable
historical/draft preview. Unknown fragments block the whole normalized preview
rather than silently dropping requested work. Source notes are not parsed as
mechanic assignments. Formulas are inspected as expressions and never executed;
an expression/error in an input column requires review. Formula caches do not
provide verified calculated results.

The Main workbook is inventoried as Owner accounting/history only. Neither its
amounts nor its staff columns are used to infer tasks, completion, wages due, or
current live orders. Hidden extracts may overlap monthly ledgers. An invoice or
VIN match is a reconciliation clue, not a global order identity.

Snapshot row/cell references are provenance within that file, **not stable IDs
for future submissions**. Moving a row or editing a workbook must not turn an
existing order into an unrelated order. The preview requires explicit Owner
resolution before any separate import implementation is used.

Run synthetic tests with:

```sh
python3 tests/test-workbook-preview.py
```

## New Manager workbook contract

The future live feed should use a separate sanitized Manager workbook, not the
Owner financial workbook and not an automatic replay of the historical export.
Use one header row per order and a separate row per requested task:

| Tab | Editable submission fields | Protected feedback/identity fields |
| --- | --- | --- |
| Orders | Vehicle description, VIN, colour, approved group code, requested/due dates, priority, instructions, Manager label, explicit Draft/Submit/Cancel-request action | External order UUID, source revision, acknowledged revision, delivery state, safe validation message, order progress |
| Tasks | Order reference, approved work code, approved task options, operational instructions | External task UUID, accepted scope/version, execution status |
| Catalogue | No manual edits | Work/group codes and names, operational availability, allowed task options; no rates |

Submission and execution are separate. Only an explicit submission can enter
validation and publish a valid Manager/shared order. Completed/readiness values
are protected feedback and cannot authorize publication or overwrite server
execution. Owner-assigned other-client orders never become shared through this
integration.

The future worker must capture immutable order/task snapshots, preserve UUIDs
through sorting, allocate source revisions, and retain the same submission ID
and hash on retries. The server must validate a complete revision atomically,
reject duplicate identities and stale/conflicting scope, and authenticate the
registered source. A Manager-name cell remains an attribution label unless a
separate authenticated identity flow establishes who submitted it.

Status feedback updates do not constitute new submissions. Row deletion is not
a cancellation command. Removing/changing already started or completed work,
or changing its vehicle group, requires explicit Owner resolution while keeping
the last accepted scope and history. Error and reconciliation responses expose
no financial values or confidential financial reasons.

Readiness to connect live Google Sheets additionally requires the actual shared
spreadsheet identity, Owner-controlled worker credentials, and the registered
integration endpoint. Uploaded XLSX copies are passive reference snapshots;
they do not grant a live Google account connection.
