# Garage Work Orders

A mobile PWA for the Owner and Mechanics, using Supabase and GitHub Pages.
Live app: https://feorum.github.io/garage_stock/.

## Current functionality

- Sign-in uses the existing Supabase accounts. `admin` is displayed as Owner;
  unknown roles, missing profiles and inactive accounts cannot open a workspace.
- Owner creates vehicle orders, assigns client tasks to mechanics, and registers
  Manager requests in a shared queue. VIN, colour, planned date, deadline,
  priority and operational instructions are separate fields.
- Mechanics start mandatory assignments or claim available Manager tasks. They
  can block/resume/complete work and return shared tasks to the queue.
- Owner can transfer or cancel work with a reason and close finished orders.
  Transferring active Manager work preserves its shared origin.
- Owner can interpret free-written Manager requests and edit open orders with
  the same form used to create an order. Catalogue selections preview private
  amounts; saved tasks use server-calculated, immutable rate snapshots.
- Orders use compact, collapsible rows in their source spreadsheet sequence.
  Requests awaiting Owner interpretation appear in that same list. The
  catalogue is available inside order forms without a separate navigation page.
- The approved catalogue has 19 works, 17 vehicle groups and sanitized
  availability. The tint package requires an explicit 5% or 15% option.
- Owner-only rate snapshots are separate from operational rows. Unpriced values
  remain unknown. Mechanic responses contain no prices, totals or tax fields.
- Spreadsheet copies have been analyzed privately. A local preview tool
  identifies history and ambiguous mappings without creating live orders.

The Manager integration reads an approved complete copy of the existing
operational spreadsheet. It keeps its existing vehicle rows, work-list columns,
completed checkbox and notes; Managers do not need an app account or a replacement
Orders/Tasks template. The Owner's price workbook defines the complete work
catalogue. Recognized selections publish automatically, while other descriptions
remain visible Manager comments. Rows without a selected work or a valid vehicle
identity, and conflicting selections, remain in Owner review. Completed history
is excluded. Copy-only development never connects or edits the original.

Original Manager entries and subsequent source observations remain private to
the Owner. After the Owner interprets or edits a linked order, spreadsheet
polling retains provenance but cannot replace those operational changes or
publish a second order for its reserved source identity. Removed or replaced
pending tasks are cancelled with history retained; started and completed tasks
remain unchanged. Owner corrections are saved in the application and are not
written back to the Manager spreadsheet.

Private copies stay private. An Owner-private standalone Google reader uses
read-only spreadsheet access; the Owner authorizes it once. The application
keeps durable delivery state in its private database. Connecting a workbook
alone does not install a Google trigger. Use **Sheet connections** for private
reader setup, pause and review. Never put its credential in the shared workbook.
See [the roadmap](docs/implementation-roadmap.md) and
[spreadsheet contract](docs/spreadsheet-contract.md).

## Run locally

```sh
export SUPABASE_URL='https://YOUR-PROJECT.supabase.co'
export SUPABASE_PUBLISHABLE_KEY='your-public-publishable-key'
python3 scripts/build-pages.py
python3 -m http.server 8080 --directory dist
```

Open http://localhost:8080. The legacy public `SUPABASE_ANON_KEY` is supported.
Never use secret, service-role or Management API credentials in the browser build.
Source configuration uses placeholders; the builder substitutes public settings
only in `src/supabase.js` and copies an explicit public-file allowlist.

The order migration must be applied to the target database before serving this
version. Use existing provisioned accounts. No live database write occurs during
the build. Keep source spreadsheets, private reports and actual rate imports
outside the checkout and `dist/`.

## Database release

The initial `schema.sql` and its sample catalogue are historical. **Do not rerun
them against the existing database.** The next version is an additive migration
at `supabase/migrations/202611120001_orders.sql` with its own migration ledger.
It preserves legacy identities and job rows, adds the approved catalogue and
order tables, and closes legacy direct job writes so older clients cannot bypass
ordered tasks.

Apply the migration once after testing and saving a restorable application-data
snapshot. Load the approved price matrix privately into the Owner-only price
tables; actual rates are deliberately absent from source and migration seeds.
Notify PostgREST to reload its schema after an API-based migration. See
[the database API](docs/database-api.md) for the contract and release sequence.

Existing deployments apply the additive
`20261115015355_owner_manager_order_editing.sql` and
`20261115022416_owner_intake_identity_guards.sql` migrations before updating the
reader and static app. They introduce private Manager intake and Owner editing,
retaining prior corrected identities. They do not rerun the historical schema or
replace stored orders or rates.

## Validate

```sh
python3 scripts/build-pages.py
python3 tests/browser-smoke.py
python3 tests/browser-orders.py
python3 tests/browser-sheets.py
python3 tests/browser-owner-editing.py
bash tests/run-database-tests.sh
bash tests/run-manager-tests.sh
bash tests/run-existing-sheet-tests.sh
bash tests/run-owner-edit-tests.sh
node --test tests/manager-edge.test.mjs tests/google-worker.test.mjs
node --test tests/existing-sheet-*.test.mjs
python3 tests/test-workbook-preview.py
```

Browser checks require Python Playwright and Chromium, use a mocked SDK and make
no live database requests. Their local server uses the production `/garage_stock/`
path. Database checks use an isolated PostgreSQL 17 Docker container and include
two-session claims, role isolation, immutable snapshots and request retries.
Workbook tests use synthetic fixtures and the optional dependency in
`requirements-workbooks.txt`.

## Files

| File | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Responsive shell and operational screens |
| `app.js` | Startup, session routing and view disposal |
| `src/supabase.js`, `src/auth.js` | Shared client, verified user/profile state |
| `src/orders.js` | Owner forms, mechanic actions, operational reports and private amounts |
| `src/sheets.js` | Owner-only spreadsheet source setup and sync status |
| `src/views.js`, `src/navigation.js`, `src/ui.js` | Role-specific views and safe DOM helpers |
| `src/catalogue.js` | Operational work/group labels and availability; no rates |
| `account.html`, `account.js` | Implicit email-link password setup and changes |
| `supabase/migrations/` | Server-authorized workflow, RLS and data structures |
| `supabase/functions/manager-orders/` | Source-authenticated import/status endpoint |
| `supabase/functions/pull-manager-sheets/` | Existing-layout parser, private source reader and durable delivery |
| `integrations/existing-google-sheet/` | Read-only standalone reader for the approved operational copy |
| `integrations/google-sheets/` | Historical optional separate-template integration |
| `scripts/preview-workbooks.py` | Private source preview without database writes |
| `scripts/build-pages.py`, `sw.js` | Public build and versioned static cache |

## Caching and deployment

`garage-log-v7` precaches one complete public module graph. Updates wait for older
app tabs to close; close/reopen the app to activate an update. Only `garage-log-`
caches are cleaned up. Account callbacks, authorized requests, Supabase data and
financial responses bypass the service-worker cache. Work actions require a
confirmed online response.

Build and validate, then publish only `dist/` to `gh-pages`. Updating `main` alone
does not run a source build. Preserve the deployed account callback URL in the
Supabase redirect allowlist; SMTP and integration credentials stay in secure
settings. The previous daily-log implementation remains in Git at `240fd91`.
