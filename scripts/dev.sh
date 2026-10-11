#!/usr/bin/env bash
# Local fake-model stack for clicking through a whole interview (S5 10; D-016). Nothing here touches the hosted
# Supabase project or Vertex: the database is a disposable local container, ARENA_MODEL_MODE=fake.
#
#   scripts/dev.sh db-up        start a local Supabase Postgres 17 container on 127.0.0.1 (a Docker-picked port,
#                               never 5432), apply supabase/migrations, seed the dev families F01-F03 through the
#                               shared fixture loader (supabase/tests/harness/fixtures.psql), register the
#                               official candidates from prompts/manifests, apply the budget plan, and write the
#                               git-ignored .env.local, .env.local.{public,subject,referee} and .run/users.toml
#   scripts/dev.sh up           start arena-api :8080, arena-subject :8081, arena-referee :8082 and the web dev
#                               server (when web/node_modules exists), each with a clean environment holding only
#                               .env.local plus its own role file (S5 10.2); Ctrl-C stops all of them
#   scripts/dev.sh export-run <trial-id> [out]
#                               write recordings/<trial-id>.json (D-021) through the same projection as the API
#   scripts/dev.sh db-down      remove the container
#
# The acting user is dev@arena.local (investigator), on the generated allowlist. Owner credential use is limited to
# db-up, against the local container only (S5 10.2 item 5): it is never written to an env file.
set -euo pipefail
unset PGHOSTADDR PGHOST PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"
CONTAINER="arena-dev-db"
# The image make db-test runs (supabase/tests/harness/db_test.sh), pinned by digest.
IMAGE="supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53"
DEV_USER="dev@arena.local"
FAMILIES=(F01 F02 F03)

die() { echo "dev.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is not installed"; }
secret() { python3 -I -c 'import secrets; print(secrets.token_hex(24))'; }

