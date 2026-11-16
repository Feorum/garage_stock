# Automatic website deployment

The live site is https://feorum.github.io/garage_stock/. Every push to `main`
runs `.github/workflows/deploy-pages.yml`. Successful checks build and publish
the website at the same address. A manual run from `main` is also available in
the repository's **Actions → Test and deploy Pages** page.

## Repository configuration

In **Settings → Secrets and variables → Actions → Variables**, configure:

| Repository variable | Value |
| --- | --- |
| `SUPABASE_URL` | Existing HTTPS project origin used by the live browser client |
| `SUPABASE_PUBLISHABLE_KEY` | Existing public `sb_publishable_...` browser key |

These values are public browser configuration. The builder rejects private
service-role and secret keys. No production database password, Google credential
or Supabase Management API token belongs in this workflow.

Set **Settings → Pages → Source** to **GitHub Actions**. The `github-pages`
environment must allow branch `main` to deploy. Keep HTTPS and the existing site
address. The historical `gh-pages` branch is retained as an earlier publication;
new releases use the tested Actions artifact.

## What runs

1. Check out the triggering commit with read-only repository access and no saved
   Git credentials. Official Actions are pinned to immutable commit SHAs.
2. Run Node boundary tests and Python release build/integrity tests.
3. Build the explicit public-file allowlist using the configured public values.
   Pull requests and manual runs on another branch use synthetic settings and
   cannot deploy.
4. Run all four mocked Chromium browser suites, including authentication,
   permissions, order editing, Sheets setup and an actual service-worker upgrade.
   They block live database requests and create no real orders.
5. Upload only `dist/`, then deploy it with the job's temporary Pages/OIDC token.
   Deployments are serialized; an active deployment is not cancelled by a push.
6. Fetch `release.json` and all its public assets from the live site. Check the
   expected commit, cache identity and every SHA-256, with bounded retries for
   CDN propagation. The Actions run reports failure if live verification fails.

A failure before publication leaves the previous site running. A failure in the
final live check means publication was attempted and needs inspection in the
run log; check the release manifest before deciding to roll back.

Database migrations, Edge Functions and the private Google reader are released
separately. Coordinate compatible backend changes before a dependent frontend
release. Pushing SQL or Edge source through this workflow does not apply it to
production.

For completion-feedback releases, apply migrations `20261116203155`,
`20261116203249` and `20261116203339` in order after preserving a verified
private snapshot. Deploy all `pull-manager-sheets` dependencies, including
`feedback.ts`, before the frontend. Existing read-only workers remain compatible.
Then update the private Google project's `Code.gs`, `Feedback.gs` and manifest,
and run `install()` with the Owner's one-time Google edit authorization.
Verify the next two reads: first writes matched I/J output, second confirms it
without a new request, task, completion or source-progress conflict. Never
place the reader's source key or private backup in the published artifact.

## Cache and release identity

The builder's `--release` option takes a full 40-character commit SHA. The workflow
passes `GITHUB_SHA`; `GARAGE_RELEASE_SHA` is an optional local equivalent. The
resulting worker cache is `garage-log-sha-<commit>`. Same source, configuration and
release identity produce the same output, without build timestamps.

`release.json` contains public commit/cache information and hashes for the public
assets. It is outside the worker's cache. Published account callbacks and private
application responses retain their cache exclusions. An already open app keeps
its current module graph until its old tabs close, then activates the new worker.

For a local release build, supply the existing public environment values and run:

```sh
python3 scripts/build-pages.py --output dist --release "$(git rev-parse HEAD)"
python3 scripts/verify-pages.py \
  --url https://feorum.github.io/garage_stock/ \
  --commit "$(git rev-parse HEAD)"
```

The verification command performs public, read-only HTTP requests. The build
does not deploy anything by itself.

## Rollback

Revert the faulty website commit on `main` and push the revert. The same checks
publish that corrected source with a new cache identity, preserving repository
and deployment history. Check the successful Actions run and live `release.json`.
Choose source compatible with the deployed database and Edge APIs.

For a failed build caused by a missing repository variable, fix the public setting
and rerun the failed workflow. Keep backend credentials in their existing secure
settings; no additional deployment credential is required here.

The workflow can be disabled in GitHub Actions during an incident. Existing
published files continue to serve while an approved correction is prepared.
