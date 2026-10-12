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
import copy
import hashlib
import json
import os
import secrets
import socket
import time
from collections.abc import Coroutine, Iterator
from decimal import Decimal
from pathlib import Path
from subprocess import Popen, TimeoutExpired  # the role-process helper does the one reviewed Popen call
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo

from arena_api.app import create_app, guard_config
from arena_api.state import ApiState
from arena_core.db import subject as db_subject
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import DevIdentity
from arena_core.ids import sha256_hex
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.scenario.load import (
    Attestation,
    CodexResults,
    IngestArtifact,
    IngestBundle,
    IngestVariant,
    family_source_text,
)
from arena_core.scoring.inclusion import Exec, block_invalid
from arena_core.scoring.ranking import DEV_IG_ITEMS, IG_CHECK_NAMES, IG_ITEMS
from arena_core.spend.guard import DbSpendGuard
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import Orchestrator, SubjectCall, SubjectOutcome, TrialSignals
from arena_tournament import lifecycle
from arena_tournament.main import load_manifests
from arena_tournament.referee_client import RefereeClient
from arena_tournament.roster import FamilySpec, build_roster
from arena_tournament.runner import IsolationGateNotPassedError, TournamentRunner, _run_interactive_trial
from scripts import export_run, isolation_reports, seal_hidden_split
from scripts.referee_admin_client import admin_post
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
INVESTIGATOR = UUID("00000000-0000-0000-0000-00000000000a")  # tests.users() user A
API_BASE = "http://127.0.0.1:8080"
REFEREE_GIT_SHA = "f" * 40  # the referee's and the job's commit (the isolation gate binds to it, S3 9)


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
        "ARENA_GIT_SHA": REFEREE_GIT_SHA,  # fixture value only: create_app refuses to boot without one (S3 9)
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
    return TournamentRunner(
        db=db, orchestrator=orchestrator, referee=referee, manifests=manifests, code_sha=REFEREE_GIT_SHA
    )


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


# ============================================================================ WP-27 dry run (S1 10.3, S8 WP-27)
# The operator sealing sequence, proved end to end on this same migrated database with 2 throwaway synthetic
# hidden families (derived from the committed F01 and F02 dev families with fresh, random identifiers; never
# written to cases/hidden/, never committed): ingest with attestation into the sealed archive,
# seal_hidden_split, verify the archive, register frozen candidates, the real isolation gate (the hidden-text
# scan and the canary audit among its six items, S1 10.4/L9, S3 9) gating open, a fake-model run through
# close, begin_scoring, reveal, and a resolvable recording for one of its trials -- the exact gap
# arena.v_hidden_cases (d0db9da, its own follow-up 18f3eef) closes. docs/runbooks/hidden-seal.md documents
# the same sequence for a REAL hidden-authoring run; scripts/seal_hidden_split.py is the ingest+seal+verify
# half of it, built so this test can call its own functions directly rather than duplicating them.
#
# These 2 families skip the Python authoring loader's own V1-V5 diversity/corpus validators
# (`arena_core.scenario.load.ingest_bundle`), the same way the pgTAP harness's own hidden-tournament fixture
# (`tests.bundle_of`, this file's sibling `012_reveal_manifest.sql`'s `rvh` section) already does: S4's
# ingest function trusts the attestation by design (S1 10.5) -- it re-verifies archive and hash consistency,
# never V1-V5 itself, which run client-side before ingest and are proved on their own fixtures elsewhere
# (`packages/core/tests/scenario/test_v5.py`). What this dry run proves is the OPERATIONAL sequence end to
# end, never authoring quality: a REAL hidden family still goes through the full authoring loop (S1 8.5),
# and `scripts/seal_hidden_split.py`'s real `--bundle` files are built by `python -m arena_core.scenario
# bundle`, which runs every validator.
HIDDEN_DRY_RUN_SOURCES = ("cases/dev/F01.json", "cases/dev/F02.json")
SHA256_HEX_LEN = 64


