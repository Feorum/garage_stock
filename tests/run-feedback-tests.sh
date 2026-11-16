#!/usr/bin/env bash
# Isolated synthetic PostgreSQL only; no production credentials or source data.
set -euo pipefail
garage_root="$(cd "$(dirname "$0")/.." && pwd)"
garage_image='postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
garage_container="garage-feedback-test-${BASHPID}"
garage_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
garage_cleanup() { garage_docker rm -f "$garage_container" >/dev/null 2>&1 || true; }
garage_docker image inspect "$garage_image" >/dev/null
garage_docker run -d --name "$garage_container" --network none --memory 384m --cpus 2 \
  --tmpfs /var/lib/postgresql/data:rw,size=256m -e POSTGRES_HOST_AUTH_METHOD=trust "$garage_image" >/dev/null
trap garage_cleanup EXIT
garage_ready=false
for garage_attempt in {1..60}; do
  if garage_docker exec "$garage_container" pg_isready -U postgres >/dev/null 2>&1; then garage_ready=true;break;fi
  sleep 1
done
if [[ "$garage_ready" != true ]];then garage_docker logs "$garage_container";exit 1;fi
while IFS='|' read -r garage_source garage_target; do
  garage_docker cp "$garage_root/$garage_source" "$garage_container:/tmp/$garage_target"
done <<'GARAGE_FILES'
schema.sql|garage-schema.sql
supabase/migrations/202611120001_orders.sql|garage-orders.sql
supabase/migrations/202611120002_manager_submissions.sql|garage-manager.sql
supabase/migrations/202611130001_existing_sheet_pull.sql|garage-pull.sql
supabase/migrations/20261115015355_owner_manager_order_editing.sql|garage-owner-edit.sql
supabase/migrations/20261115022416_owner_intake_identity_guards.sql|garage-owner-guards.sql
supabase/migrations/20261116203155_manager_comment_channel.sql|garage-manager-comments.sql
supabase/migrations/20261116203249_sheet_completion_feedback.sql|garage-sheet-feedback.sql
supabase/migrations/20261116203339_omitted_completed_work.sql|garage-omitted-work.sql
supabase/migrations/20261116210237_readable_sheet_completion_notes.sql|garage-readable-feedback.sql
tests/manager-submissions.sql|manager-test.sql
tests/existing-sheet-pull.sql|pull-test.sql
tests/owner-manager-edit.sql|owner-edit-test.sql
tests/owner-intake-guards.sql|owner-guards-test.sql
tests/sheet-completion-feedback.sql|feedback-test.sql
tests/feedback-readable-output.sql|readable-feedback-test.sql
GARAGE_FILES
garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -f /tmp/readable-feedback-test.sql
