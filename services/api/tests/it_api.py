"""arena-api against the REAL migrated S4 functions (S5 5.2, 5.4, 5.6, 6.2, 6.3; S4 RE/ST/FC through the service).

`make db-test` runs it on the disposable Supabase Postgres container it has just migrated (with the subject suite,
`supabase/tests/harness/db_test.sh`), `ARENA_IT_ADMIN_DSN` naming that database's admin; never the hosted project.
Seeding goes through `supabase/tests/harness/fixtures.psql` (dev family F01, the four test users) plus the official
A1 and S1 manifests from `prompts/manifests`. The app runs in process as `arena_public` with the dev identity of user
A; the subject's answer is recorded as `arena_subject` through `arena_core.db.subject` (the same two calls
arena-subject makes; arena-api never imports arena-subject). Coach calls go through the real agent port on the fake
adapter with the in-memory guard (the guard's own suite proves the database guard).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import Coroutine
from decimal import Decimal
from http import HTTPStatus
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo

from arena_api.app import create_app, guard_config
from arena_api.state import ApiState
from arena_core.db import subject as db_subject
from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import DevIdentity
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import SubjectCall, SubjectOutcome
from tools import proc

REPO = Path(__file__).resolve().parents[3]
TESTS_DIR = REPO / "supabase" / "tests"
DSN_VAR = "ARENA_IT_ADMIN_DSN"
USER_A = UUID("00000000-0000-0000-0000-00000000000a")
USER_B = UUID("00000000-0000-0000-0000-00000000000b")
BASE = "http://127.0.0.1:8080"
TURNS = 3
F01_TITLE = "Records vault entry during a busy shift"
FINDING = {
    "label": "insufficient_evidence",
    "likelihood": "roughly_even_chance",
    "confidence": "low",
    "basis_flag_refs": [],
    "cited_turns": [1, 2],
    "cited_records": ["doc-01", "rec-01"],
    "corroboration_needed": ["the work orders for that afternoon"],
    "rationale": "The entry is not yet tested against the work orders.",
}


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _admin(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
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


@pytest.fixture(scope="module")
def dsns() -> dict[str, str]:
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
    run(_admin(admin, "select tests.users()"))
    run(_admin(admin, "select tests.seed_family('F01')"))
    for name in ("A1", "S1"):
        manifest = (REPO / "prompts" / "manifests" / f"{name}.json").read_text(encoding="utf-8")
        run(
            _admin(
                admin,
                "select arena.register_candidate(m->>'kind', m->>'candidate_id', m->>'version', m)"
                " from (select %s::jsonb m) x",
                (manifest,),
            )
        )
    return {
        "public": run(_login(admin, "arena_public")),
        "subject": run(_login(admin, "arena_subject")),
        "admin": admin,
    }


def _subject(connect: Connector) -> SubjectCall:
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


async def _no_sleep(_s: float) -> None:
    return None


async def _no_debrief(_session: UUID) -> dict[str, Any]:
    return {}


class Client:
    def __init__(self, dsns: dict[str, str], user: UUID = USER_A) -> None:
        port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep))
        who = DevIdentity(user_id=user, email="x@example.test", display_name="X", roles=frozenset({"investigator"}))
        state = ApiState(
            connect=dsn_connector(dsns["public"]),
            identity=who,
            port=port,
            subject=_subject(dsn_connector(dsns["subject"])),
            debrief=_no_debrief,
            stream_max_s=0.5,
            stream_poll_s=0.05,
        )
        self.app = create_app(state, guard_config({}))
        self.csrf = ""

    async def call(
        self, method: str, path: str, body: object = None, params: dict[str, str | int] | None = None
    ) -> httpx.Response:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=BASE) as client:
            me = await client.get("/api/me")
            token = me.json()["csrf_token"]
            client.cookies.set("arena_csrf", token)
            headers = {"Origin": BASE, "X-Arena-CSRF": token}
            return await client.request(method, path, json=body, headers=headers, params=params)

    def get(self, path: str, params: dict[str, str | int] | None = None) -> httpx.Response:
        return run(self.call("GET", path, params=params))

    def post(self, path: str, body: object = None) -> httpx.Response:
        return run(self.call("POST", path, body))


def test_a_whole_interview_through_the_real_functions(dsns: dict[str, str]) -> None:
    api = Client(dsns)
    assert api.post("/api/me/ack-ex4").status_code == HTTPStatus.OK  # EX-4 before any session
    # The database is shared with the other suites, which may have committed fixture families of their own: the
    # interview runs on F01, one variant of which the draw lists (C-37).
    cases = [c for c in api.get("/api/cases").json()["cases"] if c["title"] == F01_TITLE]
    assert len(cases) == 1
    started = api.post(
        "/api/sessions", {"case_id": cases[0]["case_id"], "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    )
    assert started.status_code == HTTPStatus.OK, started.text
    trial = started.json()["trial_id"]

    version = 0
    for n in range(1, TURNS + 1):
        body = {
            "question": f"Question {n}: what did you do?",
            "release_ids": [],
            "expected_version": version,
            "idem_key": str(uuid4()),
        }
        r = api.post(f"/api/trials/{trial}/turns", body)
        assert r.status_code == HTTPStatus.OK, r.text
        assert r.json()["turn_no"] == n
        if n == 1:  # S5 5.6: a replayed POST returns the stored turn and writes nothing new
            again = api.post(f"/api/trials/{trial}/turns", body)
            assert again.json()["turn_no"] == 1
            assert again.json()["last_seq"] == r.json()["last_seq"]
        version = r.json()["version"]

    stale = api.post(
        f"/api/trials/{trial}/turns",
        {"question": "Again?", "release_ids": [], "expected_version": 0, "idem_key": str(uuid4())},
    )
    assert (stale.status_code, stale.json()["code"]) == (HTTPStatus.CONFLICT, "stale_version")

    unknown = api.post(f"/api/trials/{trial}/evidence-requests", {"record_ids": ["rec-05"], "idem_key": str(uuid4())})
    assert unknown.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    released = api.post(
        f"/api/trials/{trial}/evidence-requests", {"record_ids": ["rec-01", "rec-04"], "idem_key": str(uuid4())}
    )
    assert released.status_code == HTTPStatus.OK, released.text
    assert [r["record_id"] for r in released.json()["released"]] == ["rec-01"]
    assert released.json()["denied"] == ["rec-04"]

    snap = api.get(f"/api/trials/{trial}/snapshot").json()
    assert snap["exchanges_used"] == TURNS
    assert len(snap["cards"]) == TURNS
    assert len(snap["updates"]) == 1
    assert snap["released"][0]["record_id"] == "rec-01"
    assert snap["released"][0]["content"]["body"]

    ticket = api.post(f"/api/trials/{trial}/stream-tickets").json()["ticket"]
    stream = api.get(f"/api/trials/{trial}/events", {"ticket": ticket, "after": 0}).text
    frames = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith("data: ")]
    assert [f["seq"] for f in frames if f["seq"] is not None] == list(range(1, snap["last_seq"] + 1))
    reused = api.get(f"/api/trials/{trial}/events", {"ticket": ticket, "after": 0})
    assert reused.status_code == HTTPStatus.UNAUTHORIZED

    bad = api.post(
        f"/api/trials/{trial}/finding", {"finding": {**FINDING, "cited_records": ["doc-04"]}, "idem_key": str(uuid4())}
    )
    assert bad.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    done = api.post(f"/api/trials/{trial}/finding", {"finding": FINDING, "idem_key": str(uuid4())})
    assert done.status_code == HTTPStatus.OK, done.text
    assert done.json()["status"] == "completed"

    rec = api.get(f"/api/trials/{trial}/recording").json()
    assert rec["format"] == "arena.recording.v1"
    assert rec["events"][-1]["frame"]["type"] == "trial.finalized"
    assert rec["events"][-1]["frame"]["data"]["commitment_hash"] == done.json()["commitment_hash"]

    counts = run(
        _admin(
            dsns["admin"],
            "select (select count(*) from arena.turns where trial_id = %s),"
            " (select count(*) from arena.trial_events where trial_id = %s and kind = 'coach_card'),"
            " (select bool_and(verify) from (select ledger.verify_commitment(%s) verify) v)",
            (trial, trial, trial),
        )
    )
    assert counts == [(TURNS, TURNS, True)]


def test_another_users_trial_is_404_on_every_route(dsns: dict[str, str]) -> None:
    owner, other = Client(dsns), Client(dsns, USER_B)
    owner.post("/api/me/ack-ex4")
    case = next(c["case_id"] for c in owner.get("/api/cases").json()["cases"] if c["title"] == F01_TITLE)
    started = owner.post(
        "/api/sessions", {"case_id": case, "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    )
    trial, session = started.json()["trial_id"], started.json()["session_id"]
    assert owner.get(f"/api/trials/{trial}/snapshot").status_code == HTTPStatus.OK
    turn = {"question": "Why?", "release_ids": [], "expected_version": 0, "idem_key": str(uuid4())}
    for status in (
        other.get(f"/api/trials/{trial}/snapshot").status_code,
        other.get(f"/api/trials/{trial}/recording").status_code,
        other.post(f"/api/trials/{trial}/stream-tickets").status_code,
        other.post(f"/api/trials/{trial}/turns", turn).status_code,
        other.get(f"/api/sessions/{session}").status_code,
        other.get(f"/api/sessions/{session}/debrief").status_code,
    ):
        assert status == HTTPStatus.NOT_FOUND


def test_the_trust_center_reads_the_real_views(dsns: dict[str, str]) -> None:
    api = Client(dsns)
    for section in ("isolation", "commitments", "fairness", "methodology", "budget"):
        assert api.get(f"/api/trust/{section}").status_code == HTTPStatus.OK
    budget = api.get("/api/trust/budget").json()
    assert set(budget) == {"ceiling_usd", "spent_usd", "open_usd", "by_purpose", "planned_n"}
    assert isinstance(api.get("/api/trust/commitments").json()["commitments"], list)
