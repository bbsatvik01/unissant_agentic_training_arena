"""The tournament job against the REAL migrated S4 functions (S5 5.3; D2, D3, BKO-2; S4 EF-05..EF-11
through the job). `make db-test` runs it on the disposable Supabase Postgres container it has just migrated
(`ARENA_IT_ADMIN_DSN`); never the hosted project. `ARENA_MODEL_MODE=fake` throughout: every call runs the
real spend guard and the real work-item/trial state machine, with `FakeAdapter` standing in for Vertex.

Seeds F01 (one family, two variants) and registers the official A1 and S1 candidates: the smallest lineup
`roster.build_roster` accepts (one pairing x two variants = one 2-trial interactive block, two corpus
transcripts, two replay trials -- six planned trials covering every track once). The referee runs as a
real `python -m arena_referee` subprocess (`tools/tests/subprocess_support.popen_role_module`, the same
helper every role's own `tests/test_main.py` uses) on a scratch port, against the same database as
`arena_referee` -- never imported in process here, since this package may never import `arena_referee`
(`tools/check_roles.py`, S5 1.2 item 2; the AST linter scans this test directory too, has no exemption, and
also catches a module name spelled as a load-by-name string, e.g. an in-process `uvicorn --factory
arena_referee.app:create_app`) -- so the job's calls to `/internal/trials/{id}/score`,
`/internal/tournaments/{id}/blocks/{n}/score`, `corpus-seal` and `close` all run the real referee code, in
its own process, against the real functions.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import socket
import time
from collections.abc import Coroutine, Iterator
from pathlib import Path
from subprocess import Popen, TimeoutExpired  # the role-process helper does the one reviewed Popen call
from typing import Any
from uuid import UUID

import httpx
import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo

from arena_core.db import subject as db_subject
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import Connector, dsn_connector
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import DbSpendGuard
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import Orchestrator, SubjectCall, SubjectOutcome, TrialSignals
from arena_tournament import lifecycle
from arena_tournament.main import load_manifests
from arena_tournament.referee_client import RefereeClient
from arena_tournament.roster import FamilySpec, build_roster
from arena_tournament.runner import TournamentRunner, _run_interactive_trial
from tools import proc
from tools.tests.subprocess_support import popen_role_module

REPO = Path(__file__).resolve().parents[3]
TESTS_DIR = REPO / "supabase" / "tests"
DSN_VAR = "ARENA_IT_ADMIN_DSN"
CALLER_CREDENTIAL = "it-tournament-caller"  # fixture value only, never a real credential
CALLER_HASH = hashlib.sha256(CALLER_CREDENTIAL.encode()).hexdigest()
ADMIN_EMAIL = "admin@example.test"
# One block of 2 interactive trials + 2 replay_corpus + 2 replay (the smallest lineup roster.build_roster
# accepts: one assistant, one subject, one family -- every track covered once).
PLANNED_TRIALS = 6
REFEREE_READY_TIMEOUT_S = 20.0


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _admin_rows(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
    async with await AsyncConnection.connect(dsn) as conn:
        cur = await conn.execute(query, params)
        rows = list(await cur.fetchall()) if cur.description else []
        await conn.commit()
        return rows


async def _login(dsn: str, role: str) -> str:
    password = secrets.token_hex(24)
    stmt = sql.SQL("alter role {} login password {}").format(sql.Identifier(role), sql.Literal(password))
    async with await AsyncConnection.connect(dsn) as conn:
        await conn.execute(stmt)
        await conn.commit()
    return make_conninfo(dsn, user=role, password=password)


def _subject(connect: Connector) -> SubjectCall:
    """The real `arena-subject` calls (S5 5.2), the stand-in `it_api.py` also uses: this proves the job's
    subject call reaches the same functions, not a fake outcome."""

    async def answer(trial: UUID, work_item: UUID, _actor: UUID | None) -> SubjectOutcome:
        async with connect() as conn:
            ctx = await db_subject.turn_context(conn, trial, work_item)
        req = db_subject.RecordSubjectTurn(
            trial_id=trial,
            work_item_id=work_item,
            utterance=f"For question {ctx.turn_no}: I went in to check the dehumidifier.",
            tag={"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []},
            guard_result={"passed": True},
        )
        async with connect() as conn:
            recorded = await db_subject.record_subject_turn(conn, req)
        return SubjectOutcome(recorded.outcome, recorded.turn_no)

    return answer


def _free_port() -> int:
    """An OS-assigned loopback port, released immediately so uvicorn can bind it (the usual test-only
    free-port trick; the small re-bind race is acceptable here, never for anything user-facing)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _referee_env(world: dict[str, Any], scratch_port: int) -> dict[str, str]:
    """`os.environ`, minus anything `boot()` would read as this *suite's* own role or a stray model key
    (D-001): a developer's shell may export `ARENA_*`/`GEMINI_API_KEY`/`GOOGLE_API_KEY` for other work, and
    this needs the ordinary shell environment (PATH, HOME) to resolve the interpreter and its venv, unlike
    `tools/tests/subprocess_support.py`'s own role-boot tests, which want a minimal, fully explicit
    environment because refusing on an unexpected key is the behavior under test there. `ARENA_REFEREE_PORT`
    (`arena_referee.app.port`) is never set outside a test: a scratch port avoids colliding with a real
    arena-referee that may already be bound to 8082 (e.g. a developer's own `scripts/dev.sh up`)."""
    base = {k: v for k, v in os.environ.items() if not k.startswith(("ARENA_", "GEMINI_", "GOOGLE_"))}
    return {
        **base,
        "ARENA_ROLE": "referee",
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_REFEREE_DSN": world["referee"],
        "ARENA_ENV": "local",
        "ARENA_BIND_HOST": "127.0.0.1",
        "ARENA_MODEL_MODE": "fake",
        "ARENA_LOCAL_CALLERS": CALLER_HASH,
        "ARENA_USERS_FILE": str(world["users_path"]),
        "ARENA_DEV_USER": ADMIN_EMAIL,
        "ARENA_REFEREE_PORT": str(scratch_port),
    }


