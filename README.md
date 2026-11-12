# Garage Daily Log

A mobile PWA for vehicle orders, built incrementally on Supabase and GitHub Pages.
The first increment is an application skeleton: real sign-in and profile lookup,
separate Owner and Mechanic navigation, and a read-only approved-work catalogue.
Order lists are explicitly marked as being prepared. They are not connected to
an order database yet and do not imply that the database contains zero orders.

The previous daily log is preserved in Git history at commit `240fd91`. The
existing hosted site is https://feorum.github.io/garage_stock/. Local source
changes do not publish the new skeleton or change the existing database.

## Current increment

- Existing Supabase accounts and `profiles` remain in use. The `admin` role is
  displayed as Owner. Unknown roles and failed profiles do not receive a workspace.
- Owner and Mechanic screens have separate navigation and planned-state content.
- The approved catalogue contains 19 work types and 17 vehicle groups, with
  sanitized availability information. It contains no rates or financial data.
- Password setup/recovery remains on `account.html` with the existing implicit
  Supabase callback, verified session, and URL cleanup.
- No order creation, task claim/completion, Google Sheets integration, database
  migration, or financial reporting is implemented in this increment.

The UI is a foundation, not a replacement for database authorization. Future
task operations must enforce routing, assignment and confidentiality server-side.
See [the implementation roadmap](docs/implementation-roadmap.md).

## Run locally

Use the existing project's public browser settings:

```sh
export SUPABASE_URL='https://YOUR-PROJECT.supabase.co'
export SUPABASE_PUBLISHABLE_KEY='your-public-publishable-key'
python3 scripts/build-pages.py
python3 -m http.server 8080 --directory dist
```

Open http://localhost:8080. A legacy public `SUPABASE_ANON_KEY` can replace the
publishable-key variable. Never use a secret key, service-role key, or Management
API token in this build. Source configuration intentionally uses placeholders;
the builder substitutes public settings only in `src/supabase.js`.

The builder uses an explicit public-file allowlist. Tests, documentation, SQL,
source spreadsheets and private project notes are excluded. `dist/` is ignored.
To use another dedicated output directory, pass `--output /path/to/empty-folder`.
Existing outputs containing unlisted files are refused, so stale private files
cannot silently become part of a public release.

## Validate

With Python Playwright and Chromium available, build first and run:

```sh
python3 tests/browser-smoke.py
```

The browser checks use a mocked Supabase SDK and no live credentials. By default
they serve `dist/`, use `/usr/bin/chromium`, and save artifacts under
`/workspace/scratch/skeleton-smoke`. Override these with `--directory`,
`--chromium`, and `--output` when running elsewhere.

## Files

| File | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Responsive application shell and styles |
| `app.js` | Application startup and session-driven rendering |
| `src/supabase.js` | Shared Supabase client and public build configuration |
| `src/auth.js` | Authentication/profile state |
| `src/navigation.js`, `src/ui.js`, `src/views.js` | Role-aware navigation and screens |
| `src/catalogue.js` | Approved operational labels and availability; no prices |
| `account.html`, `account.js` | Email-link password setup and authenticated changes |
| `sw.js` | Versioned cache of public app assets |
| `schema.sql` | Original apply-once schema and sample data; not a new migration |

## Service-worker updates

The public module graph is precached together in `garage-log-v4`. It uses a
cache-first strategy so a running version does not receive a mixture of old and
new modules. Updates wait until older app tabs close; reopen the app to use the
new version. Bump the cache version whenever changing a cached asset.

Only this app's `garage-log-` caches are cleaned up. Account pages, callback URLs,
authorized requests, Supabase data and future financial API responses are not
cached. The shell may open offline after it has loaded, but sign-in/profile
verification and future work actions require a confirmed network response.

## Existing accounts and database

Use the currently provisioned accounts. This increment reads authentication and
profiles only. Do not rerun `schema.sql`: it is the original initial migration,
including a sample work catalogue unrelated to the new approved list. Existing
user IDs and historical job rows must survive future additive migrations.

For account emails, retain the deployed app as Supabase's site URL and allow the
exact HTTPS `account.html` redirect. Existing confirmed users need a password
recovery/setup email rather than a new invitation. SMTP credentials remain in
secure settings, outside this repository and all browser assets.

## Publish

Build and validate the intended revision, then publish the contents of `dist/`
to the configured `gh-pages` branch. Updating `main` alone does not run a source
build or publish this application. A source-to-Pages pipeline is a later roadmap
step; this increment does not change hosting or deploy automatically.
