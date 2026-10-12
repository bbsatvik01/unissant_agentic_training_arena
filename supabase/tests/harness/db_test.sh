#!/usr/bin/env bash
# make db-test (S8 WP-03; S5 11.1; S4 WI-S4-01, 02, 04, 08). Disposable servers, one after the other, each bound
# to 127.0.0.1 on a free high port Docker picks (never 5432) and removed with its anonymous volume when its path
# ends and again on exit:
#   1. plain path: plain PostgreSQL 17.11 with pgTAP (the official image plus pgTAP, postgres-pgtap.Dockerfile, built
#      once and tagged by the Dockerfile's hash); the migrations and the pgTAP suite on a throwaway database with
#      the Supabase shim (sql/TESTS.md section 0)                                   run_pgtap.sh <admin-uri>
#   2. Supabase path: the Supabase Postgres 17 image the owner's project runs; the migrations and the suite on the
#      container's own `postgres` database as Supabase's init scripts left it (real auth and extensions schemas,
#      non-superuser postgres; `supabase db reset` applies cleanly)             run_pgtap.sh --in-place <db-uri>
#      then, on that migrated database:
#   3. cost parity: the migrated seeds equal cost_model.py (WI-S4-08)        tools/check_cost_parity.py --dsn
#   4. the committed capability fixture equals the one regenerated from it (S4 section 10)
#   5. the api and subject integration suites (WP-13: arena-api's interview path through the real functions, S5 5.2,
#      5.4, 6.2, 6.3; WP-12, S2 6.10, 6.2, 6.7; S5 5.1, 5.2: subject.turn_context and
#      arena.record_subject_turn against the real migrated functions, seeded through the tests.* fixtures the
#      pgTAP suite itself uses (supabase/tests/harness/fixtures.psql); runs before the spend-guard suite since it
#      touches no budget state and nothing it does depends on a ceiling being applied.
#                                     pytest services/api/tests/it_api.py services/subject/tests/it_answer.py
#   6. the spend-guard integration suite (S5 4.10, 3.6; WP-05): the agent port and the guard client against the real
#      migrated functions, then the budget-plan apply and check (D-012). It runs last on this server because it
#      applies ceilings, reserves and turns the kill switch on and off; steps 3 and 4 read the seeds as migrated.
#      Then the pooled connector and one_statement's pipelined transaction on the same database.
#                                pytest packages/core/tests/db/it_spend_guard.py packages/core/tests/db/it_pool.py
#   7. tournament path (WP-17): a third, fresh Supabase Postgres 17 container, migrated the same way as path 2, then
#      the tournament job suite on it. Its own server because the suite commits a ceiling and spend rows that the
#      spend-guard suite (which expects the migrated $0 ceiling) must never see.
#                                 run_pgtap.sh --in-place <db-uri>; pytest services/tournament/tests/it_tournament.py
#   8. the seed_hosted integration suite (S1 10.5, S2 3.1, S4 2.3; feat/hosted-seed): scripts/seed_hosted.py's real
#      case ingest, candidate registration and user allowlist, on a FOURTH disposable database of its own, migrated
#      directly (no pgTAP, no fixtures.psql). Never the shared Supabase-path container: that one's subject_integration
#      step commits dev family F01 through the pgTAP shortcut (tests.seed_family -> tests.bundle_of), whose bundle is
#      built from jsonb::text and is not byte-identical to this script's canonical-JSON one even for the same
#      content, so sealed.ingest_case_family's own dedup check (AR003: a reused family_code must carry identical
#      content) correctly refuses whichever path ingests the same family_code second -- verified by probing both
#      orders against a disposable container, each raising AR003 on its second path. A fourth throwaway database
#      avoids staging that collision rather than loosening the check that is right to catch it.
#                                                    pytest packages/core/tests/db/it_seed_hosted.py
#      Then, on that same throwaway database: the budget plan applied (D-012, buckets seed at $0) and a login
#      granted to arena_public and arena_subject (as the owner grants one on the real project, S4-D4) -- the
#      only two things a real call needs beyond what seed_hosted.py itself provisions -- then the real_smoke
#      integration suite, in ARENA_MODEL_MODE=fake (zero spend): one subject call and one coach card through
#      the real agent port and spend guard.                pytest packages/core/tests/db/it_real_smoke.py
# Every step runs; the script exits 1 if any failed. Needs docker, psql, python3 and uv.
set -euo pipefail
# The URIs below fully name each disposable server: no libpq environment variable may redirect them (PGHOSTADDR
# wins over a host name; a service file can add a hostaddr).
unset PGHOSTADDR PGHOST PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS

