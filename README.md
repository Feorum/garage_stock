# Garage Work Orders

A mobile PWA for the Owner and Mechanics, using Supabase and GitHub Pages.
Live app: https://feorum.github.io/garage_stock/.

## Current functionality

The Russian-language PWA opens on the current shift. Owners see requests awaiting review, blockers, outstanding team confirmations and orders ready to close. Mechanics see personal tasks, the shared queue and their work history. The workshop uses Europe/Minsk for deadlines and reporting.

- A Manager task can have several mechanics. Joining is open until the first personal confirmation. A private order has an Owner-selected team for each catalogue task.
- A mechanic can pause their own participation, resume it, or confirm their part. The last required confirmation creates one completion for the service. Owners can adjust the roster with a reason, including after sign-off starts. Participant history is retained.
- Owners can create, interpret, edit and close orders, or record omitted work with its contributors and actual completion time. Source identities and the approved 19-work, 17-group catalogue still govern intake. The tinted package requires an explicit 5% or 15% option.
- Reports count each completed service once and distinguish individual participation. Operational team status is visible on shared vehicles. Task notes, private intake text and financial fields have separate audiences.
- New completions enter an Owner-only pay worklist. The Owner enters a BYN compensation pool and allocates it in percentages. A past participant can be included with a reason. Pending compensation is independent of order closure and Sheets feedback.
- Catalogue pricing, mechanic compensation and the editable business-workbook ledger have distinct meanings. The ledger preserves original cells, formulas, edit history and manual overrides. Its review filter opens the rows that need attention.

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
remain unchanged. Owner work selections stay in the application. The upgraded
private sync writes operational completion results to the working copy's I/J:
the completed checkbox and a task-by-task mechanic summary. Existing Notes text
is retained; new Manager comments belong in G and refresh independently of work.

Private copies stay private. An Owner-private standalone Google script needs
spreadsheet editing authorization for completion feedback; code restricts it
to the configured copy. Existing read-only workers continue importing until
upgraded and reauthorized. The application
keeps durable delivery state in its private database. Connecting a workbook
alone does not install a Google trigger. Use **Sheet connections** for private
reader setup, pause and review. Never put its credential in the shared workbook.
See [the roadmap](docs/implementation-roadmap.md) and
[spreadsheet contract](docs/spreadsheet-contract.md).

## Run locally

Use Node.js 24 and Python 3.12 or newer. Install the locked packages and start
the Vite development server with the public settings for your development project.

```sh
npm ci
export SUPABASE_URL='https://YOUR-PROJECT.supabase.co'
export SUPABASE_PUBLISHABLE_KEY='sb_publishable_YOUR_PUBLIC_KEY'
npm run dev
```

Open <http://localhost:5173/garage_stock/>. The account callback has its own entry
at `/garage_stock/account.html`. For a local preview with the production service
worker, run `npm run typecheck`, `npm run build`, and `npm run preview`, then open
<http://localhost:4173/garage_stock/>. The public settings also accept the legacy
`SUPABASE_ANON_KEY` with an anon role. Vite embeds the two validated settings in
the SDK bundle. The release builder packages the application entry, the account
entry, their dependencies, the manifest and the app icons.

Use provisioned accounts and apply the project migrations in the development
database before testing authenticated workflows. Keep private spreadsheets,
reports and rate imports outside the public application source and build output.

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

The team-workflow release adds migrations `20261118000001_team_workflow.sql`, `20261118000002_owner_team_orders.sql` and `20261118174234_pay_worklist.sql` after all earlier migrations. Apply them in filename order to the existing installation, before publishing its dependent frontend. Backfill preserves the recorded single worker on existing tasks. The pay queue starts with newly recorded completions, including a backdated service recorded after cutover.

## Validate

```sh
python3 scripts/build-pages.py
python3 tests/browser-smoke.py
python3 tests/browser-orders.py
python3 tests/browser-sheets.py
python3 tests/browser-ledger.py
python3 tests/browser-pay.py
python3 tests/test-team-workflow.py --directory dist
python3 tests/browser-owner-editing.py
bash tests/run-database-tests.sh
bash tests/run-manager-tests.sh
bash tests/run-existing-sheet-tests.sh
bash tests/run-owner-edit-tests.sh
node --test tests/manager-edge.test.mjs tests/google-worker.test.mjs
node --test tests/existing-sheet-*.test.mjs
python3 tests/test-workbook-preview.py
python3 tests/test-build-pages.py
python3 tests/test-verify-pages.py
```

Browser checks require Python Playwright and Chromium, use a mocked SDK and make
no live database requests. Their local server uses the production `/garage_stock/`
path. Database checks use an isolated PostgreSQL 17 Docker container and include
simultaneous joins and confirmations, role isolation, immutable snapshots and request retries.
Workbook tests use synthetic fixtures and the optional dependency in
`requirements-workbooks.txt`.

## Files

| File | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Responsive shell and operational screens |
| `src/app.tsx`, `src/account.tsx` | Sign-in, verified profile, role routing and account callbacks |
| `src/shift.tsx`, `src/shift-task.tsx` | Personal shift, team queue, confirmations, history and Owner attention list |
| `src/owner-orders.tsx`, `src/owner-editor.tsx` | Order intake, editing, per-task assignment, and private price preview |
| `src/reports.tsx`, `src/pay.tsx` | Workshop completion reporting and separate Owner compensation |
| `src/ledger-view.tsx`, `src/sheets-view.tsx` | Private business ledger and spreadsheet connections |
| `src/catalogue.js` | Approved operational catalogue and availability |
| `supabase/migrations/` | Server-authorized workflow, RLS and data structures |
| `supabase/functions/manager-orders/` | Source-authenticated import/status endpoint |
| `supabase/functions/pull-manager-sheets/` | Existing-layout parser, private source reader and durable delivery |
| `integrations/existing-google-sheet/` | Standalone sync worker for the approved operational copy |
| `integrations/google-sheets/` | Historical optional separate-template integration |
| `scripts/preview-workbooks.py` | Private source preview without database writes |
| `scripts/build-pages.py`, `sw.js` | Public build and release-specific static cache |
| `.github/workflows/deploy-pages.yml`, `scripts/verify-pages.py` | Tested deployment from main and live asset verification |

## Caching and deployment

Pushes to `main` run the type checker, integration tests and Chromium workflows.
GitHub Pages publishes the tested `dist/` artifact. Pull requests use synthetic
public settings. The workflow compares the deployed release manifest to the exact
manifest produced by CI, then fetches and verifies every public asset by SHA-256.
See the [deployment and rollback guide](docs/deployment.md).

The service worker caches the complete public application entry graph under
`garage-log-sha-<commit>`. Older app tabs finish with their own cached assets.
Close and reopen those tabs to activate the next release. The account callback,
its dedicated JavaScript, authorization requests, service responses and
`release.json` stay outside the app-shell cache. Work actions require a confirmed
online response.

Preserve the deployed account callback URL in the Supabase redirect allowlist.
Database migrations, Edge Functions, SMTP and Google reader configuration use
their separate release process. The previous daily-log implementation remains
in Git at `240fd91`.