def _start_referee(world: dict[str, Any]) -> tuple[Popen[str], str]:
    """A real `python -m arena_referee` process (`popen_role_module`, the same helper
    `services/referee/tests/test_main.py` uses to prove that entry point really serves), on a scratch port:
    a real OS process, so this test's calls cross the referee's role boundary for real, the thing
    `httpx.ASGITransport` in process could never prove and importing `arena_referee.app` directly here is
    forbidden from proving (S5 1.2 item 2)."""
    scratch_port = _free_port()
    base_url = f"http://127.0.0.1:{scratch_port}"
    process = popen_role_module("arena_referee", _referee_env(world, scratch_port))
    deadline = time.monotonic() + REFEREE_READY_TIMEOUT_S
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            out = process.stdout.read() if process.stdout else ""
            msg = f"arena-referee subprocess exited early (code {process.returncode}):\n{out}"
            raise RuntimeError(msg)
        try:
            resp = httpx.get(f"{base_url}/api/health", timeout=1.0)
            if resp.status_code == httpx.codes.OK:
                return process, base_url
        except httpx.HTTPError as exc:  # silent-ok: kept for the ready-timeout message once the loop gives up
            last_error = exc
        time.sleep(0.2)
    process.terminate()
    out = process.stdout.read() if process.stdout else ""
    msg = f"arena-referee subprocess never became ready: {last_error}\n{out}"
    raise RuntimeError(msg)