# Pinned by digest; a tag older than the 7-day supply-chain cooldown (pyproject exclude-newer). Bump deliberately.
SUPABASE_IMAGE="supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53"
READY_TIMEOUT_S=180

HERE="$(cd "$(dirname "$0")" && pwd)"
TESTS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$TESTS/../.." && pwd)"
PYTHON="${PYTHON:-python3}"
export PYTHON
PLAIN_DOCKERFILE="$HERE/postgres-pgtap.Dockerfile"

for tool in docker psql "$PYTHON" uv; do
  command -v "$tool" >/dev/null || { echo "db-test: FAIL: $tool is not installed" >&2; exit 1; }
done
# `docker version` asks the daemon only; `docker info` also queries CLI plugins and can hang on a stalled one.
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || { echo "db-test: FAIL: the Docker daemon is not running" >&2; exit 1; }

# The plain image is named by the Dockerfile's content, so a changed Dockerfile builds a new image.
PLAIN_IMAGE="arena-postgres-pgtap:$("$PYTHON" -I -c \
  'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()[:16])' "$PLAIN_DOCKERFILE")"
RUN_ID="$$-$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(4))')"
NAMES=(
  "arena-db-test-plain-$RUN_ID" "arena-db-test-supabase-$RUN_ID" "arena-db-test-tournament-$RUN_ID"
  "arena-db-test-seed-$RUN_ID"
)
PGPASSWORD="$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(24))')"   # throwaway, these containers only
export PGPASSWORD
remove() { docker rm -f -v "$1" >/dev/null 2>&1 || true; }
cleanup() {
  local name
  for name in "${NAMES[@]}"; do remove "$name"; done
}
trap cleanup EXIT

# start <name> <image>: run the server and wait until it accepts connections; sets ADMIN (postgresql://...:<port>,
# no database) and ARENA_PGTAP_DBLINK_EXTRA. dblink sessions open from inside the server; the container's own
# address uses password auth there (127.0.0.1 is trust on the Supabase image), which dblink requires of a
# non-superuser, and the published host port is not the port inside the container.
start() {
  local name="$1" image="$2" waited=0 port ip connected=0
  echo "== start $image as $name"
  # -e NAME without a value passes the variable from this environment, so the password never appears in argv.
  if ! POSTGRES_PASSWORD="$PGPASSWORD" docker run -d --rm --name "$name" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 \
       "$image" >/dev/null; then
    echo "db-test: could not start $image" >&2
    return 1
  fi
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null)" == "healthy" ]]; do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" || $waited -ge $READY_TIMEOUT_S ]]
    then
      echo "db-test: $name did not become healthy within ${READY_TIMEOUT_S}s" >&2
      docker logs --tail 40 "$name" >&2 || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  port="$(docker port "$name" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://' || true)"
  # a canonical port number (libpq reads 05432 as 5432), never the reserved 5432
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 || port == 5432 )); then
    echo "db-test: no usable host port for $name (got '$port')" >&2
    return 1
  fi
  ADMIN="postgresql://postgres@127.0.0.1:$port"
  for _ in $(seq 1 30); do
    if psql -X -q -At -d "$ADMIN/postgres" -c "select 1" >/dev/null 2>&1; then connected=1; break; fi
    sleep 1
  done
  [[ $connected -eq 1 ]] || { echo "db-test: cannot connect to $ADMIN/postgres" >&2; return 1; }
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name" || true)"
  [[ -n "$ip" ]] || { echo "db-test: no container address for $name (dblink sessions need it)" >&2; return 1; }
  export ARENA_PGTAP_DBLINK_EXTRA="host=$ip port=5432 user=postgres password=$PGPASSWORD"
}

fail=0
step() {
  local label="$1"
  shift
  echo "== $label"
  if "$@"; then echo "-- OK: $label"; else echo "-- FAIL: $label"; fail=1; fi
}

