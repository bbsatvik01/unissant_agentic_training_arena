"""The KPI-1 study end to end against the REAL migrated S4 functions (S3 6.1, S4 training, S5 5.5, S6 3.2; WP-30):
`scripts/kpi1.py setup` as `arena_referee`, then two participants each run two pre-tests, three practice sessions
and two post-tests through arena-api (in process, `arena_public`, the dev identity of each user in turn) with every
debrief published by a real `python -m arena_referee` subprocess in `ARENA_MODEL_MODE=fake`; then
`GET /api/progress` returns each participant's KPI-1 numbers and `scripts/kpi1.py report` the cohort estimate.

`make db-test` runs it on the seed_hosted step's own database (`supabase/tests/harness/db_test.sh`), after
`it_seed_hosted.py` and `it_real_smoke.py`: the nine dev families ingested through `sealed.ingest_case_family`
with their real attestations, the official roster registered and the budget plan applied. Never the hosted
project, never a model call. The file name does not match `test_*.py`, so `make test` never collects it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
import time
from collections.abc import Coroutine, Iterator
from dataclasses import dataclass
from decimal import Decimal
from http import HTTPStatus
from pathlib import Path
from subprocess import Popen, TimeoutExpired
from typing import Any
from uuid import UUID, uuid4

import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo
from starlette.types import ASGIApp, Message

from arena_api.app import create_app, guard_config
from arena_api.referee_client import DebriefCall, RefereeError, referee_client
from arena_api.state import ApiState
from arena_core.db import subject as db_subject
from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import DevIdentity, user_id_for
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import SubjectCall, SubjectOutcome
from scripts import kpi1, seed_hosted
from tools.tests.subprocess_support import popen_role_module

DSN_VAR = "ARENA_IT_ADMIN_DSN"
EMAILS = ("kpi1-one@arena.local", "kpi1-two@arena.local")
BASE = "http://127.0.0.1:8080"
TURNS = 3  # S3 2.2: a session below three questions is unscorable
CALLER_TOKEN = secrets.token_hex(24)
REFEREE_READY_TIMEOUT_S = 60.0
PRACTICE_FAMILIES = 5  # F01-F05: the dev families outside the KPI-1 sets
PRACTICE_SESSIONS = kpi1.PRACTICE_NEEDED
TESTS_PER_PHASE = 2
QUESTIONS = (
    "Please walk me through that evening from the start.",
    "Which records would show where you were at that time?",
    "Who else could confirm what you have described?",
)


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


async def _probe(debrief: DebriefCall) -> int:
    """The referee's answer to a debrief for an unknown session: 404 once it serves, 503 while unreachable."""
    try:
        await debrief(uuid4())
    except RefereeError as exc:
        return exc.status
    return HTTPStatus.OK


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, str]]:
    admin = os.environ.get(DSN_VAR, "")
    if not admin:
        msg = f"{DSN_VAR} is not set: this suite runs inside make db-test on a freshly migrated database"
        raise RuntimeError(msg)
    bundles, manifests = seed_hosted.dev_bundles(), seed_hosted.candidate_manifests()
    for email in EMAILS:  # the operator's make seed-hosted EMAIL=... for each participant (idempotent)
        run(seed_hosted.seed(dsn_connector(admin), email=email, bundles=bundles, manifests=manifests))
    users = tmp_path_factory.mktemp("kpi1") / "users.toml"
    users.write_text(
        '[[users]]\nemail = "kpi1-admin@arena.local"\ndisplay_name = "admin"\nroles = ["admin"]\n', encoding="utf-8"
    )
    dsns = {role: run(_login(admin, f"arena_{role}")) for role in ("public", "subject", "referee")}
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ARENA_", "GEMINI_", "GOOGLE_"))}
    env.update(
        {
            "ARENA_ROLE": "referee",
            "ARENA_GCP_PROJECT": "cna-guardian",
            "ARENA_REFEREE_DSN": dsns["referee"],
            "ARENA_ENV": "local",
            "ARENA_BIND_HOST": "127.0.0.1",
            "ARENA_MODEL_MODE": "fake",
            "ARENA_LOCAL_CALLERS": hashlib.sha256(CALLER_TOKEN.encode()).hexdigest(),
            "ARENA_USERS_FILE": str(users),
            "ARENA_DEV_USER": "kpi1-admin@arena.local",
            "ARENA_REFEREE_PORT": str(port),
            "ARENA_GIT_SHA": "e" * 40,  # fixture value only: create_app refuses to boot without one (S3 9)
        }
    )
    process: Popen[str] = popen_role_module("arena_referee", env)
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + REFEREE_READY_TIMEOUT_S
    probe = referee_client(CALLER_TOKEN, base_url=base_url)
    while True:
        if process.poll() is not None:
            out = process.stdout.read() if process.stdout else ""
            msg = f"arena-referee exited early ({process.returncode}):\n{out}"
            raise RuntimeError(msg)
        if run(_probe(probe)) == HTTPStatus.NOT_FOUND:  # serving: an unknown session is a 404
            break
        if time.monotonic() > deadline:
            process.terminate()
            msg = "arena-referee never became ready"
            raise RuntimeError(msg)
        time.sleep(0.2)
    try:
        yield {**dsns, "admin": admin, "referee_url": base_url}
    finally:
        process.terminate()
        try:
            process.wait(timeout=10.0)
        except TimeoutExpired:  # silent-ok: the standard escalate-to-SIGKILL fallback for a hung child
            process.kill()
            process.wait(timeout=10.0)
        if process.stdout:
            process.stdout.close()