def _synthetic_hidden_family(dev_path: Path) -> dict[str, Any]:
    """A throwaway hidden-split family derived from a committed dev family: a fresh, random H-prefixed
    family id (L3; `H[0-9a-f]{10}`), a fresh case id and fresh canaries per variant, and a fresh persona
    name (S1 10.4's own identifiers: family id, case ids, canaries and persona name, the ones the referee's
    hidden-text scan, IG-4, checks as exact substrings/token sequences rather than by 8-gram subtraction).
    Everything else -- the narrative, facts, ledger, gates -- is untouched, so this is explicitly NOT a
    diverse, disjoint hidden family (L4); see the module-level note above for what that does and does not
    mean for this dry run.

    The persona name is replaced by a whole-string substitution over the family's own JSON text (every
    occurrence, including inside narrative sentences and questions, not just the structured `persona.name`
    field), because IG-4 matches it as a token sequence anywhere in a scanned file: left as the real dev
    family's name, every variant's own narrative text would (correctly) hit the scan against the real
    cases/dev/{F01,F02}.json file on disk -- a real identifier collision, not a scan bug."""
    family: dict[str, Any] = copy.deepcopy(json.loads(dev_path.read_text(encoding="utf-8")))
    old_name = str(family["variants"]["truthful"]["private_packet"]["persona"]["name"])
    new_name = f"Synthetic Persona {secrets.token_hex(4)}"
    family = json.loads(json.dumps(family).replace(old_name, new_name))
    family["family_id"] = "H" + secrets.token_hex(5)
    family["split"] = "hidden"
    for role in ("truthful", "deceptive"):
        v = family["variants"][role]
        case_id = "C-" + secrets.token_hex(4).upper()
        v["case_id"] = case_id
        v["public_packet"]["case_id"] = case_id
        v["private_packet"]["case_id"] = case_id
        v["private_packet"]["canary"] = "CANARY-" + secrets.token_hex(8)
        v["evaluator_packet"]["case_id"] = case_id
        v["evaluator_packet"]["canary"] = "CANARY-" + secrets.token_hex(8)
    return family


def _passing_attestation(family: dict[str, Any]) -> Attestation:
    """S1 10.5's attestation shape with every check and Codex result recorded as passed, trusted the same
    way `tests.attestation` is trusted by the pgTAP harness's own hidden-tournament fixtures (module note
    above): this proves the sequence after a family is accepted, never the authoring loop itself."""
    return Attestation(
        family_id=str(family["family_id"]),
        revision=int(family["revision"]),
        family_sha256=sha256_hex(family_source_text(family).encode("utf-8")),
        validator_version="wp27-dry-run",
        checks_passed=("V1", "V1b", "V1c", "V1d", "V2", "V3a", "V4a", "V4b", "V4c", "V5"),
        codex=CodexResults(rounds=1, review="pass", cx2_truthful="pass", cx2_deceptive="pass", cx3="pass"),
    )


def _hidden_bundle(family: dict[str, Any]) -> IngestBundle:
    """The S4 ingest bundle (`sealed.ingest_case_family`'s own shape) of one synthetic hidden family, the
    same per-variant mapping `arena_core.scenario.load.ingest_bundle` does, without its validator gate
    (module note above)."""
    variants = []
    for role in ("truthful", "deceptive"):
        v = family["variants"][role]
        evaluator = v["evaluator_packet"]
        artifacts = tuple(
            IngestArtifact(
                record_id=str(a["artifact_id"]),
                kind=(
                    "clarification"
                    if a["kind"] == "clarification"
                    else "context_change"
                    if a["kind"] == "context_change"
                    else "record"
                ),
                doc_kind=str(a["kind"]),
                title=str(a["title"]),
                content=dict(a["content"]),
                requestable=a["release"]["type"] == "on_request",
                scheduled_turn=int(a["release"]["after_exchanges"]) if a["release"]["type"] == "scheduled" else None,
                request_after_turn=(
                    int(a["release"]["after_exchanges"]) if a["release"]["type"] == "on_request" else None
                ),
            )
            for a in sorted(evaluator["evidence_artifacts"], key=lambda a: str(a["artifact_id"]))
            if str(a["artifact_id"]).startswith("rec-")
        )
        variants.append(
            IngestVariant(
                variant_code=str(v["case_id"]),
                role=role,
                style=dict(family["style"]),
                difficulty=int(family["difficulty"]["level"]),
                public_packet=dict(v["public_packet"]),
                private_packet=dict(v["private_packet"]),
                evaluator_packet=dict(evaluator),
                artifacts=artifacts,
            )
        )
    return IngestBundle(
        family_code=str(family["family_id"]),
        domain=str(family["domain"]),
        split="hidden",
        supersedes=None,
        source=family_source_text(family),
        attestation=_passing_attestation(family),
        variants=tuple(sorted(variants, key=lambda v: v.variant_code)),
    )


