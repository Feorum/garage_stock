# Garage Work Orders

A mobile PWA for the Owner and Mechanics, using Supabase and GitHub Pages.
Live app: https://feorum.github.io/garage_stock/.

## Current functionality

Mechanics open the Owner’s orders (B), switch to Manager orders (G), or review their history using the same three destinations in the desktop sidebar or mobile bottom bar. Each visit shows the scheduled date and a short service list. Expanding a vehicle leaves it available to other mechanics. The workshop uses Europe/Minsk for dates and reporting.

- Checking a service records the signed-in mechanic’s contribution. Multiple mechanics can check the same service and see each executor’s name and color. The vehicle and its other tasks remain usable while the check is being saved. Authorized private assignments continue to limit which Owner services a mechanic can see.
- On an open vehicle, tapping a checked service again removes that mechanic’s own checkmark. The job stays complete while another mechanic’s check remains. Removing the last check reopens the job. Handoff freezes the checklist until the Owner returns the vehicle.
- A contributor can send a vehicle to the Owner with completed or outstanding work. The Owner’s review tab lists each submitted vehicle with its jobs and agreed customer prices. The Owner can accept a completed vehicle or send it back with an optional note. A partial handoff shows which jobs are unfinished and can be returned directly to the mechanics.
- Owners can create, interpret, edit and close orders, or record omitted work with its contributors and actual completion time. Source identities and the approved 19-work, 17-group catalogue still govern intake. The tinted package requires an explicit 5% or 15% option.
- The Owner opens on **Главная** with the current workshop week, activity chart, indicators, and orders grouped by day. The overview uses the planned date, the deadline if no date is scheduled, or the visit date for a custom order. The price indicator uses frozen standard-order catalogue rates in BYN.
- **Все заказы** combines standard and custom orders, including orders without a date. The Owner can filter and export the list. Each row opens a card with separate controls for pricing, mechanic pay, editing, photos and eligible documents. The overview contains a private order comment and the acceptance action when the order is ready to close.
- Reports count each completed service once and distinguish individual participation. Operational team status is visible on shared vehicles. Task notes, private intake text and financial fields have separate audiences.
- The Owner sees every job on one order screen, with its catalogue price, agreed customer price and mechanic pay side by side. A free job shows zero, and a missing rate is marked as unknown. Customer price adjustments and private notes can be edited within the order.
- On a completed job, the Owner enters a BYN amount for each mechanic. The total updates as they type. An equal split is available, including for totals with an odd kopek. Earlier allocations remain available in the payment history. Mechanic pay is independent of the customer price, and only the Owner can view or change it.
- In **Механики**, the Owner creates mechanic accounts and sets dated percentage rates. Users can sign in with their profile name or confirmed email plus a password. **Учётная запись** opens their own profile and account controls.
- On standard wrapping orders, preparation and heating appear under **Оплата механиков**. Each uses the existing 3% rule on completed wrapping work once an executor is assigned.
- In a closed order, the Owner can download an editable Word act using the workshop’s private form. The act prints the brand before a catalogue model and groups completed customer work into ordinary services followed by window tinting. The first export saves the number, VIN and contract details. The number combines a cumulative order serial with the act’s two-digit month. The next order continues the count across months and years.

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

The vehicle handoff and Owner calculation release adds migrations `20261118185004`,
`20261118185053` and `20261118185548`. Apply them in order and configure the
workbook promotion privately in `garage_pay.gift_offer`. The Owner chooses
whether to include the gift in the order editor. The customer charge becomes
zero and the mechanic pay suggestion still uses the original listed rate.

For the inline workshop boards, apply `20261118223856_inline_work_checks.sql`,
`20261119000002_owner_review_catalogue.sql` and `20261120155421_owner_review_agreed_prices.sql`
in order before publishing the app. These migrations add shared mechanic check-offs,
targeted board updates and per-job prices for Owner review.
Apply `20261120155825_reversible_mechanic_checks.sql` and
`20261120155922_preserve_pay_history_on_recheck.sql` together for reversible checkmarks.
Apply `20261120162315_exact_mechanic_pay_amounts.sql` before deploying the order detail editor for per-mechanic BYN amounts.
For Word exports, apply `20261120172343_owner_completion_acts.sql` and install the private master as described under [Owner completion acts](docs/database-api.md#owner-completion-acts).

For the standard and custom order release, apply the five migrations from
`20261126145852_order_photos.sql` through `20261126150806_order_film.sql`
in filename order. Update `pull-manager-sheets` and the bound Apps Script
before the Manager uses the new model picker. See the
[sheet integration instructions](integrations/existing-google-sheet/README.md).
The Owner sets effective mechanic rates in **Распределение оплаты → Ставки механиков**.
There is also a private setup script for a workshop with approved initial rates.
Keep the rates and setup script outside the public bundle and version control.
See [order finance and photos](docs/database-api.md#order-finance-and-photos)
for photo access and the private film history file.

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
