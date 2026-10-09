#!/usr/bin/env bash
# pgTAP runner (S4 sql/TESTS.md section 0; WI-S4-02). Lifted from TechnoMile
# supabase/tests/harness/run_pgtap.sh (ATTRIBUTIONS.md) and tightened: each file's output must be an exactly
# well-formed, all-ok TAP stream (tools/pgtap_verdict.py: one plan, tests numbered 1..N once each in order, no
# not ok, no SKIP or TODO, no Bail out!, no error line, psql exit 0); pgTAP skip and todo calls are refused in the
# suite's source in any spelling (tools/pgtap_ban.py); a run with no migration or no test file fails; only loopback
# servers are accepted.
#
# Usage:
#   run_pgtap.sh <admin-uri>             Drop and create the throwaway database arena_pgtap on that server, load
#                                        the shim, create pgtap and dblink in schema extensions, apply
#                                        supabase/migrations/*.sql in order (one transaction per file), run every
#                                        supabase/tests/*.sql file. <admin-uri> names no database:
#                                        postgresql://postgres@127.0.0.1:54329
#   run_pgtap.sh --in-place <db-uri>     The same against an existing, FRESH local Supabase database (its own
#                                        auth and extensions schemas; no shim); refused when the arena schema
#                                        already exists. db_test.sh runs it on its container's postgres database.
#
# URIs: postgresql:// on 127.0.0.1, localhost or [::1], with an explicit canonical port (1-65535, no leading zero)
# other than 5432, no password and no query string (the password comes from PGPASSWORD). The libpq environment
# variables that could send a connection elsewhere (PGHOSTADDR, PGHOST, PGPORT, PGSERVICE, PGSERVICEFILE,
# PGDATABASE, PGOPTIONS) are cleared first, so the URI alone decides the server. Never point this at a hosted
# Supabase project.
# Environment:
#   ARENA_PGTAP_DBLINK_EXTRA  libpq keywords the server uses for its own dblink sessions (concurrency tests) when
#                             the URI does not reach the server from inside it (a container behind a published
#                             port), e.g. "host=172.17.0.2 port=5432 user=postgres password=...". Unset, the dblink
#                             sessions go to the URI's own host, port and database as the user psql connects as
#                             (the URI's, else PGUSER, else the login name), with PGPASSWORD when set. Tests read
#                             the full connection string from the setting arena_test.dblink_dsn.
#   PYTHON                    interpreter (default python3) for cost_model.py --plan-json, tools/pgtap_ban.py and
#                             tools/pgtap_verdict.py, all run isolated (python -I -B).
# Every test file receives the psql variable `plan`: the stdout of
#   python3 -I -B docs/research/synthesis/cost_model.py --plan-json   (pure JSON, D-012, D-013)
set -euo pipefail
shopt -s nullglob
# libpq gives PGHOSTADDR precedence over a URI's host name, and a service file can add a hostaddr: none of these
# may redirect a connection the guard below has checked.
unset PGHOSTADDR PGHOST PGPORT PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS
PYTHON="${PYTHON:-python3}"

usage() { echo "usage: run_pgtap.sh <admin-uri> | --in-place <db-uri>" >&2; exit 2; }