plain_path() {
  local rc=0
  if ! docker image inspect "$PLAIN_IMAGE" >/dev/null 2>&1; then
    echo "== build $PLAIN_IMAGE from $(basename "$PLAIN_DOCKERFILE")"
    # No build context: the Dockerfile fetches pgTAP itself and verifies its sha256.
    docker build -q -t "$PLAIN_IMAGE" - <"$PLAIN_DOCKERFILE" >/dev/null || { echo "db-test: build failed" >&2; return 1; }
  fi
  start "${NAMES[0]}" "$PLAIN_IMAGE" || rc=1
  if [[ $rc -eq 0 ]]; then "$HERE/run_pgtap.sh" "$ADMIN" || rc=1; fi
  remove "${NAMES[0]}"
  return $rc
}

SUPABASE_UP=0
supabase_path() {
  start "${NAMES[1]}" "$SUPABASE_IMAGE" || return 1
  SUPABASE_UP=1
  "$HERE/run_pgtap.sh" --in-place "$ADMIN/postgres"
}
# Steps 3 and 4 read the database the Supabase path migrated; they fail, never pass, when it is not up.
supabase_up() {
  [[ $SUPABASE_UP -eq 1 ]] || { echo "db-test: the Supabase server is not up"; return 1; }
}
cost_parity() {
  supabase_up || return 1
  (cd "$ROOT" && uv run --locked python -m tools.check_cost_parity --dsn "$ADMIN/postgres")
}
regenerate_capability_fixture() {
  supabase_up || return 1
  mkdir -p "$ROOT/.gates"
  local generated="$ROOT/.gates/capability_matrix.generated.csv"
  if ! (cd "$TESTS" && psql -X -q -v ON_ERROR_STOP=1 -d "$ADMIN/postgres" -f harness/capability_matrix.psql) >"$generated"
  then
    echo "could not regenerate the capability fixture from the migrated database"
    return 1
  fi
  if ! diff -u "$TESTS/fixtures/capability_matrix.csv" "$generated"; then
    echo "the fixture differs from the migrated database; after review: cp $generated $TESTS/fixtures/capability_matrix.csv"
    return 1
  fi
}

