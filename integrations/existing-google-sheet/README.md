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

The Google connector cannot install or authorize Apps Script triggers. The
Owner must complete this one-time step in their Google account. Do not make a
private operational copy public as a shortcut.

## Existing columns

The existing A:J layout is retained: A date, B derived weekday (ignored), C
Manager, D vehicle group/model, E VIN, F colour, G selected wrapping works,
H rear-hemisphere tint choice, I completed checkbox, J additional instructions.
Only explicit approved catalogue work names/codes are accepted. Multiple G
selections may be separated by commas, semicolons or newlines. H must specify
rear-hemisphere 5% or 15%; there is no inferred default.

In J, use `[W01] instruction` on its own line to attach text to a selected task;
untagged lines remain order instructions. Dimensions or scope changes such as
40 cm hood are preserved for Owner review instead of changing an approved full,
25 cm or 45 cm work. Prices and financial notes are never sent to Mechanics.

Checked historical rows are not reopened. Missing source rows never cancel
application work. A changed visit identity, ambiguous legacy wording, existing
progress or a scope conflict remains in Owner review. Valid inputs must remain
unchanged over two reads at least one minute apart so edits can settle before
automatic publication. Started application work is never overwritten by a
spreadsheet amendment.
