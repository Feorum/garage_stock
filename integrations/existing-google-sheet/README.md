# Read an existing private operational copy

Use the complete approved copy of the existing Manager workbook. Never edit or
connect the original when the Owner has requested copy-only development. No
new Orders/Tasks template or Manager application account is required.

The standalone Google Apps Script reads the configured copy and writes verified
execution results only to I/J. It protects J as application output; put new
Manager comments in G. Existing J text is retained before the automatic block.
The original workbook, Manager input values, sharing and financial data stay
unchanged. Durable identity and issued output history stay in the private database.

1. In the Owner app's **Sheet connections**, connect the approved copy's URL,
   including its tab `gid`, and choose **Set up private reader**.
2. Create a private standalone Apps Script project, copy `Code.gs`, `Feedback.gs` and the
   manifest above, then paste the setup function provided by the app.
3. Run that setup function once and authorize Google. Delete the temporary
   setup function afterward. Keep the project private to the Owner.
4. The minute trigger syncs the copy; actual successful reads appear in the
   app. Connecting a workbook alone does not authorize Google or start reading.

The script uses the Sheets REST API with the manifest's explicit spreadsheet
edit scope. Google does not offer an I/J-only OAuth scope: the script itself
restricts the workbook and output columns. Updating an existing read-only script
requires the Owner to authorize this new scope once. Its Sheets v4 dependency enables the
Sheets API for the default Google Cloud project created by Apps Script. If you
associate a standard Cloud project instead, enable the Google Sheets API in
that project as well. See Google's [advanced services setup](https://developers.google.com/apps-script/guides/services/advanced)
and [read API authorization scopes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get).

The configured tab's entire allocated grid must fit within 5000 rows and 26
columns. A larger grid is rejected even when the extra rows or columns are
empty; trim unused allocation manually before installing. The reader checks
the whole supported grid, retains displayed text and native checkbox booleans,
and omits trailing cells that have only formatting. It never truncates a larger
tab into a partial import.

The Google connector cannot install or authorize Apps Script triggers. The
Owner must complete this one-time step in their Google account. Do not make a
private operational copy public as a shortcut.

## Existing columns

The existing A:J layout is retained: A date, B derived weekday (ignored), C
Manager, D vehicle group/model, E VIN, F colour, G selected wrapping works,
H rear-hemisphere tint choice, I completed checkbox, J additional instructions.
Approved catalogue work names/codes and recognized service abbreviations create
tasks. Multiple G selections may be separated by commas, semicolons or newlines.
H must explicitly select rear-hemisphere 5% or 15% to create a tint task; there is
no inferred default. Other G/H descriptions remain visible Manager comments and
do not block independently valid selections. A row with no selected catalogue
work remains in review.

In G, keep selected catalogue names/codes separated by commas, semicolons or
newlines. Add a separate `Comment:` line for arbitrary details, including
references to particular selected works. This line never selects extra tasks.
Legacy `[W01] instruction` lines in J remain understood, but J is now protected
execution output. Dimensions such as 40 cm
stay visible as details without creating or replacing an approved full, 25 cm or
45 cm work. Explicit contradictions of selected packages need clarification.
Prices and financial notes are never sent to Mechanics.

Checked historical rows are not reopened. Missing source rows never cancel
application work. A changed visit identity, an explicit completion conflict or
contradictory selected packages remain in Owner review. Preparation notes alone
do not record completion or prevent valid work from importing. Valid inputs must remain
unchanged over two reads at least one minute apart so edits can settle before
automatic publication. Started application work is never overwritten by a
spreadsheet amendment.

## Completion feedback

The new worker sends `protocol: "feedback_v1"`. The server returns only linked
operational work/mechanic results, never prices. A checked result requires at
least one completion and no remaining pending, active or blocked task; cancelled
tasks are identified separately and cancellation alone cannot mean completed.
Partial completions update J while leaving I unchecked.

Only exact previously issued, source-bound output blocks are removed before
parsing. This prevents a generated completion summary from becoming another
Manager request. A copied or invented marker is ordinary untrusted input.
The writer rechecks current row contents, binds a row through Google developer
metadata and writes I/J through that binding. Changed or ambiguous rows wait
for another read; row numbers alone never direct writes. Formula outputs stay
for Owner review. Each execution writes at most 20 rows. The following read
confirms saved output; Sheet connections shows confirmed and waiting feedback
counts. A cell-content sort safely rebinds only the app's own anchor after a
fresh unique observation; conflicting or ambiguous identities require Owner review.