def _stop_referee(process: Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=10.0)
    except TimeoutExpired:  # silent-ok: the standard escalate-to-SIGKILL fallback for a hung child
        process.kill()
        process.wait(timeout=10.0)
    if process.stdout:
        process.stdout.close()


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    admin = os.environ.get(DSN_VAR, "")
    if not admin:
        msg = f"{DSN_VAR} is not set: this suite runs inside make db-test on a freshly migrated database"
        raise RuntimeError(msg)
    loaded = proc.run(
        "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "harness/fixtures.psql", admin], cwd=TESTS_DIR
    )
    if loaded.returncode != 0:
        msg = f"could not load fixtures.psql: {loaded.stderr.strip()}"
        raise RuntimeError(msg)
    # D-012, D-013: migrations seed `global` at $0 (fail-closed); this suite is its own operator and applies
    # a plan generous enough for a 6-trial fake-model run (no real spend: ARENA_MODEL_MODE=fake throughout).
    run(_admin_rows(admin, "select ops.set_bucket_ceiling('global', null, 1000.00, 'it_tournament.py fixture')"))
    family_row = run(_admin_rows(admin, "select tests.seed_family('F01')"))
    family_id = family_row[0][0]
    for name in ("A1", "S1"):
        raw = (REPO / "prompts" / "manifests" / f"{name}.json").read_text(encoding="utf-8")
        run(
            _admin_rows(
                admin,
                "select arena.register_candidate(m->>'kind', m->>'candidate_id', m->>'version', m)"
                " from (select %s::jsonb m) x",
                (raw,),
            )
        )
    variant_rows = run(
        _admin_rows(admin, "select id from arena.case_variants where family_id = %s order by id", (family_id,))
    )
    candidate_rows = run(_admin_rows(admin, "select name, id from arena.candidates where name in ('A1', 'S1')"))
    candidate_id = dict(candidate_rows)
    users_path = tmp_path_factory.mktemp("it_tournament") / "users.toml"
    users_path.write_text(
        f'[[users]]\nemail = "{ADMIN_EMAIL}"\ndisplay_name = "Admin"\nroles = ["admin"]\n', encoding="utf-8"
    )
    built = {
        "admin": admin,
        "public": run(_login(admin, "arena_public")),
        "subject": run(_login(admin, "arena_subject")),
        "referee": run(_login(admin, "arena_referee")),
        "variant_ids": [row[0] for row in variant_rows],
        "candidate_id": candidate_id,
        "users_path": users_path,
    }
    process, base_url = _start_referee(built)
    built["referee_base_url"] = base_url
    try:
        yield built
    finally:
        _stop_referee(process)


async def _no_sleep(_s: float) -> None:
    return None


def build_runner(world: dict[str, Any], tournament_id: UUID) -> TournamentRunner:
    connect = dsn_connector(world["public"])
    db = ArenaDb(connect, actor=None)
    port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), DbSpendGuard(connect), PortOptions(sleep=_no_sleep))
    orchestrator = Orchestrator(
        db=db, port=port, subject=_subject(dsn_connector(world["subject"])), signals=TrialSignals()
    )
    referee = RefereeClient(CALLER_CREDENTIAL, base_url=world["referee_base_url"])
    manifests = run(load_manifests(db, tournament_id))  # the real WP-17 wiring (arena_tournament.main)
    return TournamentRunner(db=db, orchestrator=orchestrator, referee=referee, manifests=manifests)


def _one_family_roster(world: dict[str, Any], seed: int) -> list[Any]:
    v0, v1 = world["variant_ids"]
    spec = FamilySpec(family_code="F01", truthful_variant_id=v0, deceptive_variant_id=v1)
    assistants = (world["candidate_id"]["A1"],)
    subjects = (world["candidate_id"]["S1"],)
    return build_roster([spec], assistants, subjects, seed=seed)


async def _set_up_tournament(world: dict[str, Any], name: str, seed: int) -> UUID:
    connect = dsn_connector(world["referee"])
    tournament_id = await lifecycle.create_tournament(
        connect, lifecycle.TournamentSpec(name=name, split="dev", seed=seed)
    )
    await lifecycle.add_planned_trials(connect, tournament_id, _one_family_roster(world, seed))
    await lifecycle.freeze_tournament(connect, tournament_id)
    await lifecycle.open_tournament(connect, tournament_id, split="dev")
    return tournament_id