def _subject(connect: Connector) -> SubjectCall:
    async def answer(trial: UUID, work_item: UUID, _actor: UUID | None) -> SubjectOutcome:
        async with connect() as conn:
            ctx = await db_subject.turn_context(conn, trial, work_item)
        req = db_subject.RecordSubjectTurn(
            trial_id=trial,
            work_item_id=work_item,
            utterance=f"For question {ctx.turn_no}: I was at my desk and then I went to the supply room.",
            tag={"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []},
            guard_result={"passed": True},
        )
        async with connect() as conn:
            recorded = await db_subject.record_subject_turn(conn, req)
        return SubjectOutcome(recorded.outcome, recorded.turn_no)

    return answer


async def _no_sleep(_s: float) -> None:
    return None


@dataclass(frozen=True)
class Reply:
    status_code: int
    headers: list[tuple[bytes, bytes]]
    text: str

    def json(self) -> dict[str, Any]:
        body: dict[str, Any] = json.loads(self.text)
        return body

    def cookie(self) -> str:
        """The `name=value` pairs of every Set-Cookie header, as a Cookie header."""
        pairs = [v.decode().split(";", 1)[0] for k, v in self.headers if k.lower() == b"set-cookie"]
        return "; ".join(pairs)


async def _asgi(app: ASGIApp, method: str, path: str, headers: list[tuple[bytes, bytes]], body: object = None) -> Reply:
    """One request straight into the ASGI app object, in process (no socket, no HTTP client), as it_api.py does
    with httpx's ASGI transport."""
    payload = b"" if body is None else json.dumps(body).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"127.0.0.1:8080"), (b"content-type", b"application/json"), *headers],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8080),
    }
    sent = asyncio.Event()
    done = asyncio.Event()
    status = 0
    out_headers: list[tuple[bytes, bytes]] = []
    chunks: list[bytes] = []

    async def receive() -> Message:
        if not sent.is_set():
            sent.set()
            return {"type": "http.request", "body": payload, "more_body": False}
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
            out_headers.extend(message.get("headers", []))
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                done.set()

    await app(scope, receive, send)
    done.set()
    return Reply(status, out_headers, b"".join(chunks).decode())


