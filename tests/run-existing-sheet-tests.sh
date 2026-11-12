#!/usr/bin/env bash
# Synthetic isolated PostgreSQL only; no live Supabase/Google calls.
set -euo pipefail
garage_root="$(cd "$(dirname "$0")/.." && pwd)"
garage_image='postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994'
garage_container="garage-pull-test-${BASHPID}"
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
garage_docker cp "$garage_root/supabase/migrations/202611130001_existing_sheet_pull.sql" "$garage_container:/tmp/garage-pull.sql"
garage_docker cp "$garage_root/tests/manager-submissions.sql" "$garage_container:/tmp/manager-test.sql"
garage_docker cp "$garage_root/tests/existing-sheet-pull.sql" "$garage_container:/tmp/pull-test.sql"
garage_docker exec "$garage_container" psql -X -U postgres -v ON_ERROR_STOP=1 -f /tmp/pull-test.sql