async def _terminal_record_count(admin_dsn: str, tournament_id: UUID) -> int:
    rows = await _admin_rows(
        admin_dsn,
        "select count(*) from ledger.terminal_records r join arena.trials t on t.id = r.trial_id"
        " where t.tournament_id = %s",
        (tournament_id,),
    )
    return int(rows[0][0])


async def _tournament_status(admin_dsn: str, tournament_id: UUID) -> str:
    rows = await _admin_rows(admin_dsn, "select status from arena.tournaments where id = %s", (tournament_id,))
    return str(rows[0][0])


def test_a_small_tournament_runs_every_track_through_the_real_functions_and_closes(world: dict[str, Any]) -> None:
    tournament_id = run(_set_up_tournament(world, "it-wp17-full-run", seed=1))
    runner = build_runner(world, tournament_id)
    summary = run(runner.run(tournament_id))
    assert summary.closed
    assert run(_tournament_status(world["admin"], tournament_id)) == "sealed"
    assert run(_terminal_record_count(world["admin"], tournament_id)) == PLANNED_TRIALS
    assert summary.outcomes.get("completed", 0) == PLANNED_TRIALS


def test_a_restarted_job_after_a_simulated_mid_block_crash_adds_no_duplicate_execution_record(
    world: dict[str, Any],
) -> None:
    """S5 5.3, S4 EF-05..EF-11: a planned trial already finished before the job died is never re-executed,
    and the job started over still reaches `close` with exactly one terminal record per planned trial."""
    replay_prereq_trials = PLANNED_TRIALS - 2  # 2 corpus + 2 replay, out of 2 interactive left
    already_done = replay_prereq_trials + 1
    tournament_id = run(_set_up_tournament(world, "it-wp17-mid-block-restart", seed=2))
    first_runner = build_runner(world, tournament_id)

    # The corpus and replay tracks must finish (and the corpus must be sealed) before any interactive trial
    # may even start (BKO-2); a prior process that crashed mid-*interactive*-block already got this far.
    run(first_runner.run_replay_track_prerequisite(tournament_id))
    assert run(_terminal_record_count(world["admin"], tournament_id)) == replay_prereq_trials

    planned = run(first_runner.db.planned_trials(tournament_id))
    attempts = run(first_runner.db.planned_trial_attempts(tournament_id))
    first_interactive = next(r for r in planned if r["track"] == "interactive")
    trial_id = attempts[first_interactive["planned_trial_id"]][0]["trial_id"]

    # Simulate that same prior process finishing exactly one interactive trial before it died: run it
    # directly, bypassing the runner entirely (no admission check, no block score call -- exactly what a
    # crash mid-job would have left behind).
    run(first_runner.db.start_trial(trial_id))
    packet = run(first_runner.db.public_packet(first_interactive["variant_id"]))
    assert packet is not None
    run(_run_interactive_trial(trial_id, first_runner.orchestrator, packet["opening_question"]))
    assert run(_terminal_record_count(world["admin"], tournament_id)) == already_done

    # The job "restarts": a brand-new process, a brand-new runner, no in-memory state from the above.
    second_runner = build_runner(world, tournament_id)
    summary = run(second_runner.run(tournament_id))

    assert summary.closed
    assert run(_tournament_status(world["admin"], tournament_id)) == "sealed"
    assert run(_terminal_record_count(world["admin"], tournament_id)) == PLANNED_TRIALS

    # Re-running the whole job again on an already-closed tournament is a safe no-op: no new terminal record,
    # no crash on the idempotent seal/close calls.
    third_runner = build_runner(world, tournament_id)
    run(third_runner.run(tournament_id))
    assert run(_terminal_record_count(world["admin"], tournament_id)) == PLANNED_TRIALS