class Investigator:
    """arena-api in process as one allowlisted user (S5 10.3: one acting user per run)."""

    def __init__(self, world: dict[str, str], email: str) -> None:
        port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep))
        who = DevIdentity(user_id=user_id_for(email), email=email, display_name="P", roles=frozenset({"investigator"}))
        state = ApiState(
            connect=dsn_connector(world["public"]),
            identity=who,
            port=port,
            subject=_subject(dsn_connector(world["subject"])),
            debrief=referee_client(CALLER_TOKEN, base_url=world["referee_url"]),
            case_draw_seed="20261024",
            stream_max_s=0.5,
            stream_poll_s=0.05,
        )
        self.app = create_app(state, guard_config({}))

    def call(self, method: str, path: str, body: object = None) -> Reply:
        async def go() -> Reply:
            me = await _asgi(self.app, "GET", "/api/me", [])
            token = me.json()["csrf_token"]
            cookie = me.cookie()
            headers = [(b"origin", BASE.encode()), (b"x-arena-csrf", token.encode()), (b"cookie", cookie.encode())]
            return await _asgi(self.app, method, path, headers, body)

        return run(go())

    def get(self, path: str) -> dict[str, Any]:
        r = self.call("GET", path)
        assert r.status_code == HTTPStatus.OK, r.text
        body: dict[str, Any] = r.json()
        return body

    def start(self, case_id: str, mode: str) -> Reply:
        return self.call(
            "POST", "/api/sessions", {"case_id": case_id, "mode": mode, "voice": False, "idem_key": str(uuid4())}
        )

    def session(self, case_id: str, mode: str, phase: str) -> int:
        """One whole session: start, three questions, a finding, the published debrief; returns its score."""
        brief = self.get(f"/api/cases/{case_id}")["brief"]
        doc = brief["initial_documents"][0]["doc_id"]
        started = self.start(case_id, mode)
        assert started.status_code == HTTPStatus.OK, started.text
        assert started.json()["phase"] == phase
        trial, session = started.json()["trial_id"], started.json()["session_id"]
        version = 0
        for n, question in enumerate(QUESTIONS, start=1):
            body = {"question": question, "release_ids": [], "expected_version": version, "idem_key": str(uuid4())}
            r = self.call("POST", f"/api/trials/{trial}/turns", body)
            assert r.status_code == HTTPStatus.OK, r.text
            assert r.json()["turn_no"] == n
            version = r.json()["version"]
        # Every requestable record whose window has opened (after the questions above); the ones released are cited.
        wanted = [r["record_id"] for r in brief["requestable_records"] if r["requestable_after_exchanges"] <= n]
        released: list[str] = []
        if wanted:
            asked = self.call(
                "POST", f"/api/trials/{trial}/evidence-requests", {"record_ids": wanted, "idem_key": str(uuid4())}
            )
            assert asked.status_code == HTTPStatus.OK, asked.text
            released = [r["record_id"] for r in asked.json()["released"]]
        finding = {
            "label": "insufficient_evidence",
            "likelihood": "roughly_even_chance",
            "confidence": "low",
            "basis_flag_refs": [],
            "cited_turns": [1, 2],
            "cited_records": [doc, *released],
            "corroboration_needed": ["the access log for that evening"],
            "rationale": "The account is not yet tested against the access log.",
        }
        done = self.call("POST", f"/api/trials/{trial}/finding", {"finding": finding, "idem_key": str(uuid4())})
        assert done.status_code == HTTPStatus.OK, done.text
        published = self.call("POST", f"/api/sessions/{session}/debrief")
        assert published.status_code == HTTPStatus.OK, published.text
        rubric = published.json()["rubric"]
        assert published.json()["scored"] is True
        assert rubric["scorable"] is True
        return int(rubric["total"])

    def study(self) -> dict[str, Any]:
        found: dict[str, Any] = self.get("/api/me")["study"]
        return found


def _cases(user: Investigator) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = user.get("/api/cases")["cases"]
    return found