MODE=throwaway
if [[ "${1:-}" == "--in-place" ]]; then MODE=in-place; shift; fi
[[ $# -eq 1 ]] || usage
URI="$1"

# scheme://[user@]host:port[/db]; the port is mandatory and canonical (5432 belongs to another server on the
# workstation, and libpq reads 05432 as 5432, so the port is checked as a number in its one spelling).
URI_RE='^postgres(ql)?://([A-Za-z0-9_.-]+@)?(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})(/([A-Za-z0-9_]+))?$'
if [[ ! "$URI" =~ $URI_RE ]]; then
  # The refused URI is not echoed: it may carry a password.
  echo "run_pgtap: refused the URI: need postgresql://[user@]<loopback host>:<port>[/db], no password, no query" >&2
  exit 2
fi
URI_USER="${BASH_REMATCH[2]%@}"
URI_HOST="${BASH_REMATCH[3]}"
PORT="${BASH_REMATCH[4]}"
DBNAME="${BASH_REMATCH[6]:-}"
if (( PORT > 65535 || PORT == 5432 )); then
  echo "run_pgtap: refused port $PORT (5432 is reserved for another server; ports end at 65535)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
TESTS="$(cd "$HERE/.." && pwd)"          # supabase/tests
SUPA="$(cd "$TESTS/.." && pwd)"          # supabase
ROOT="$(cd "$SUPA/.." && pwd)"           # repository root
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

migrations=("$SUPA"/migrations/*.sql)
tests=("$TESTS"/*.sql)
harness=("$HERE"/*.psql)
if [[ ${#migrations[@]} -eq 0 || ${#tests[@]} -eq 0 ]]; then
  echo "run_pgtap: FAIL: ${#migrations[@]} migrations and ${#tests[@]} test files found; both must be non-empty" >&2
  exit 1
fi

# Static half of "no skip, no todo" (global never-rig rule): pgTAP's skip and todo functions may not appear in
# any test or harness file in any spelling (schema-qualified, quoted, any case, comments before the parenthesis),
# not even in a branch that does not run here (tools/pgtap_ban.py). The runtime half is the per-file verdict
# below, which fails any SKIP or TODO directive that does run.
ban_status=0
"$PYTHON" -I -B "$ROOT/tools/pgtap_ban.py" "${tests[@]}" "${harness[@]}" || ban_status=$?
if [[ $ban_status -ne 0 ]]; then
  exit 1
fi

PLAN="$("$PYTHON" -I -B "$ROOT/docs/research/synthesis/cost_model.py" --plan-json)"
if [[ "$PLAN" != \{* ]]; then
  echo "run_pgtap: FAIL: cost_model.py --plan-json printed no JSON object: $PLAN" >&2
  exit 1
fi

if [[ "$MODE" == "throwaway" ]]; then
  [[ -z "$DBNAME" ]] || { echo "run_pgtap: the admin URI names no database (got /$DBNAME)" >&2; exit 2; }
  DB="arena_pgtap"
  "${PSQL[@]}" -d "$URI/postgres" -c "drop database if exists $DB with (force)" -c "create database $DB"
  DSN="$URI/$DB"
  "${PSQL[@]}" -d "$DSN" -f "$HERE/supabase_shim.psql"
else
  [[ -n "$DBNAME" ]] || { echo "run_pgtap: --in-place needs a database in the URI" >&2; exit 2; }
  DB="$DBNAME"
  DSN="$URI"
  fresh="$("${PSQL[@]}" -d "$DSN" -At -c "select to_regnamespace('arena') is null")"
  if [[ "$fresh" != "t" ]]; then
    echo "run_pgtap: refused: $DB already has the arena schema (--in-place needs a fresh database)" >&2
    exit 2
  fi
fi

"${PSQL[@]}" -d "$DSN" -c "create extension if not exists pgtap with schema extensions" \
                       -c "create extension if not exists dblink with schema extensions"
for m in "${migrations[@]}"; do
  echo "apply $(basename "$m")"
  "${PSQL[@]}" --single-transaction -d "$DSN" -f "$m"
done

# A libpq conninfo value, single-quoted with backslash and quote escaped (libpq conninfo rule). The quote goes
# through a variable: bash 3.2 (macOS) keeps a backslash-escaped quote's backslash in a replacement.
conninfo_value() {
  local q="'" v="${1//\\/\\\\}"
  v="${v//$q/\\$q}"
  printf "'%s'" "$v"
}
if [[ -n "${ARENA_PGTAP_DBLINK_EXTRA:-}" ]]; then
  dblink_dsn="dbname=$DB $ARENA_PGTAP_DBLINK_EXTRA"
else
  # The server the URI names, seen from inside that server: the same host and port (a server on the workstation),
  # the user psql connected as, and the password psql used; never libpq's default socket or port.
  dblink_host="${URI_HOST#[}"
  dblink_dsn="host=${dblink_host%]} port=$PORT dbname=$DB user=$(conninfo_value "${URI_USER:-${PGUSER:-$(id -un)}}")"
  if [[ -n "${PGPASSWORD:-}" ]]; then dblink_dsn+=" password=$(conninfo_value "$PGPASSWORD")"; fi
fi
# The server splits PGOPTIONS into words at every isspace() character and takes the character after a backslash
# literally (postinit.c pg_split_opts): double every backslash, then escape space, tab, newline, vertical tab,
# form feed and carriage return.
dblink_dsn="${dblink_dsn//\\/\\\\}"
for ws in ' ' $'\t' $'\n' $'\v' $'\f' $'\r'; do
  dblink_dsn="${dblink_dsn//$ws/\\$ws}"
done
pgoptions="-c search_path=public,extensions -c arena_test.dblink_dsn=$dblink_dsn"

fail=0
for t in "${tests[@]}"; do
  name="$(basename "$t")"
  rc=0
  # cwd = supabase/tests, so \copy and \ir paths in test files resolve the same everywhere
  out="$(cd "$TESTS" && PGOPTIONS="$pgoptions" psql -X -tA -v ON_ERROR_STOP=1 -v plan="$PLAN" -d "$DSN" -f "$t" 2>&1)" \
    || rc=$?
  # One strict, tested verdict (tools/pgtap_verdict.py) prints PASS or FAIL with the reasons; a failing file never
  # stops the run, so every file's result is reported.
  if ! printf '%s\n' "$out" | "$PYTHON" -I -B "$ROOT/tools/pgtap_verdict.py" --name "$name" --psql-exit "$rc"; then
    fail=1
  fi
done
exit $fail