def _sampler_record(families: list[dict[str, Any]]) -> dict[str, Any]:
    """S1 10.5's sampler record, matching `sealed.sampler_matches`'s own rule exactly: one assignment entry
    per ingested hidden family, naming its taxonomy, difficulty level and style verbatim."""
    return {
        "seed": 20261012,
        "n": len(families),
        "max_phi": 0.1,
        "assignment": [
            {
                "family_id": f["family_id"],
                "violation_type": f["taxonomy"]["violation_type"],
                "misleading_types": f["taxonomy"]["misleading_types"],
                "level": f["difficulty"]["level"],
                "style": f["style"],
            }
            for f in families
        ],
    }


def _report_evidence(result: tuple[bool, str]) -> dict[str, Any]:
    return {"passed": result[0], "report_text": result[1]}


async def _variant_role_ids(admin_dsn: str, family_code: str) -> dict[str, UUID]:
    rows = await _admin_rows(
        admin_dsn,
        "select ep.role, v.id from arena.case_variants v join arena.case_families f on f.id = v.family_id"
        " join sealed.evaluator_packets ep on ep.variant_id = v.id where f.family_code = %s",
        (family_code,),
    )
    return {str(role): UUID(str(vid)) for role, vid in rows}


def _seal_two_synthetic_hidden_families(world: dict[str, Any]) -> list[dict[str, Any]]:
    """Steps 1-3 (S1 10.3), through scripts/seal_hidden_split.py's own `seal()` (not duplicated here): ingest
    each synthetic family with its attestation into the sealed archive, seal_hidden_split, verify the
    archive. "generate them from existing dev families with new IDs, never commit them": nothing here
    writes to cases/hidden/ or to git -- the families live only as in-memory dicts and database rows. A
    real run commits the seal hash, family count and authoring report to the repository here (step 4), then
    deletes cases/hidden/ and the authoring session's transcripts once this archive check passes -- a
    filesystem/git action the operator takes after reading this script's report, deliberately not
    automated by it (never exercised here: there is no cases/hidden/ to delete for a dry run that never
    created one).

    IG-4's hidden-text scan subtracts every 8-gram that also occurs in a dev family INGESTED before the
    seal (S1 10.4's reference, `fetch_hidden_corpora`); the world fixture ingests only F01 as dev, so a
    synthetic hidden family derived from F02 would flood the scan with false hits against the real
    cases/dev/F02.json file on disk (identical content, no subtraction) -- not a leak, an artifact of this
    database never having ingested F02 as dev. Ingesting F02 as dev too, before sealing, makes the
    subtraction apply and the scan's zero-hits result below mean something."""
    run(_admin_rows(world["admin"], "select tests.seed_family('F02')"))
    referee_connect = dsn_connector(world["referee"])
    families = [_synthetic_hidden_family(REPO / path) for path in HIDDEN_DRY_RUN_SOURCES]
    bundles = [_hidden_bundle(f).as_json() for f in families]

    report = run(seal_hidden_split.seal(referee_connect, bundles, _sampler_record(families)))
    assert len(report.seal_sha256) == SHA256_HEX_LEN
    assert report.already_sealed is False
    assert report.verified is True

    archive_rows = run(
        _admin_rows(
            world["admin"],
            "select count(*) from sealed.family_ingests fi join arena.case_families f on f.id = fi.family_id"
            " where f.split = 'hidden'",
        )
    )
    assert int(archive_rows[0][0]) == len(families)  # the archive holds every ingested family's file+attestation
    return families


def _freeze_hidden_tournament(world: dict[str, Any], families: list[dict[str, Any]], seed: int) -> UUID:
    """Register frozen candidates (the world fixture's own A1/S1: candidates are not split-scoped, so
    freezing a hidden roster reuses the exact rows a dev one does), add_planned_trials, freeze_tournament;
    then "ledger event order shows seal before freeze" (WP-27's own acceptance line)."""
    referee_connect = dsn_connector(world["referee"])
    first_variants = run(_variant_role_ids(world["admin"], families[0]["family_id"]))
    spec = FamilySpec(
        family_code=families[0]["family_id"],
        truthful_variant_id=first_variants["truthful"],
        deceptive_variant_id=first_variants["deceptive"],
    )
    roster_rows = build_roster([spec], (world["candidate_id"]["A1"],), (world["candidate_id"]["S1"],), seed=seed)
    tournament_id = run(
        lifecycle.create_tournament(
            referee_connect, lifecycle.TournamentSpec(name=f"it-wp27-hidden-{seed}", split="hidden", seed=seed)
        )
    )
    run(lifecycle.add_planned_trials(referee_connect, tournament_id, roster_rows))
    roster_sha256 = run(lifecycle.freeze_tournament(referee_connect, tournament_id))
    assert roster_sha256

    order_rows = run(
        _admin_rows(
            world["admin"],
            "select event_type from ledger.events"
            " where event_type in ('hidden_split_sealed', 'roster_frozen') and (tournament_id is null"
            " or tournament_id = %s) order by seq",
            (tournament_id,),
        )
    )
    kinds = [row[0] for row in order_rows]
    assert kinds.index("hidden_split_sealed") < kinds.index("roster_frozen")
    return tournament_id