def _protocol(world: dict[str, str], email: str) -> None:
    """One participant through the whole protocol (S3 6.1, S6 3.2), then their KPI-1 numbers from progress."""
    user = Investigator(world, email)
    assert user.call("POST", "/api/me/ack-ex4").status_code == HTTPStatus.OK
    test_ids = {m.case_id for m in kpi1.case_sets()}
    pre_ids = {m.case_id for m in kpi1.case_sets() if m.set_code == user.study()["counterbalance"][0]}

    assert user.study()["next_phase"] == "pre"
    listed = [c["case_id"] for c in _cases(user)]
    assert set(listed) == pre_ids  # the pre-test set, whole, and nothing else
    practice_first = user.start(listed[0], "practice")
    assert practice_first.status_code == HTTPStatus.UNPROCESSABLE_ENTITY  # tests run in assessment mode
    pre = [user.session(case_id, "assessment", "pre") for case_id in listed]

    assert user.study()["next_phase"] == "practice"
    practice = [c["case_id"] for c in _cases(user)]
    assert len(practice) == PRACTICE_FAMILIES  # F01-F05, one variant each (C-37)
    assert not set(practice) & test_ids  # the KPI-1 families are never offered for practice (X-08)
    for case_id in practice[:PRACTICE_SESSIONS]:
        user.session(case_id, "practice", "practice")

    # S4-D3: five text sessions a user a day, so the seven-session protocol spans two days unless the owner
    # raises the quota. The sixth start is refused here exactly as it would be on the day; the test then stands
    # in for "the next day" by lifting the quota on this throwaway database only, and restores it.
    assert user.study()["next_phase"] == "post"
    refused = user.start(sorted(test_ids - pre_ids)[0], "assessment")
    assert (refused.status_code, refused.json()) == (HTTPStatus.TOO_MANY_REQUESTS, {"code": "quota"})
    quota = run(_admin(world["admin"], "select text_sessions_per_user_day from ops.config where id"))[0][0]
    run(_admin(world["admin"], "update ops.config set text_sessions_per_user_day = null where id"))
    try:
        listed = [c["case_id"] for c in _cases(user)]
        assert set(listed) == test_ids - pre_ids
        post = [user.session(case_id, "assessment", "post") for case_id in listed]
    finally:
        run(_admin(world["admin"], "update ops.config set text_sessions_per_user_day = %s where id", (quota,)))

    assert user.study()["next_phase"] == "done"
    progress = user.get("/api/progress")
    assert len(progress["sessions"]) == len(pre) + PRACTICE_SESSIONS + len(post)
    k = progress["kpi1"]
    assert k is not None
    assert k["pre"] == sum(pre) / len(pre)
    assert k["post"] == sum(post) / len(post)
    assert k["absolute_change"] == k["post"] - k["pre"]
    assert k["relative_change"] == (None if k["pre"] == 0 else (k["post"] - k["pre"]) / k["pre"])


def _human_rating(world: dict[str, str], capsys: pytest.CaptureFixture[str], out: Path) -> None:
    """Blinded human rating (S3 6.1): export, a rater fills the sheet, import; then the report from human scores."""
    referee_env = {kpi1.DSN_VAR: world["referee"]}
    assert kpi1.main(["report", "--scorer", "human"], env=referee_env) == 0
    assert json.loads(capsys.readouterr().out)["kpi1"].startswith(kpi1.PENDING)  # no rating yet
    assert kpi1.main(["export-blind", "--out", str(out)], env=referee_env) == 0
    capsys.readouterr()
    items = json.loads((out / "items.json").read_text(encoding="utf-8"))["items"]
    assert len(items) == len(EMAILS) * TESTS_PER_PHASE * 2
    assert all(len(i["transcript"]) == len(QUESTIONS) and i["finding"] for i in items)
    blob = json.dumps(items)
    assert "@" not in blob
    assert "P01" not in blob
    assert "pre" not in {k for i in items for k in i}
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    released_db = run(
        _admin(
            world["admin"],
            "select s.id::text, count(r.record_id) from training.sessions s"
            " left join arena.released_evidence r on r.trial_id = s.trial_id"
            " where s.phase in ('pre', 'post') group by 1",
        )
    )
    released_count = {r[0]: r[1] for r in released_db}
    for item in items:  # the rater sees exactly the records released in that session, with their positions
        assert len(item["released_records"]) == released_count[key[item["blind_id"]]]
        cited = set(item["finding"]["cited_records"]) - {d["doc_id"] for d in item["initial_documents"]}
        assert cited <= {r["record_id"] for r in item["released_records"]}  # every cited record is in the export
    assert any(item["released_records"] for item in items)
    assert any(len(item["finding"]["cited_records"]) > 1 for item in items)  # some finding cites a released record
    phase_of = {
        str(r[0]): r[1]
        for r in run(_admin(world["admin"], "select id, phase from training.sessions where phase in ('pre', 'post')"))
    }
    sheet = json.loads((out / "ratings.json").read_text(encoding="utf-8"))
    for rating in sheet["ratings"]:  # every check passes, except 1a on every pre-test: D1 3 of 4 -> 3, total 95
        pre_test = phase_of[key[rating["blind_id"]]] == "pre"
        rating["checks"] = {c: "fail" if pre_test and c == "1a" else "pass" for c in rating["checks"]}
    (out / "ratings.json").write_text(json.dumps(sheet), encoding="utf-8")
    imported = ["import-human", "--ratings", str(out / "ratings.json"), "--key", str(out / "key.json")]
    assert kpi1.main(imported, env=referee_env) == 0
    assert capsys.readouterr().out.startswith(f"{len(items)} human scores stored")
    assert kpi1.main(imported, env=referee_env) == 0  # idempotent per (session, rater)
    assert capsys.readouterr().out.startswith("0 human scores stored")
    assert kpi1.main(["report", "--scorer", "human"], env=referee_env) == 0
    human = json.loads(capsys.readouterr().out)["kpi1"]
    assert (human["mean_abs"], human["mean_rel"], human["met"]) == (5.0, round(5 / 95, 4), False)  # 95 -> 100


