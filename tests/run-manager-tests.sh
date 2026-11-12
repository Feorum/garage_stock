#!/usr/bin/env bash
# Synthetic isolated PostgreSQL only; no live Supabase credentials or requests.
set -euo pipefail
garage_root="$(cd "$(dirname "$0")/.." && pwd)"
garage_image='postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
garage_container="garage-manager-test-${BASHPID}"
garage_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
garage_cleanup() { garage_docker rm -f "$garage_container" >/dev/null 2>&1 || true; }
garage_docker image inspect "$garage_image" >/dev/null
garage_docker run -d --name "$garage_container" --network none --memory 384m --cpus 2 \
  --tmpfs /var/lib/postgresql/data:rw,size=256m -e POSTGRES_HOST_AUTH_METHOD=trust "$garage_image" >/dev/null
trap garage_cleanup EXIT
for garage_attempt in {1..60}; do
  if garage_docker exec "$garage_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
garage_docker cp "$garage_root/schema.sql" "$garage_container:/tmp/garage-schema.sql"
garage_docker cp "$garage_root/supabase/migrations/202611120001_orders.sql" "$garage_container:/tmp/garage-orders.sql"
garage_docker cp "$garage_root/supabase/migrations/202611120002_manager_submissions.sql" "$garage_container:/tmp/garage-manager.sql"
garage_docker cp "$garage_root/tests/manager-submissions.sql" "$garage_container:/tmp/manager-test.sql"
garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -f /tmp/manager-test.sql

# Two requests with one immutable ID/body must both receive the same accepted
# receipt while creating one order, even when the first transaction is uncommitted.
garage_log_dir="$(mktemp -d)"
trap 'garage_cleanup; rm -rf "$garage_log_dir"' EXIT
garage_submit() {
  garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -c \
    "begin; set local role service_role; set local request.jwt.claim.sub=''; select garage_ingest_sheet('10000000-0000-4000-8000-000000000001',repeat('s',40),test_payload('70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000003')); select pg_sleep(0.3); commit;"
}
garage_submit >"$garage_log_dir/a.log" 2>&1 & garage_pid_a=$!
garage_submit >"$garage_log_dir/b.log" 2>&1 & garage_pid_b=$!
if ! wait "$garage_pid_a"; then cat "$garage_log_dir/a.log"; exit 1; fi
if ! wait "$garage_pid_b"; then cat "$garage_log_dir/b.log"; exit 1; fi
garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -c \
  "select test_assert((select count(*)=1 from garage_sheet_orders where external_order_id='70000000-0000-4000-8000-000000000002'),'concurrent identical delivery creates one order'); select test_assert((select count(*)=1 from garage_sheet_submissions where submission_id='70000000-0000-4000-8000-000000000001' and status='accepted'),'concurrent identical delivery records one receipt');"
