# Read an existing private operational copy

Use the complete approved copy of the existing Manager workbook. Never edit or
connect the original when the Owner has requested copy-only development. No
new Orders/Tasks template or Manager application account is required.

The standalone Google Apps Script reads the configured copy with Google's
read-only spreadsheet scope. It never writes cells, rules, comments, permissions
or prices. Durable identity, delivery and review state stays in the application's
private database; no additional control spreadsheet is created.

1. In the Owner app's **Sheet connections**, connect the approved copy's URL,
   including its tab `gid`, and choose **Set up private reader**.
2. Create a private standalone Apps Script project, copy `Code.gs` and the
   manifest above, then paste the setup function provided by the app.
3. Run that setup function once and authorize Google. Delete the temporary
   setup function afterward. Keep the project private to the Owner.
4. The minute trigger reads the copy; actual successful reads appear in the
   app. Connecting a workbook alone does not authorize Google or start reading.

The reader uses the Sheets REST read API because `SpreadsheetApp.openById`
requires the broader spreadsheet edit scope. Keep the manifest's explicit
read-only scope. Its Sheets v4 service dependency automatically enables the
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

In J, use `[W01] instruction` on its own line to attach text to a selected task;
untagged or unplaceable lines remain order comments. Dimensions such as 40 cm
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