def test_kpi1_setup_then_two_participants_through_the_whole_protocol(
    world: dict[str, str], capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    referee_env = {kpi1.DSN_VAR: world["referee"]}
    assert kpi1.main(["setup", "--emails", ",".join(EMAILS)], env=referee_env) == 0
    plan = capsys.readouterr().out
    assert "Set A: C-6WQ3HD9P (F06 truthful), C-M7XH3R5P (F07 deceptive)" in plan
    assert plan.count("(new)") == len(EMAILS)
    # Re-running is a no-op: the same rows, both participants reported as existing.
    assert kpi1.main(["setup", "--emails", ",".join(EMAILS)], env=referee_env) == 0
    assert capsys.readouterr().out.count("already a participant") == len(EMAILS)
    rows = run(_admin(world["admin"], "select code, counterbalance from training.participants order by code"))
    assert sorted(r[1] for r in rows) == ["AB", "BA"]
    flagged = run(
        _admin(world["admin"], "select distinct family_code from arena.v_dev_cases where kpi1_set order by 1")
    )
    assert [r[0] for r in flagged] == list(kpi1.KPI1_FAMILIES)

    for email in EMAILS:
        _protocol(world, email)

    assert kpi1.main(["report"], env=referee_env) == 0
    report = json.loads(capsys.readouterr().out)
    assert (report["n_participants"], report["n_completed"]) == (len(EMAILS), len(EMAILS))
    assert isinstance(report["kpi1"]["mean_abs"], float)
    for p in report["participants"]:
        assert p["completed"] is True
        assert len(p["pre_scores"]) == len(p["post_scores"]) == TESTS_PER_PHASE
    assert "@" not in json.dumps(report)
    assert set(report["kpi1"]["ci"]) == {"mean_rel", "median_rel", "share_ge_20pct", "mean_abs", "ratio_of_means"}

    _human_rating(world, capsys, tmp_path / "blind")


def test_setup_refuses_a_user_who_practised_on_a_kpi1_family_before(world: dict[str, str]) -> None:
    # Runs after the study test: the sets exist, so the API no longer lists F06-F09 for practice. A user who saw one
    # before the sets were written is simulated by an admin-inserted session on F06 (the API refuses it now).
    late = "kpi1-late@arena.local"
    run(
        seed_hosted.seed(
            dsn_connector(world["admin"]),
            email=late,
            bundles=seed_hosted.dev_bundles(),
            manifests=seed_hosted.candidate_manifests(),
        )
    )
    variant = run(
        _admin(
            world["admin"],
            "select v.id from arena.case_variants v join arena.case_families f on f.id = v.family_id"
            " where f.family_code = 'F06' order by v.variant_code limit 1",
        )
    )[0][0]
    cand = dict(run(_admin(world["admin"], "select kind, id from arena.candidates where name in ('A1', 'S1')")))
    trial = run(
        _admin(
            world["admin"],
            "insert into arena.trials (kind, variant_id, assistant_candidate_id, subject_candidate_id, mode,"
            " owner_user_id, status, started_at) values ('training', %s, %s, %s, 'practice', %s, 'running', now())"
            " returning id",
            (variant, cand["assistant"], cand["subject"], user_id_for(late)),
        )
    )[0][0]
    run(
        _admin(
            world["admin"],
            "insert into training.sessions (trial_id, user_id, phase, idempotency_key) values (%s, %s, 'practice', %s)",
            (trial, user_id_for(late), "kpi1-late-practice"),
        )
    )
    assert kpi1.main(["setup", "--emails", late], env={kpi1.DSN_VAR: world["referee"]}) == 1
    count = run(
        _admin(world["admin"], "select count(*) from training.participants where user_id = %s", (user_id_for(late),))
    )
    assert count == [(0,)]


def test_setup_refuses_an_email_that_is_not_allowlisted(world: dict[str, str]) -> None:
    assert kpi1.main(["setup", "--emails", "nobody@arena.local"], env={kpi1.DSN_VAR: world["referee"]}) == 1
