#!/usr/bin/env bash
# IG-1's real pgTAP suite (S3 9; `make isolation-reports`, `scripts/isolation_reports.py`): one disposable
# plain PostgreSQL 17 + pgTAP container, migrated, every `supabase/tests/*.sql` file through `run_pgtap.sh`
# (`db_test.sh`'s own "plain path", lines 132-143, duplicated here deliberately: that script is `make
# db-test`'s own proven gate and this tool must never edit it to add a second caller). 127.0.0.1 only, a free
# high port Docker picks (never 5432), the container removed on exit whatever the suite's own verdict.
#
# Usage: tools/isolation_gate_pgtap.sh
# Prints the real `pg_prove`/`tools/pgtap_verdict.py` report to stdout; exits 0 only if every test file's own
# verdict was PASS (never fabricated: this is `run_pgtap.sh`'s real exit code, propagated unchanged).
set -euo pipefail
unset PGHOSTADDR PGHOST PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TESTS_HARNESS="$ROOT/supabase/tests/harness"
PYTHON="${PYTHON:-python3}"
READY_TIMEOUT_S=180

for tool in docker psql "$PYTHON"; do
  command -v "$tool" >/dev/null || { echo "isolation_gate_pgtap: FAIL: $tool is not installed" >&2; exit 1; }
done
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || { echo "isolation_gate_pgtap: FAIL: the Docker daemon is not running" >&2; exit 1; }

PLAIN_DOCKERFILE="$TESTS_HARNESS/postgres-pgtap.Dockerfile"
PLAIN_IMAGE="arena-postgres-pgtap:$("$PYTHON" -I -c \
  'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()[:16])' "$PLAIN_DOCKERFILE")"
NAME="arena-ig1-pgtap-$$-$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(4))')"
PGPASSWORD="$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(24))')"   # this container only
export PGPASSWORD

remove() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap remove EXIT

if ! docker image inspect "$PLAIN_IMAGE" >/dev/null 2>&1; then
  echo "== build $PLAIN_IMAGE from $(basename "$PLAIN_DOCKERFILE")" >&2
  docker build -q -t "$PLAIN_IMAGE" - <"$PLAIN_DOCKERFILE" >/dev/null
fi

echo "== start $PLAIN_IMAGE as $NAME" >&2
POSTGRES_PASSWORD="$PGPASSWORD" docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 \
  "$PLAIN_IMAGE" >/dev/null

waited=0
until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" == "healthy" ]]; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" || $waited -ge $READY_TIMEOUT_S ]]
  then
    echo "isolation_gate_pgtap: FAIL: $NAME did not become healthy within ${READY_TIMEOUT_S}s" >&2
    docker logs --tail 40 "$NAME" >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

PORT="$(docker port "$NAME" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
if [[ ! "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( PORT > 65535 || PORT == 5432 )); then
  echo "isolation_gate_pgtap: FAIL: no usable host port (got '$PORT')" >&2
  exit 1
fi
ADMIN="postgresql://postgres@127.0.0.1:$PORT"
connected=0
for _ in $(seq 1 30); do
  if psql -X -q -At -d "$ADMIN/postgres" -c "select 1" >/dev/null 2>&1; then connected=1; break; fi
  sleep 1
done
[[ $connected -eq 1 ]] || { echo "isolation_gate_pgtap: FAIL: cannot connect to $ADMIN/postgres" >&2; exit 1; }

# dblink sessions (the concurrency and harness fixtures) open from inside the server, which reaches it at
# its own container address, never the published host port (db_test.sh's start(), the same reason).
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME" || true)"
if [[ -z "$IP" ]]; then
  echo "isolation_gate_pgtap: FAIL: no container address for $NAME (dblink sessions need it)" >&2
  exit 1
fi
export ARENA_PGTAP_DBLINK_EXTRA="host=$IP port=5432 user=postgres password=$PGPASSWORD"

echo "== run_pgtap.sh $ADMIN (every supabase/tests/*.sql file, throwaway database with the shim)" >&2
"$TESTS_HARNESS/run_pgtap.sh" "$ADMIN"
