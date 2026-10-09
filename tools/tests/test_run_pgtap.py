"""Gateproofs for supabase/tests/harness/run_pgtap.sh (S4 sql/TESTS.md section 0; WI-S4-02): the runner fails on
any failing, skipped or TODO test and on any malformed TAP stream (tools/pgtap_verdict.py), on a psql error, on a
pgTAP skip or todo call anywhere in the suite, and refuses servers off the loopback interface or on port 5432 in
any spelling, whatever the libpq environment says.

The real runner runs against a stub `psql` on PATH that prints canned TAP output (`<test>.tap` beside each test
file, exit code from `<test>.exit`), so these proofs need neither Docker nor a database. `make db-test` runs the
same runner against a real Supabase Postgres 17.
"""

import getpass
import secrets
import shlex
import shutil
import stat
import sys
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT

URI = "postgresql://postgres@127.0.0.1:54329"
REFUSED = 2  # run_pgtap.sh exit status for a refused server or bad arguments (failing tests exit 1)
OK_TAP = "1..2\nok 1 - first\nok 2 - second\n"

REDIRECTS = ("PGHOSTADDR", "PGHOST", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGOPTIONS")

STUB = """
import os, pathlib, sys
args = sys.argv[1:]
redirects = ("PGHOSTADDR", "PGHOST", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE")
with open(os.environ["FAKE_PSQL_LOG"], "a") as log:
    log.write(" ".join(args) + "\\n")
    log.writelines(f"env {name}={os.environ[name]}\\n" for name in redirects if name in os.environ)
    if "PGOPTIONS" in os.environ:
        log.write("pgoptions " + os.environ["PGOPTIONS"].encode("unicode_escape").decode() + "\\n")
if "-f" in args:
    target = pathlib.Path(args[args.index("-f") + 1])
    tap = target.with_suffix(".tap")
    if tap.exists():
        sys.stdout.write(tap.read_text())
        code = target.with_suffix(".exit")
        sys.exit(int(code.read_text()) if code.exists() else 0)
if any("to_regnamespace('arena')" in a for a in args):
    print(os.environ.get("FAKE_PSQL_FRESH", "t"))
"""


@pytest.fixture
def suite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A minimal repository: the real runner and shim, one migration, the real cost model, a stub psql on PATH."""
    root = tmp_path / "repo"
    harness = root / "supabase" / "tests" / "harness"
    harness.mkdir(parents=True)
    for name in ("run_pgtap.sh", "supabase_shim.psql"):
        shutil.copy2(REPO_ROOT / "supabase" / "tests" / "harness" / name, harness / name)
    (root / "tools").mkdir()
    for name in ("pgtap_verdict.py", "pgtap_ban.py"):
        shutil.copy2(REPO_ROOT / "tools" / name, root / "tools" / name)
    (root / "supabase" / "migrations").mkdir()
    (root / "supabase" / "migrations" / "20261008000100_x.sql").write_text("select 1;\n")
    model = root / "docs" / "research" / "synthesis"
    model.mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "docs" / "research" / "synthesis" / "cost_model.py", model / "cost_model.py")

    bindir = tmp_path / "bin"
    bindir.mkdir()
    script = bindir / "psql_stub.py"
    script.write_text(STUB)
    wrapper = bindir / "psql"
    wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_PSQL_LOG", str(tmp_path / "psql.log"))
    monkeypatch.setenv("PYTHON", sys.executable)
    monkeypatch.delenv("ARENA_PGTAP_DBLINK_EXTRA", raising=False)
    return root


def add_test(root: Path, name: str, tap: str, *, exit_code: int = 0, sql: str = "select 1;\n") -> None:
    tests = root / "supabase" / "tests"
    (tests / name).write_text(sql)
    (tests / name).with_suffix(".tap").write_text(tap)
    if exit_code:
        (tests / name).with_suffix(".exit").write_text(str(exit_code))


def run(root: Path, *args: str) -> tuple[int, str]:
    result = proc.run("bash", [str(root / "supabase" / "tests" / "harness" / "run_pgtap.sh"), *args])
    return result.returncode, result.stdout + result.stderr


def psql_log(root: Path) -> str:
    log = root.parent / "psql.log"
    return log.read_text() if log.exists() else ""


def test_a_passing_suite_passes(suite: Path) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    add_test(suite, "002_b.sql", "1..1\nok 1 - only\n")
    code, out = run(suite, URI)
    assert (code, "PASS 001_a.sql (2/2)" in out, "PASS 002_b.sql (1/1)" in out) == (0, True, True)
    log = psql_log(suite)
    assert "drop database if exists arena_pgtap with (force)" in log
    assert "--single-transaction" in log
    assert "-v plan={" in log  # every test file receives cost_model.py --plan-json


def test_in_place_mode_skips_the_throwaway_database(suite: Path) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    code, out = run(suite, "--in-place", f"{URI}/postgres")
    assert (code, "PASS 001_a.sql (2/2)" in out) == (0, True)
    assert "create database" not in psql_log(suite)


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("tap", "exit_code", "why"),
    [
        ("1..2\nok 1 - first\nok 2 - second # SKIP later\n", 0, "skip/todo directive"),
        ("1..2\nok 1 - first\nnot ok 2 - second # TODO later\n", 0, "skip/todo directive"),
        ("1..2\nok 1 - first\nok 2 # skip\n", 0, "skip/todo directive"),
        ("1..2\nok 1 - first\nnot ok 2 - second\n", 0, "failed: not ok 2 - second"),
        ("1..2\nok 1 - first\n", 0, "test numbers [1] do not run 1..2"),
        ("1..2\nok 1 - first\nok 1 - first again\n", 0, "test numbers [1, 1] do not run 1..2"),
        (OK_TAP + "Bail out! the server went away\n", 0, "bail out: Bail out!"),
        ("ok 1 - first\nok 2 - second\n", 0, "0 plan lines"),
        ("1..2\nok 1 - first\nok 2 - second\n1..2\n", 0, "2 plan lines"),
        ("1..0\n", 0, "plan 1..0 runs no test"),
        (OK_TAP, 3, "psql exited 3"),
        (OK_TAP + "# Looks like you failed 1 test of 2\n", 0, "Looks like you failed 1 test of 2"),
        (OK_TAP + "psql:001_a.sql:9: ERROR:  boom\n", 0, "error: psql:001_a.sql:9: ERROR:  boom"),
    ],
)
def test_a_failing_skipped_or_unplanned_file_fails_the_run(suite: Path, tap: str, exit_code: int, why: str) -> None:
    add_test(suite, "000_good.sql", "1..1\nok 1 - fine\n")
    add_test(suite, "001_a.sql", tap, exit_code=exit_code)
    code, out = run(suite, URI)
    assert code == 1
    assert "FAIL 001_a.sql" in out
    assert why in out
    assert "PASS 000_good.sql (1/1)" in out  # one bad file does not hide the others' results


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "call",
    [
        "select skip('later', 1);",
        "select todo('later', 1);",
        "SELECT * FROM todo_start('x');",
        "perform Skip ('x');",
        "select extensions.skip('later', 1);",
        "select \"todo\"('later', 1);",
        "select skip/* later */('later', 1);",
    ],
)
def test_a_skip_or_todo_call_anywhere_in_the_suite_fails_before_any_test_runs(suite: Path, call: str) -> None:
    add_test(suite, "001_a.sql", OK_TAP, sql=f"begin;\nselect plan(1);\n-- a branch that never runs here\n{call}\n")
    code, out = run(suite, URI)
    assert (code, "pgTAP skip/todo calls are forbidden" in out) == (1, True)
    assert "-f" not in psql_log(suite)  # rejected statically: no file was run


@pytest.mark.gateproof
def test_a_skip_or_todo_call_in_a_harness_file_fails(suite: Path) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    harness = suite / "supabase" / "tests" / "harness" / "helpers.psql"
    harness.write_text("create function tests.x() returns text language sql as $$ select skip('x', 1) $$;\n")
    code, out = run(suite, URI)
    assert (code, "helpers.psql" in out) == (1, True)


def test_words_that_only_look_like_markers_pass(suite: Path) -> None:
    add_test(
        suite, "001_a.sql", OK_TAP, sql="select case when x then 'skip' else 'admit' end, tests.skip_count, todos;\n"
    )
    code, _out = run(suite, URI)
    assert code == 0


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "uri",
    [
        "postgresql://postgres@db.example.com:5433",
        "postgresql://postgres@10.0.0.5:5433",
        "postgresql://postgres@127.0.0.1:5432",
        "postgresql://postgres@127.0.0.1:05432",
        "postgresql://postgres@localhost:005432",
        "postgresql://postgres@127.0.0.1:0",
        "postgresql://postgres@127.0.0.1:65536",
        "postgresql://postgres@127.0.0.1:99999",
        "postgresql://postgres@127.0.0.1",
        "postgresql://postgres:secret@127.0.0.1:54329",
        "postgresql://postgres@127.0.0.1:54329?host=db.example.com",
        "host=127.0.0.1 port=54329 user=postgres",
    ],
)
def test_servers_off_loopback_or_on_5432_are_refused(suite: Path, uri: str) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    code, out = run(suite, uri)
    assert code == REFUSED
    assert psql_log(suite) == ""  # refused before any connection
    assert "secret" not in out  # a refused URI is never echoed: it may carry a password


@pytest.mark.gateproof
def test_a_suite_without_tests_fails(suite: Path) -> None:
    code, out = run(suite, URI)
    assert (code, "both must be non-empty" in out) == (1, True)


@pytest.mark.gateproof
def test_in_place_mode_refuses_a_database_that_is_not_fresh(suite: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    monkeypatch.setenv("FAKE_PSQL_FRESH", "f")
    code, out = run(suite, "--in-place", f"{URI}/postgres")
    assert (code, "already has the arena schema" in out) == (REFUSED, True)
    assert "--single-transaction" not in psql_log(suite)  # nothing applied


@pytest.mark.gateproof
@pytest.mark.parametrize("args", [[], [URI, URI], ["--in-place", URI], [f"{URI}/postgres"]])
def test_bad_arguments_are_refused(suite: Path, args: list[str]) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    code, _out = run(suite, *args)
    assert code == REFUSED


@pytest.mark.gateproof
def test_the_libpq_environment_cannot_redirect_the_connection(suite: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    for name in REDIRECTS:
        monkeypatch.setenv(name, "5432" if name == "PGPORT" else "10.9.9.9")
    code, _out = run(suite, URI)
    assert code == 0
    assert "env " not in psql_log(suite)  # psql never saw a variable that could override the URI


def split_pgoptions(value: str) -> list[str]:
    """PGOPTIONS as the server splits it (postinit.c pg_split_opts): any isspace() character separates words, a
    backslash takes the next character literally."""
    words, word, escaped, started = [], [], False, False
    for ch in value:
        if escaped:
            word.append(ch)
            escaped, started = False, True
        elif ch == "\\":
            escaped, started = True, True
        elif ch in " \t\n\v\f\r":
            if started:
                words.append("".join(word))
            word, started = [], False
        else:
            word.append(ch)
            started = True
    if started:
        words.append("".join(word))
    return words


def parse_conninfo(conninfo: str) -> dict[str, str]:
    """A libpq keyword=value string (single-quoted values, backslash escapes inside quotes); a later keyword wins."""
    out: dict[str, str] = {}
    i, n = 0, len(conninfo)
    while i < n:
        while i < n and conninfo[i] == " ":
            i += 1
        if i >= n:
            break
        eq = conninfo.index("=", i)
        key = conninfo[i:eq].strip()
        i = eq + 1
        value: list[str] = []
        if i < n and conninfo[i] == "'":
            i += 1
            while conninfo[i] != "'":
                if conninfo[i] == "\\":
                    i += 1
                value.append(conninfo[i])
                i += 1
            i += 1
        else:
            while i < n and conninfo[i] != " ":
                if conninfo[i] == "\\":
                    i += 1
                value.append(conninfo[i])
                i += 1
        out[key] = "".join(value)
    return out


def dblink_dsns(root: Path) -> list[dict[str, str]]:
    """The arena_test.dblink_dsn every test file received, parsed as the server and libpq parse it."""
    dsns = []
    for line in psql_log(root).splitlines():
        if line.startswith("pgoptions "):
            words = split_pgoptions(line.removeprefix("pgoptions ").encode().decode("unicode_escape"))
            settings = dict(w.split("=", 1) for w in words if w != "-c")
            dsns.append(parse_conninfo(settings["arena_test.dblink_dsn"]))
    return dsns


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "throwaway",
    [
        "pa ss'w\\d=x",  # disposable values: a space, a quote, a backslash and an equals sign
        "tab\there",
        "new\nline",
        "every\v\f\r space",  # every other character isspace() separates PGOPTIONS words on
    ],
)
def test_the_dblink_dsn_reaches_the_server_the_uri_names(
    suite: Path, monkeypatch: pytest.MonkeyPatch, throwaway: str
) -> None:
    """Without ARENA_PGTAP_DBLINK_EXTRA the second session goes to the URI's own host, port and user, with the
    password psql used, never to libpq's default socket or port 5432 (Codex WP-03 round 2); the password survives
    PGOPTIONS word splitting whatever whitespace it holds (round 4)."""
    add_test(suite, "001_a.sql", OK_TAP)
    add_test(suite, "002_b.sql", OK_TAP)
    monkeypatch.setenv("PGPASSWORD", throwaway)
    code, _out = run(suite, "postgresql://arena_admin@127.0.0.1:54329")
    assert code == 0
    expected = {
        "host": "127.0.0.1",
        "port": "54329",
        "dbname": "arena_pgtap",
        "user": "arena_admin",
        "password": throwaway,
    }
    assert dblink_dsns(suite) == [expected, expected]


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("uri", "pguser", "expected"),
    [
        (
            "postgresql://[::1]:54330/arena_db",
            None,
            {"host": "::1", "port": "54330", "dbname": "arena_db", "user": getpass.getuser()},
        ),
        (
            "postgres://localhost:54331/other",
            "bob",
            {"host": "localhost", "port": "54331", "dbname": "other", "user": "bob"},
        ),
    ],
)
def test_the_dblink_dsn_uses_the_user_psql_uses(
    suite: Path, monkeypatch: pytest.MonkeyPatch, uri: str, pguser: str | None, expected: dict[str, str]
) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    monkeypatch.delenv("PGPASSWORD", raising=False)
    if pguser is None:
        monkeypatch.delenv("PGUSER", raising=False)
    else:
        monkeypatch.setenv("PGUSER", pguser)
    code, _out = run(suite, "--in-place", uri)
    assert code == 0
    assert dblink_dsns(suite) == [expected]


def test_the_dblink_override_names_the_server_for_a_container(suite: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    add_test(suite, "001_a.sql", OK_TAP)
    throwaway = secrets.token_hex(8)  # generated per run: no credential-shaped literal in the source
    monkeypatch.setenv("ARENA_PGTAP_DBLINK_EXTRA", f"host=172.17.0.2 port=5432 user=postgres password={throwaway}")
    code, _out = run(suite, URI)
    assert code == 0
    assert dblink_dsns(suite) == [
        {"dbname": "arena_pgtap", "host": "172.17.0.2", "port": "5432", "user": "postgres", "password": throwaway}
    ]