def _open_hidden_tournament_through_the_real_gate(world: dict[str, Any], tournament_id: UUID) -> dict[str, Any]:
    """Canary placement + the hidden-text scan (S1 10.4/L9) + IG-1..3, all genuinely run, never fabricated:
    IG-1 is the real pgTAP suite (Docker), IG-2/IG-3 the real route and type tests this checkout's own make
    check/make db-test also run; IG-4 (hidden-text scan), IG-5 (chain/commitment/corpus-seal verification)
    and IG-6 (canary audit) are computed live, server-side, by the open route itself
    (routes.reveal.open_route -> arena_referee.isolation.open_hidden_tournament)."""
    ig1, ig2, ig3 = isolation_reports.run_ig1(), isolation_reports.run_ig2(), isolation_reports.run_ig3()
    assert ig1[0], ig1[1]
    assert ig2[0], ig2[1]
    assert ig3[0], ig3[1]
    open_body = {"ig1": _report_evidence(ig1), "ig2": _report_evidence(ig2), "ig3": _report_evidence(ig3)}
    open_result = run(
        admin_post(f"/api/admin/tournaments/{tournament_id}/open", open_body, base_url=world["referee_base_url"])
    )
    assert open_result["opened"] is True
    assert open_result["gated"] is True
    assert open_result["passed"] is True
    assert run(_tournament_status(world["admin"], tournament_id)) == "running"
    return open_result


async def _hidden_trials(admin_dsn: str, tournament_id: UUID) -> list[UUID]:
    rows = await _admin_rows(
        admin_dsn, "select id from arena.trials where tournament_id = %s order by id", (tournament_id,)
    )
    return [UUID(str(r[0])) for r in rows]


async def _public_view_rows(public_dsn: str, trial: UUID) -> list[int]:
    """What `arena_public` with no actor (the job's own credential, `dev_tournament_demo`'s, an export run as
    one) sees of a trial through every reveal-gated projection a recording or export reads."""
    query = (
        "select (select count(*) from arena.v_transcripts where trial_id = %(t)s),"
        " (select count(*) from arena.v_released_evidence where trial_id = %(t)s),"
        " (select count(*) from arena.v_trial_events where trial_id = %(t)s),"
        " (select count(*) from arena.v_findings where trial_id = %(t)s),"
        " (select count(*) from ledger.v_commitments where trial_id = %(t)s and payload is not null),"
        " (select count(*) from arena.v_hidden_cases h join arena.v_trials v on v.variant_id = h.variant_id"
        "   where v.id = %(t)s)"
    )
    async with await AsyncConnection.connect(public_dsn) as conn:
        cur = await conn.execute(query, {"t": trial})
        row = await cur.fetchone()
    assert row is not None
    return [int(v) for v in row]


async def _no_debrief(_session: UUID) -> dict[str, Any]:
    return {}


async def _api_recording_status(world: dict[str, Any], trial: UUID) -> int:
    """`GET /api/trials/{id}/recording` through the real arena-api app (`create_app`) on the `arena_public`
    login, as an allowlisted investigator: 404 for a hidden trial before reveal (no existence oracle), 200
    after."""
    port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), RunBudget(Decimal(1)), PortOptions(sleep=_no_sleep))
    who = DevIdentity(user_id=INVESTIGATOR, email="a@example.test", display_name="A", roles=frozenset({"investigator"}))
    state = ApiState(
        connect=dsn_connector(world["public"]),
        identity=who,
        port=port,
        subject=_subject(dsn_connector(world["subject"])),
        debrief=_no_debrief,
    )
    app = create_app(state, guard_config({}))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API_BASE) as client:
        resp = await client.get(f"/api/trials/{trial}/recording")
    return resp.status_code