seed_hosted_integration() {
  # Its OWN disposable database (the fourth container, never the shared supabase_path one): see the header
  # comment, step 7, for why sharing it with subject_integration's tests.seed_family('F01') would raise AR003
  # on whichever path ingests F01 second. Migrated directly (psql, no run_pgtap.sh): this suite needs no
  # pgTAP extension, no dblink and no fixtures.psql, only the plain migrations.
  local name="arena-db-test-seed-$RUN_ID" saved_admin="${ADMIN:-}" rc=0 f
  if ! start "$name" "$SUPABASE_IMAGE"; then
    ADMIN="$saved_admin"
    remove "$name"
    return 1
  fi
  local dsn="$ADMIN/postgres" port="${ADMIN##*:}"
  ADMIN="$saved_admin"   # restored immediately: no later step may read this container's address as the shared one
  for f in "$ROOT"/supabase/migrations/*.sql; do
    psql -X -q -v ON_ERROR_STOP=1 -d "$dsn" -f "$f" >/dev/null || { rc=1; break; }
  done
  if [[ $rc -eq 0 ]]; then
    (cd "$ROOT" && ARENA_IT_ADMIN_DSN="$dsn" uv run --locked pytest -c pyproject.toml --rootdir . \
      -p no:cacheprovider -W error packages/core/tests/db/it_seed_hosted.py) || rc=1
  fi
  # real_smoke needs three things beyond the dev families and candidates it_seed_hosted.py already ingested:
  # its own acting user allowlisted too (another idempotent seed_hosted.py call, exactly the operator's own
  # make seed-hosted EMAIL=... then make real-smoke sequence), the budget plan applied (buckets seed at $0,
  # fail-closed, D-012) and a login for the two runtime roles it calls as (this container's admin created
  # them NOLOGIN, as the owner's project does; S4-D4 the owner grants a login once, same as dev.sh).
  local email="it-real-smoke@arena.local" pub_pw subj_pw users_toml
  if [[ $rc -eq 0 ]]; then
    (cd "$ROOT" && ARENA_OWNER_DSN="$dsn" uv run --locked python -m scripts.seed_hosted --email "$email" \
      >/dev/null) || rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    (cd "$ROOT" && ARENA_OWNER_DSN="$dsn" uv run --locked python -m scripts.budget_plan --apply \
      --dsn-env ARENA_OWNER_DSN >/dev/null) || rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    pub_pw="$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(24))')"
    subj_pw="$("$PYTHON" -I -c 'import secrets; print(secrets.token_hex(24))')"
    psql -X -q -v ON_ERROR_STOP=1 -d "$dsn" -c "alter role arena_public login password '$pub_pw'" >/dev/null \
      && psql -X -q -v ON_ERROR_STOP=1 -d "$dsn" -c "alter role arena_subject login password '$subj_pw'" \
        >/dev/null || rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    users_toml="$(mktemp -t arena-real-smoke-users.XXXXXX)"
    printf '[[users]]\nemail = "%s"\ndisplay_name = "db-test real_smoke"\nroles = ["investigator"]\n' "$email" \
      >"$users_toml"
    (cd "$ROOT" && ARENA_IT_ADMIN_DSN="$dsn" \
      ARENA_IT_REAL_SMOKE_PUBLIC_DSN="postgresql://arena_public:$pub_pw@127.0.0.1:$port/postgres" \
      ARENA_IT_REAL_SMOKE_SUBJECT_DSN="postgresql://arena_subject:$subj_pw@127.0.0.1:$port/postgres" \
      ARENA_IT_REAL_SMOKE_EMAIL="$email" ARENA_IT_REAL_SMOKE_USERS_FILE="$users_toml" \
      uv run --locked pytest -c pyproject.toml --rootdir . -p no:cacheprovider -W error \
      packages/core/tests/db/it_real_smoke.py) || rc=1
    rm -f "$users_toml"
  fi
  remove "$name"
  return $rc
}

subject_integration() {
  supabase_up || return 1
  local dsn="$ADMIN/postgres"
  (cd "$ROOT" && ARENA_IT_ADMIN_DSN="$dsn" uv run --locked pytest -c pyproject.toml --rootdir . \
    -p no:cacheprovider -W error services/api/tests/it_api.py services/referee/tests/it_admin.py \
    services/subject/tests/it_answer.py)
}

# Runs last: `start` replaces ADMIN, which the steps on the Supabase path's server read.
tournament_path() {
  local rc=0
  start "${NAMES[2]}" "$SUPABASE_IMAGE" || rc=1
  if [[ $rc -eq 0 ]]; then "$HERE/run_pgtap.sh" --in-place "$ADMIN/postgres" || rc=1; fi
  if [[ $rc -eq 0 ]]; then
    (cd "$ROOT" && ARENA_IT_ADMIN_DSN="$ADMIN/postgres" uv run --locked pytest -c pyproject.toml --rootdir . \
      -p no:cacheprovider -W error services/tournament/tests/it_tournament.py) || rc=1
  fi
  remove "${NAMES[2]}"
  return $rc
}

spend_guard_integration() {
  supabase_up || return 1
  local dsn="$ADMIN/postgres"
  (cd "$ROOT" && ARENA_IT_ADMIN_DSN="$dsn" uv run --locked pytest -c pyproject.toml --rootdir . \
    -p no:cacheprovider -W error packages/core/tests/db/it_spend_guard.py packages/core/tests/db/it_pool.py)
}

step "migrations and pgTAP on plain PostgreSQL 17 with pgTAP, throwaway database with the shim (plain path)" plain_path
step "migrations and pgTAP on the Supabase Postgres 17 container's database (Supabase path)" supabase_path
step "cost parity of the migrated seeds with cost_model.py (WI-S4-08)" cost_parity
step "capability fixture equals the one regenerated from the migrated database" regenerate_capability_fixture
step "api and subject integration suites on the migrated database (the interview path, turn_context, record_subject_turn)" \
  subject_integration
step "spend-guard integration suite on the migrated database (agent port, guard client, budget plan)" \
  spend_guard_integration
step "tournament job integration suite on its own freshly migrated Supabase container (roster through close, a real arena-referee subprocess, WP-17)" \
  tournament_path
SEED_HOSTED_LABEL="seed_hosted and real_smoke integration suites on their own migrated database (real case ingest, candidate registration, allowlist, then one real-shaped subject call and coach card in fake mode)"
step "$SEED_HOSTED_LABEL" seed_hosted_integration
cleanup

if [[ $fail -ne 0 ]]; then
  echo "db-test: FAIL"
  exit 1
fi
echo "db-test: OK"
