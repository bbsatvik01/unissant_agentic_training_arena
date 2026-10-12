#!/usr/bin/env bash
# Local fake-model stack for clicking through a whole interview (S5 10; D-016). Nothing here touches the hosted
# Supabase project or Vertex: the database is a disposable local container, ARENA_MODEL_MODE=fake.
#
#   scripts/dev.sh db-up        start a local Supabase Postgres 17 container on 127.0.0.1 (a Docker-picked port,
#                               never 5432), apply supabase/migrations, seed the dev families F01-F03 through the
#                               shared fixture loader (supabase/tests/harness/fixtures.psql), register the
#                               official candidates from prompts/manifests, apply the budget plan, and write its
#                               own .env.local, .env.local.{public,subject,referee} and users.toml into .run/localdb/
#                               (git-ignored); it refuses to write over any existing file there
#   ENV_DIR=<dir> scripts/dev.sh up
#                               start arena-api :8080, arena-subject :8081, arena-referee :8082 and the web dev
#                               server (when web/node_modules exists), each with a clean environment holding only
#                               .env.local plus its own role file (S5 10.2), both read from ENV_DIR (default: the
#                               repository root, the owner's Supabase role files; ENV_DIR=.run/localdb for the
#                               container from db-up). A missing root .env.local is generated (fake mode, dev user),
#                               never overwritten. Ctrl-C stops all of them
#   scripts/dev.sh export-run <trial-id> [out]
#                               write recordings/<trial-id>.json (D-021) through the same projection as the API
#   scripts/dev.sh db-down      remove the container and .run/localdb/; never touches the root .env.local* files
#
# The acting user is dev@arena.local (investigator), on the generated allowlist. Owner credential use is limited to
# db-up, against the local container only (S5 10.2 item 5): it is never written to an env file.
set -euo pipefail
unset PGHOSTADDR PGHOST PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN="$ROOT/.run"
LOCALDB="$RUN/localdb"
ENV_DIR="${ENV_DIR:-$ROOT}"
case "$ENV_DIR" in /*) ;; *) ENV_DIR="$ROOT/$ENV_DIR" ;; esac
# Canonical, so "." or a trailing slash still names the root (symlinks resolved).
[[ -d "$ENV_DIR" ]] && ENV_DIR="$(cd "$ENV_DIR" && pwd -P)"
CONTAINER="${ARENA_DEV_CONTAINER:-arena-dev-db}"  # override to run a second local stack beside another
# The image make db-test runs (supabase/tests/harness/db_test.sh), pinned by digest.
IMAGE="supabase/postgres:17.11.0.002@sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53"
DEV_USER="dev@arena.local"
FAMILIES=(F01 F02 F03)

die() { echo "dev.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is not installed"; }
secret() { python3 -I -c 'import secrets; print(secrets.token_hex(24))'; }

# Write a new file (mode 0600) from stdin; refuse to replace anything at that path. noclobber creates the file
# exclusively (O_EXCL), so a file or a symlink appearing between the check and the write is refused too.
new_file() {
  [[ ! -e "$1" && ! -L "$1" ]] || die "$1 exists; refusing to overwrite it"
  (umask 077; set -o noclobber; cat >"$1") || die "could not create $1 exclusively"
}

# The disposable database's own directory: a real directory under .run, never a symlink to somewhere else.
localdb_dir() {
  [[ ! -L "$RUN" && ! -L "$LOCALDB" ]] || die "$RUN or $LOCALDB is a symlink; refusing to use it"
  mkdir -p "$LOCALDB"; chmod 700 "$RUN" "$LOCALDB"
}

db_up() {
  need docker; need psql; need uv
  localdb_dir
  local target
  for target in .env.local .env.local.public .env.local.subject .env.local.referee users.toml; do
    [[ ! -e "$LOCALDB/$target" && ! -L "$LOCALDB/$target" ]] || die "$LOCALDB/$target exists; run: scripts/dev.sh db-down"
  done
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
    "$DEV_USER" | new_file "$LOCALDB/users.toml"

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
    echo "$var=postgresql://$role:$pw@127.0.0.1:$port/postgres" | new_file "$LOCALDB/.env.local.$file"
  done
  new_file "$LOCALDB/.env.local" <<EOF
ARENA_ENV=local
ARENA_GCP_PROJECT=cna-guardian
ARENA_MODEL_MODE=fake
ARENA_DEV_USER=$DEV_USER
ARENA_USERS_FILE=$LOCALDB/users.toml
ARENA_CASE_DRAW_SEED=20261011
EOF
  echo "dev.sh: local database ready on 127.0.0.1:$port; next: make dev-local"
}

db_down() {
  # The files go first, right after the directory check, before anything slow runs.
  localdb_dir
  rm -f "$LOCALDB"/.env.local "$LOCALDB"/.env.local.public "$LOCALDB"/.env.local.subject \
    "$LOCALDB"/.env.local.referee "$LOCALDB"/users.toml
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
}

# The shared settings of a run against the owner's project: generated once when absent, never overwritten.
root_env() {
  [[ "$ENV_DIR" == "$ROOT" && ! -e "$ROOT/.env.local" ]] || return 0
  mkdir -p "$RUN"; chmod 700 "$RUN"
  if [[ ! -e "$RUN/users.toml" ]]; then
    printf '[[users]]\nemail = "%s"\ndisplay_name = "Local investigator"\nroles = ["investigator", "trainer", "admin"]\n' \
      "$DEV_USER" | new_file "$RUN/users.toml"
  fi
  new_file "$ROOT/.env.local" <<EOF
ARENA_ENV=local
ARENA_GCP_PROJECT=cna-guardian
ARENA_MODEL_MODE=fake
ARENA_DEV_USER=$DEV_USER
ARENA_USERS_FILE=$RUN/users.toml
ARENA_CASE_DRAW_SEED=20261011
EOF
  echo "dev.sh: wrote $ROOT/.env.local (fake mode, $DEV_USER)"
}

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
  need uv; need git
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

  root_env
  local f
  for f in .env.local .env.local.public .env.local.subject .env.local.referee; do
    [[ -f "$ENV_DIR/$f" ]] || die "missing $ENV_DIR/$f"
  done
  grep -q '_DSN=' "$ENV_DIR/.env.local" && die ".env.local must not contain a DSN (S5 10.2)"
  read_env "$ENV_DIR/.env.local" "$ENV_DIR/.env.local.subject"
  # The voice route admits the api's token only (S5 7.1); the tournament's token reaches /internal/answer alone.
  ENV_OUT=("${base[@]}" "${ENV_OUT[@]}" ARENA_ROLE=subject ARENA_LOCAL_CALLERS="$callers"
           ARENA_VOICE_CALLER="$(hash_of "$api_token")")
  launch arena-subject uv run --locked python -m arena_subject

  # The referee refuses to boot without the code version its gate and leaderboard evidence bind to (S3 9).
  local git_sha
  git_sha="$(git -C "$ROOT" rev-parse --verify HEAD)" || die "cannot read the checkout's commit (git rev-parse HEAD)"
  read_env "$ENV_DIR/.env.local" "$ENV_DIR/.env.local.referee"
  ENV_OUT=("${base[@]}" "${ENV_OUT[@]}" ARENA_ROLE=referee ARENA_LOCAL_CALLERS="$callers" ARENA_GIT_SHA="$git_sha")
  launch arena-referee uv run --locked uvicorn --factory arena_referee.app:create_app --host 127.0.0.1 --port 8082

  read_env "$ENV_DIR/.env.local" "$ENV_DIR/.env.local.public"
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
  read_env "$ENV_DIR/.env.local" "$ENV_DIR/.env.local.public"
  (cd "$ROOT" && env -i PATH="$PATH" HOME="$HOME" "${ENV_OUT[@]}" ARENA_ROLE=api \
    uv run --locked python -m scripts.export_run --trial "$trial" --out "$out")
}

# D-021: a small fake-model dev tournament end to end, against the already-running stack (`scripts/dev.sh up`
# in another terminal; its caller token for arena-referee is `$RUN/tournament.token`, already in the
# running arena-subject's and arena-referee's ARENA_LOCAL_CALLERS, S8 WP-17). The operator script holds both
# the referee and public env files at once (setup, then the job run); a running role process never does.
tournament() {
  need uv
  [[ -f "$RUN/tournament.token" ]] || die "the stack is not running; run scripts/dev.sh up in another terminal first"
  local token; token="$(cat "$RUN/tournament.token")"
  read_env "$ENV_DIR/.env.local" "$ENV_DIR/.env.local.referee" "$ENV_DIR/.env.local.public"
  (cd "$ROOT" && env -i PATH="$PATH" HOME="$HOME" "${ENV_OUT[@]}" ARENA_LOCAL_CALLER_TOKEN="$token" \
    uv run --locked python -m scripts.dev_tournament_demo "$@")
}

case "${1:-}" in
  db-up) db_up ;;
  db-down) db_down ;;
  up) up ;;
  export-run) shift; export_run "$@" ;;
  tournament) shift; tournament "$@" ;;
  *) die "usage: scripts/dev.sh db-up | up | export-run <trial-id> [out] | tournament [--families F01 F02] | db-down" ;;
esac