async def _record_gate_run(admin_dsn: str, failed: dict[str, bool], items: tuple[str, ...] = IG_ITEMS) -> None:
    """One isolation gate run's rows in one transaction under one `run_id`, the shape
    `arena_referee.db.record_isolation_checks` writes, every item passing unless `failed` says otherwise."""
    run_id = str(uuid4())
    async with await AsyncConnection.connect(admin_dsn) as conn:
        for item in items:
            await conn.execute(
                "insert into arena.isolation_checks (candidate_id, check_name, passed, evidence) values"
                " (null, %s, %s, jsonb_build_object('hash', 'it', 'commit_sha', %s::text, 'run_id', %s::text))",
                (IG_CHECK_NAMES[item], failed.get(item, True), REFEREE_GIT_SHA, run_id),
            )
        await conn.commit()


async def _record_gate_runs_at_one_instant(admin_dsn: str) -> None:
    """A hidden run failing IG-5 and a passing dev run whose rows carry the SAME `run_at` (written in one admin
    transaction, so `now()` is shared): only the run id distinguishes them. The ids are fixed so a tie on
    `run_at` resolves to the dev run's passing IG-5 (`order by ..., run_id`): six passing rows, from two runs."""
    hidden_run, dev_run = "ffffffff-ffff-4fff-bfff-ffffffffffff", "00000000-0000-4000-8000-000000000001"
    rows = [(IG_CHECK_NAMES[item], item != "IG-5", hidden_run) for item in IG_ITEMS]
    rows += [(IG_CHECK_NAMES[item], True, dev_run) for item in DEV_IG_ITEMS]
    async with await AsyncConnection.connect(admin_dsn) as conn:
        for name, passed, run_id in rows:
            await conn.execute(
                "insert into arena.isolation_checks (candidate_id, check_name, passed, evidence) values"
                " (null, %s, %s, jsonb_build_object('hash', 'it', 'commit_sha', %s::text, 'run_id', %s::text))",
                (name, passed, REFEREE_GIT_SHA, run_id),
            )
        await conn.commit()


def _assert_the_job_refuses_every_hidden_run_without_one_passing_gate(
    world: dict[str, Any], families: list[dict[str, Any]], tournament_id: UUID, seed: int
) -> None:
    """S1 L9, S3 9: `arena.open_tournament` checks nothing itself; the job runs a hidden tournament only after one
    complete gate run passed, on its own commit, between the roster freezing and the opening."""
    # The job runs it only on the commit its gate passed on (S3 9)...
    foreign = build_runner(world, tournament_id)
    foreign.code_sha = "e" * 40
    with pytest.raises(IsolationGateNotPassedError):
        run(foreign.run(tournament_id))
    # ...and never a hidden tournament opened without a gate run after its own roster froze: the gate rows above
    # predate this second roster, and `arena.open_tournament` itself checks nothing.
    ungated = _freeze_hidden_tournament(world, families, seed + 1)
    run(_admin_rows(world["admin"], "select arena.open_tournament(%s)", (ungated,)))
    with pytest.raises(IsolationGateNotPassedError):
        run(build_runner(world, ungated).run(ungated))
    assert run(_terminal_record_count(world["admin"], ungated)) == 0
    # ...nor one whose latest passing rows come from two runs: a hidden gate run failing IG-5, then a passing dev
    # gate run (which writes no IG-4 row), each in its own transaction as the referee writes them, on this commit.
    mixed = _freeze_hidden_tournament(world, families, seed + 2)
    run(_record_gate_run(world["admin"], {"IG-5": False}))
    run(_record_gate_run(world["admin"], {}, items=DEV_IG_ITEMS))
    run(_admin_rows(world["admin"], "select arena.open_tournament(%s)", (mixed,)))
    with pytest.raises(IsolationGateNotPassedError):
        run(build_runner(world, mixed).run(mixed))
    assert run(_terminal_record_count(world["admin"], mixed)) == 0
    # The same two runs committed at one instant (a microsecond tie): the run ids still tell them apart.
    tied = _freeze_hidden_tournament(world, families, seed + 3)
    run(_record_gate_runs_at_one_instant(world["admin"]))
    run(_admin_rows(world["admin"], "select arena.open_tournament(%s)", (tied,)))
    with pytest.raises(IsolationGateNotPassedError):
        run(build_runner(world, tied).run(tied))
    assert run(_terminal_record_count(world["admin"], tied)) == 0


