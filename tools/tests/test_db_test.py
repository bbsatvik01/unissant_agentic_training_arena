"""Gateproofs for supabase/tests/harness/db_test.sh (`make db-test`; S4 WI-S4-02): every step runs, any failing
step makes the script exit non-zero, the plain path runs on the plain PostgreSQL + pgTAP image and the Supabase path
on the pinned Supabase image, no server binds port 5432, and every container started is removed.

The real script (and the real run_pgtap.sh it calls) runs against stub `docker`, `psql` and `uv` binaries on PATH,
so these proofs need neither Docker nor a database. Each stub logs its arguments; FAKE_FAIL names the steps to fail.
`make db-test` runs the same script against real servers.
"""

import re
import shlex
import shutil
import stat
import sys
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT

HARNESS = REPO_ROOT / "supabase" / "tests" / "harness"
SUPABASE_IMAGE = re.search(r'^SUPABASE_IMAGE="([^"]+)"$', (HARNESS / "db_test.sh").read_text(), re.MULTILINE)

STEPS = 6  # plain path, Supabase path, cost parity, capability fixture, subject suite, spend-guard suite
SERVERS = 2  # the plain and the Supabase container
STEPS_ON_SUPABASE = 5  # the Supabase path and the four steps that read its database

# FAKE_FAIL entries: daemon, build, run-plain, run-supabase, pgtap-plain, pgtap-supabase, uv (the cost-parity run),
# it-subject (the subject suite's pytest run), it-spend (the spend-guard suite's pytest run), fixture.
STUB = """
import os, pathlib, sys
tool = sys.argv[1]
args = sys.argv[2:]
fail = set(filter(None, os.environ.get("FAKE_FAIL", "").split(",")))
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(tool + " " + " ".join(args) + "\\n")
if tool == "docker":
    cmd = args[0]
    if cmd == "version":
        sys.exit(1 if "daemon" in fail else 0)
    if cmd == "image":
        sys.exit(0 if os.environ.get("FAKE_HAVE_IMAGE") == "1" else 1)
    if cmd == "build":
        sys.stdin.read()
        sys.exit(1 if "build" in fail else 0)
    if cmd == "run":
        image = args[-1]
        kind = "plain" if image.startswith("arena-postgres-pgtap:") else "supabase"
        sys.exit(1 if "run-" + kind in fail else 0)
    if cmd == "inspect":
        fmt = args[args.index("-f") + 1]
        print("healthy" if "Health" in fmt else "true" if "Running" in fmt else "172.17.0.9")
    if cmd == "port":
        print("127.0.0.1:" + os.environ.get("FAKE_PORT", "55001"))
    sys.exit(0)
if tool == "uv":
    parity = "tools.check_cost_parity" in args
    subject_it = any("it_answer.py" in a for a in args)
    spend_it = any("it_spend_guard.py" in a for a in args)
    sys.exit(
        1
        if ("uv" in fail and parity) or ("it-subject" in fail and subject_it) or ("it-spend" in fail and spend_it)
        else 0
    )
# psql
db = args[args.index("-d") + 1] if "-d" in args else ""
if "-f" in args:
    target = pathlib.Path(args[args.index("-f") + 1])
    if target.name == "capability_matrix.psql":
        text = pathlib.Path(os.environ["FAKE_FIXTURE"]).read_text()
        sys.stdout.write(text + ("extra,row,x,SELECT,allow\\n" if "fixture" in fail else ""))
        sys.exit(0)
    if target.parent.name == "tests":
        path = "pgtap-plain" if db.endswith("/arena_pgtap") else "pgtap-supabase"
        sys.stdout.write("1..1\\n" + ("not ok 1 - fake\\n" if path in fail else "ok 1 - fake\\n"))
        sys.exit(0)
if any("to_regnamespace('arena')" in a for a in args):
    print("t")
"""


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A minimal repository: the real db_test.sh, run_pgtap.sh and harness files, one migration, one test file, the
    real fixture and cost model, and stub docker, psql and uv on PATH."""
    root = tmp_path / "repo"
    harness = root / "supabase" / "tests" / "harness"
    harness.mkdir(parents=True)
    for name in ("db_test.sh", "run_pgtap.sh", "supabase_shim.psql", "postgres-pgtap.Dockerfile"):
        shutil.copy2(HARNESS / name, harness / name)
    (root / "supabase" / "tests" / "fixtures").mkdir()
    fixture = root / "supabase" / "tests" / "fixtures" / "capability_matrix.csv"
    shutil.copy2(REPO_ROOT / "supabase" / "tests" / "fixtures" / "capability_matrix.csv", fixture)
    (root / "supabase" / "tests" / "001_a.sql").write_text("select 1;\n")
    (root / "supabase" / "migrations").mkdir()
    (root / "supabase" / "migrations" / "20261008000100_x.sql").write_text("select 1;\n")
    (root / "tools").mkdir()
    for name in ("pgtap_verdict.py", "pgtap_ban.py"):
        shutil.copy2(REPO_ROOT / "tools" / name, root / "tools" / name)
    model = root / "docs" / "research" / "synthesis"
    model.mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "docs" / "research" / "synthesis" / "cost_model.py", model / "cost_model.py")

    bindir = tmp_path / "bin"
    bindir.mkdir()
    script = bindir / "stub.py"
    script.write_text(STUB)
    for tool in ("docker", "psql", "uv"):
        wrapper = bindir / tool
        wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} {tool} "$@"\n')
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "calls.log"))
    monkeypatch.setenv("FAKE_FIXTURE", str(fixture))
    monkeypatch.setenv("PYTHON", sys.executable)
    monkeypatch.delenv("FAKE_FAIL", raising=False)
    monkeypatch.delenv("ARENA_PGTAP_DBLINK_EXTRA", raising=False)
    return root


def run(root: Path) -> tuple[int, str]:
    result = proc.run("bash", [str(root / "supabase" / "tests" / "harness" / "db_test.sh")])
    return result.returncode, result.stdout + result.stderr


def calls(root: Path) -> list[str]:
    log = root.parent / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def started(root: Path) -> dict[str, str]:
    """name -> image of every `docker run`."""
    out = {}
    for line in calls(root):
        if line.startswith("docker run "):
            args = line.split()
            out[args[args.index("--name") + 1]] = args[-1]
    return out


def test_all_steps_pass(repo: Path) -> None:
    code, out = run(repo)
    assert (code, bool(re.search(r"^db-test: OK$", out, re.MULTILINE))) == (0, True), out
    assert out.count("-- OK: ") == STEPS
    log = calls(repo)
    images = sorted(started(repo).values())
    assert SUPABASE_IMAGE is not None
    assert images[1] == SUPABASE_IMAGE.group(1)
    assert re.fullmatch(r"arena-postgres-pgtap:[0-9a-f]{16}", images[0])
    assert any(line.startswith("docker build -q -t arena-postgres-pgtap:") for line in log)
    # plain path: throwaway database with the shim; Supabase path: in place, no shim
    assert any("drop database if exists arena_pgtap" in line for line in log)
    assert sum("supabase_shim.psql" in line for line in log) == 1
    # cost parity reads the migrated Supabase database (never the --dsn-less model-only mode)
    assert any(
        re.fullmatch(r"uv run --locked python -m tools.check_cost_parity --dsn postgresql://\S+/postgres", line)
        for line in log
    )
    # both integration suites run on that same database, after the steps that read its seeds as migrated, the
    # subject suite before the spend-guard suite (which applies ceilings and the kill switch last)
    subject_suite = [i for i, line in enumerate(log) if line.endswith("services/subject/tests/it_answer.py")]
    spend_suite = [i for i, line in enumerate(log) if line.endswith("packages/core/tests/db/it_spend_guard.py")]
    parity = [i for i, line in enumerate(log) if "tools.check_cost_parity" in line]
    assert len(subject_suite) == 1, log
    assert len(spend_suite) == 1, log
    assert parity[0] < subject_suite[0] < spend_suite[0]
    assert "-W error" in log[subject_suite[0]]
    assert "-W error" in log[spend_suite[0]]


def test_every_server_binds_loopback_and_a_docker_picked_port_and_is_removed(repo: Path) -> None:
    run(repo)
    runs = [line for line in calls(repo) if line.startswith("docker run ")]
    assert len(runs) == SERVERS
    for line in runs:
        assert " -p 127.0.0.1::5432 " in line
        assert " --rm " in line
    removed = {line.split()[-1] for line in calls(repo) if line.startswith("docker rm -f -v ")}
    assert set(started(repo)) <= removed


def test_an_existing_plain_image_is_reused(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_HAVE_IMAGE", "1")
    code, _out = run(repo)
    assert code == 0
    assert not any(line.startswith("docker build") for line in calls(repo))


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("failing", "label"),
    [
        ("build", "plain path"),
        ("run-plain", "plain path"),
        ("pgtap-plain", "plain path"),
        ("run-supabase", "Supabase path"),
        ("pgtap-supabase", "Supabase path"),
        ("uv", "cost parity"),
        ("fixture", "capability fixture"),
        ("it-subject", "subject integration suite"),
        ("it-spend", "spend-guard integration suite"),
    ],
)
def test_a_failing_step_fails_db_test_and_the_other_steps_still_run(
    repo: Path, monkeypatch: pytest.MonkeyPatch, failing: str, label: str
) -> None:
    monkeypatch.setenv("FAKE_FAIL", failing)
    code, out = run(repo)
    assert code == 1, out
    assert re.search(r"^db-test: FAIL$", out, re.MULTILINE), out
    assert re.search(rf"^-- FAIL: .*{re.escape(label)}", out, re.MULTILINE), out
    assert out.count("-- OK: ") + out.count("-- FAIL: ") == STEPS  # every step reported
    removed = {line.split()[-1] for line in calls(repo) if line.startswith("docker rm -f -v ")}
    assert set(started(repo)) <= removed


@pytest.mark.gateproof
def test_without_the_supabase_server_parity_and_fixture_fail_too(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_FAIL", "run-supabase")
    _code, out = run(repo)
    assert out.count("-- FAIL: ") == STEPS_ON_SUPABASE
    assert "-- OK: migrations and pgTAP on plain PostgreSQL 17" in out


@pytest.mark.gateproof
@pytest.mark.parametrize("port", ["5432", "05432", "70000", ""])
def test_an_unusable_or_reserved_host_port_fails(repo: Path, monkeypatch: pytest.MonkeyPatch, port: str) -> None:
    monkeypatch.setenv("FAKE_PORT", port)
    code, out = run(repo)
    assert code == 1
    assert "no usable host port" in out


@pytest.mark.gateproof
def test_a_stopped_docker_daemon_fails(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_FAIL", "daemon")
    code, out = run(repo)
    assert (code, "the Docker daemon is not running" in out, started(repo)) == (1, True, {})


@pytest.mark.gateproof
def test_missing_docker_fails(repo: Path, tmp_path: Path) -> None:
    (tmp_path / "bin" / "docker").unlink()
    code, out = run(repo)
    assert (code, "docker is not installed" in out) == (1, True)


# Each mutant removes one piece of the failure plumbing; the failing-step proof above must catch it. Run here so a
# refactor that breaks the plumbing in the same way is caught by the same scenario.
MUTANTS = [
    ('else echo "-- FAIL: $label"; fail=1; fi', 'else echo "-- FAIL: $label"; fi'),
    ('  echo "db-test: FAIL"\n  exit 1', '  echo "db-test: FAIL"\n  exit 0'),
    (
        '  "$HERE/run_pgtap.sh" --in-place "$ADMIN/postgres"\n',
        '  "$HERE/run_pgtap.sh" --in-place "$ADMIN/postgres" || true\n',
    ),
    ('  supabase_up || return 1\n  (cd "$ROOT"', '  (cd "$ROOT"'),
    ("  supabase_up || return 1\n  local dsn", "  local dsn"),
]


def _replace_nth(text: str, old: str, new: str, index: int) -> str:
    """Replace only the `index`-th (0-based) occurrence of `old`, leaving every other one untouched."""
    parts = text.split(old)
    assert len(parts) > index + 1, (index, text.count(old))
    return old.join(parts[: index + 1]) + new + old.join(parts[index + 1 :])


@pytest.mark.gateproof
@pytest.mark.parametrize(("before", "after"), MUTANTS)
def test_the_failing_step_proof_catches_each_mutant(
    repo: Path, monkeypatch: pytest.MonkeyPatch, before: str, after: str
) -> None:
    """Some patterns (the `supabase_up` guard) now recur across more than one integration-suite step, each
    added the same safe way (D-016: lift the proven pattern); every occurrence is mutated and proven essential
    on its own, one at a time, so a step that drops its own guard is caught whichever step it is."""
    script = repo / "supabase" / "tests" / "harness" / "db_test.sh"
    original = script.read_text()
    occurrences = original.count(before)
    assert occurrences >= 1, before
    for index in range(occurrences):
        script.write_text(_replace_nth(original, before, after, index))
        monkeypatch.setenv("FAKE_FAIL", "pgtap-supabase,run-supabase" if "supabase_up" in before else "pgtap-supabase")
        code, out = run(repo)
        if "supabase_up" in before:
            # without the guard, that one step runs against no Supabase server and passes: one FAIL fewer than
            # test_without_the_supabase_server_parity_and_fixture_fail_too requires
            assert out.count("-- FAIL: ") < STEPS_ON_SUPABASE, (index, out)
        else:
            assert code == 0, (index, out)  # the failing step no longer fails db-test: the proof above catches it
