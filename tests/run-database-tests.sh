#!/usr/bin/env bash
# Isolated PostgreSQL only; no live Supabase credentials or requests.
set -euo pipefail
garage_root="$(cd "$(dirname "$0")/.." && pwd)"
garage_image='postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
garage_container="garage-orders-test-${BASHPID}"
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
  if garage_docker exec "$garage_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then garage_ready=true; break; fi
  sleep 1
done
if [[ "$garage_ready" != true ]]; then garage_docker logs "$garage_container"; exit 1; fi
garage_docker cp "$garage_root/schema.sql" "$garage_container:/tmp/garage-schema.sql"
garage_docker cp "$garage_root/supabase/migrations/202611120001_orders.sql" "$garage_container:/tmp/garage-orders.sql"
garage_docker cp "$garage_root/tests/orders-database.sql" "$garage_container:/tmp/orders-test.sql"
garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -f /tmp/orders-test.sql

garage_task="$(garage_docker exec "$garage_container" psql -X -U postgres -Atc "select t.id from garage_order_tasks t join garage_orders o on o.id=t.order_id where o.vehicle='Concurrency fixture'")"
garage_log_dir="$(mktemp -d)"
trap 'garage_cleanup; rm -rf "$garage_log_dir"' EXIT
garage_claim() {
  garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -c \
    "begin; set local role authenticated; set local request.jwt.claim.sub='$1'; select garage_task_action('$garage_task','start',1,'$2'); select pg_sleep(0.4); commit;"
}
set +e
garage_claim '00000000-0000-4000-8000-000000000002' '50000000-0000-4000-8000-000000000001' >"$garage_log_dir/a.log" 2>&1 &
garage_pid_a=$!
garage_claim '00000000-0000-4000-8000-000000000003' '50000000-0000-4000-8000-000000000002' >"$garage_log_dir/b.log" 2>&1 &
garage_pid_b=$!
wait "$garage_pid_a"; garage_status_a=$?
wait "$garage_pid_b"; garage_status_b=$?
set -e
if [[ "$garage_status_a" -eq 0 && "$garage_status_b" -ne 0 ]] || [[ "$garage_status_a" -ne 0 && "$garage_status_b" -eq 0 ]]; then
  garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -c \
    "select test_assert((select status='in_progress' and version=2 and working_mechanic_id is not null from garage_order_tasks where id='$garage_task'),'two-session claim has exactly one winner');"
else
  cat "$garage_log_dir/a.log" "$garage_log_dir/b.log"
  exit 1
fi