def test_a_hidden_tournament_runs_end_to_end_and_its_trials_are_readable_only_after_reveal(
    world: dict[str, Any],
) -> None:
    """WP-27 + WP-28 (S1 10.3, S5 5.3, S8 WP-27/WP-28; docs/runbooks/hidden-seal.md): the whole operator
    sequence on 2 synthetic hidden families -- ingest with attestation, seal_hidden_split, verify the archive,
    register frozen candidates, add_planned_trials, freeze_tournament, the real isolation gate (canary
    placement and the hidden-text scan among its six items) opening the tournament to `running` -- then the
    real `TournamentRunner` on the fake model port through every track (corpus, corpus seal, replay,
    interactive block scoring, close), `begin_scoring`, reveal, and each trial's recording -- see the
    module-level note above for exactly what this does and does not prove about the 2 families' own content.

    The job reads each running trial it executes through `arena.harness_trial_state` (WP-28; the one read
    that sees a running hidden trial's own writes), never the reveal-gated projections. Those stay closed to
    every `arena_public` caller until reveal: before it, every projection a recording or export reads shows
    each hidden trial nothing (no actor, as the job or `dev_tournament_demo` call it), `make export-run`'s
    own loader answers None and the recording route 404; after reveal, all of them resolve."""
    # OD-14 (S3 4.3, C-36): the block-infra rule predeclared for every tournament today is the only one
    # implemented (direction 7.1's literal default, the owner decision is still pending) -- confirmed
    # against the running code, not assumed: one infra_failed of 18 invalidates the block (1/18 ~= 5.6% >
    # 5%); one of 20 does not (1/20 = 5% exactly, and the rule is "more than 5%").
    assert block_invalid([Exec.INFRA_FAILED, *([Exec.COMPLETED] * 17)]) is True
    assert block_invalid([Exec.INFRA_FAILED, *([Exec.COMPLETED] * 19)]) is False

    families = _seal_two_synthetic_hidden_families(world)
    seed = 20261012
    tournament_id = _freeze_hidden_tournament(world, families, seed)
    _open_hidden_tournament_through_the_real_gate(world, tournament_id)
    run(_admin_rows(world["admin"], "select tests.users()"))

    _assert_the_job_refuses_every_hidden_run_without_one_passing_gate(world, families, tournament_id, seed)

    summary = run(build_runner(world, tournament_id).run(tournament_id))
    assert summary.closed
    assert summary.outcomes == {"completed": PLANNED_TRIALS}
    assert run(_tournament_status(world["admin"], tournament_id)) == "sealed"
    assert run(_terminal_record_count(world["admin"], tournament_id)) == PLANNED_TRIALS
    trials = run(_hidden_trials(world["admin"], tournament_id))
    assert len(trials) == PLANNED_TRIALS
    # The job saw its own running hidden trials' cards (`arena.harness_trial_state`): it relayed proposals,
    # which it could not have done reading the reveal-gated `arena.v_trial_events` (every card a fallback).
    relayed = run(
        _admin_rows(
            world["admin"],
            "select count(*) from arena.turns u join arena.trials t on t.id = u.trial_id"
            " where t.tournament_id = %s and u.question_source = 'assistant_relay'",
            (tournament_id,),
        )
    )
    assert int(relayed[0][0]) > 0

    # Before reveal: nothing of any hidden trial through any projection, the export loader or the route.
    blind = ArenaDb(dsn_connector(world["public"]), actor=None)
    for trial in trials:
        assert run(_public_view_rows(world["public"], trial)) == [0, 0, 0, 0, 0, 0]
        assert run(export_run.export_from(blind, trial)) is None
    assert run(_api_recording_status(world, trials[0])) == httpx.codes.NOT_FOUND

    base_url = world["referee_base_url"]
    run(admin_post(f"/api/admin/tournaments/{tournament_id}/scoring", {}, base_url=base_url))
    revealed = run(admin_post(f"/api/admin/tournaments/{tournament_id}/reveal", {}, base_url=base_url))
    assert revealed["manifest_version"] == 1
    assert run(_tournament_status(world["admin"], tournament_id)) == "revealed"

    # After reveal: every hidden trial's recording resolves, with its sealed packet and its own events.
    for trial in trials:
        transcripts, *_ = run(_public_view_rows(world["public"], trial))
        assert transcripts > 0
        recording = run(export_run.export_from(blind, trial))
        assert recording is not None
        assert recording["events"]
    assert run(_api_recording_status(world, trials[0])) == httpx.codes.OK