db_up() {
  need docker; need psql; need uv
  mkdir -p "$RUN"; chmod 700 "$RUN"
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then die "$CONTAINER exists; run: scripts/dev.sh db-down"; fi
  local owner_pw; owner_pw="$(secret)"
  POSTGRES_PASSWORD="$owner_pw" docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 "$IMAGE" \
    >/dev/null
  local waited=0
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")" == "healthy" ]]; do
    (( waited++ < 180 )) || die "$CONTAINER did not become healthy"
    sleep 1
  done
  local port; port="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
  [[ "$port" =~ ^[1-9][0-9]{1,4}$ && "$port" != 5432 ]] || die "no usable port ($port)"
  local owner="postgresql://postgres:$owner_pw@127.0.0.1:$port/postgres"
  for _ in $(seq 1 30); do psql -X -q -d "$owner" -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  local psql_owner=(psql -X -q -v ON_ERROR_STOP=1 -d "$owner")

  echo "== migrations"
  for f in "$ROOT"/supabase/migrations/*.sql; do "${psql_owner[@]}" -f "$f" >/dev/null; done

  echo "== dev families ${FAMILIES[*]} and candidates"
  "${psql_owner[@]}" -c 'create extension if not exists pgtap with schema extensions' >/dev/null
  (cd "$ROOT/supabase/tests" && "${psql_owner[@]}" -f harness/fixtures.psql >/dev/null)
  for code in "${FAMILIES[@]}"; do "${psql_owner[@]}" -c "select tests.seed_family('$code')" >/dev/null; done
  for m in "$ROOT"/prompts/manifests/*.json; do
    # psql interpolates :'m' only in input it reads (-f), never in -c.
    echo "select arena.register_candidate(x->>'kind', x->>'candidate_id', x->>'version', x) from (select :'m'::jsonb x) s" \
      | "${psql_owner[@]}" -v m="$(cat "$m")" -f - >/dev/null
  done

  echo "== allowlisted user $DEV_USER"
  local uid; uid="$(cd "$ROOT" && uv run --locked python -I -c \
    'import sys; from arena_core.identity import user_id_for; print(user_id_for(sys.argv[1]))' "$DEV_USER")"
  "${psql_owner[@]}" -c "insert into auth.users (id, email) values ('$uid', '$DEV_USER') on conflict do nothing" \
    >/dev/null
  printf '[[users]]\nemail = "%s"\ndisplay_name = "Local investigator"\nroles = ["investigator", "trainer", "admin"]\n' \
    "$DEV_USER" >"$RUN/users.toml"

  echo "== budget plan (D-012)"
  (cd "$ROOT" && ARENA_OWNER_DSN="$owner" uv run --locked python -m scripts.budget_plan --apply \
    --dsn-env ARENA_OWNER_DSN >/dev/null)

  echo "== role credentials"
  umask 077
  local role var file pw
  for spec in "arena_public ARENA_PUBLIC_DSN public" "arena_subject ARENA_SUBJECT_DSN subject" \
              "arena_referee ARENA_REFEREE_DSN referee"; do
    read -r role var file <<<"$spec"
    pw="$(secret)"
    "${psql_owner[@]}" -c "alter role $role login password '$pw'" >/dev/null
    echo "$var=postgresql://$role:$pw@127.0.0.1:$port/postgres" >"$ROOT/.env.local.$file"
  done
  cat >"$ROOT/.env.local" <<EOF
ARENA_ENV=local
ARENA_GCP_PROJECT=cna-guardian
ARENA_MODEL_MODE=fake
ARENA_DEV_USER=$DEV_USER
ARENA_USERS_FILE=$RUN/users.toml
ARENA_CASE_DRAW_SEED=20261011
EOF
  echo "dev.sh: local database ready on 127.0.0.1:$port; next: scripts/dev.sh up"
}

db_down() { docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true; rm -f "$ROOT"/.env.local.public "$ROOT"/.env.local.subject "$ROOT"/.env.local.referee; }

# Child environments are built from scratch: an allowlisted base, .env.local, then exactly one role file (S5 10.2).
read_env() {
  local out=()
  local line
  for f in "$@"; do while IFS= read -r line; do [[ -n "$line" && "$line" != \#* ]] && out+=("$line"); done <"$f"; done
  ENV_OUT=("${out[@]}")
}

PIDS=()
launch() {
  local name="$1"; shift
  echo "== start $name"
  (cd "$ROOT" && exec env -i "${ENV_OUT[@]}" "$@") &
  PIDS+=("$!")
}

stop_all() {
  local pid
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -f "$RUN/stack.pid" "$RUN/tournament.token"
}

up() {
  need uv
  mkdir -p "$RUN"; chmod 700 "$RUN"
  if [[ -f "$RUN/stack.pid" ]] && kill -0 "$(cat "$RUN/stack.pid")" 2>/dev/null; then die "the stack is already running"; fi
  echo $$ >"$RUN/stack.pid"
  trap stop_all EXIT INT TERM
  local api_token tournament_token hash_of callers
  api_token="$(secret)"; tournament_token="$(secret)"
  hash_of() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
  callers="$(hash_of "$api_token"),$(hash_of "$tournament_token")"
  (umask 077; echo "$tournament_token" >"$RUN/tournament.token")
  local base=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" TZ="${TZ:-UTC}")

  grep -q '_DSN=' "$ROOT/.env.local" && die ".env.local must not contain a DSN (S5 10.2)"
  read_env "$ROOT/.env.local" "$ROOT/.env.local.subject"
  ENV_OUT=("${base[@]}" "${ENV_OUT[@]}" ARENA_ROLE=subject ARENA_LOCAL_CALLERS="$callers")
  launch arena-subject uv run --locked python -m arena_subject

  read_env "$ROOT/.env.local" "$ROOT/.env.local.referee"
  ENV_OUT=("${base[@]}" "${ENV_OUT[@]}" ARENA_ROLE=referee ARENA_LOCAL_CALLERS="$callers")
  launch arena-referee uv run --locked uvicorn --factory arena_referee.app:create_app --host 127.0.0.1 --port 8082

  read_env "$ROOT/.env.local" "$ROOT/.env.local.public"
  ENV_OUT=("${base[@]}" "${ENV_OUT[@]}" ARENA_ROLE=api ARENA_LOCAL_CALLER_TOKEN="$api_token")
  launch arena-api uv run --locked python -m arena_api

  if [[ -d "$ROOT/web/node_modules" ]]; then
    ENV_OUT=("${base[@]}")
    (cd "$ROOT/web" && exec env -i "${ENV_OUT[@]}" pnpm dev) &
    PIDS+=("$!")
  else
    echo "dev.sh: web/node_modules missing; run make bootstrap for the web app (the API still runs)"
  fi
  echo "dev.sh: stack up (api http://127.0.0.1:8080); Ctrl-C stops it"
  wait
}

export_run() {
  local trial="${1:?usage: scripts/dev.sh export-run <trial-id> [out]}"
  local out="${2:-$ROOT/recordings/$trial.json}"
  read_env "$ROOT/.env.local" "$ROOT/.env.local.public"
  (cd "$ROOT" && env -i PATH="$PATH" HOME="$HOME" "${ENV_OUT[@]}" ARENA_ROLE=api \
    uv run --locked python -m scripts.export_run --trial "$trial" --out "$out")
}

case "${1:-}" in
  db-up) db_up ;;
  db-down) db_down ;;
  up) up ;;
  export-run) shift; export_run "$@" ;;
  *) die "usage: scripts/dev.sh db-up | up | export-run <trial-id> [out] | db-down" ;;
esac
