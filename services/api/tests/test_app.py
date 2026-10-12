"""arena-api routes in process (S5 5.5, 5.6, 6.3-6.5, 10.3-10.4) over the in-memory S4 (`fakedb`) and the real agent
port on the fake adapter: the D10 boundary, the dev identity, the kill switch, the whole interview path, the
ticketed stream and the recording."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Coroutine
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from http import HTTPStatus
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest

from arena_api.app import create_app, guard_config
from arena_api.referee_client import RefereeError
from arena_api.state import QUESTION_MAX_CHARS, ApiState
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.db.pool import Connector
from arena_core.identity import DevIdentity, user_id_for
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import SubjectOutcome, SubjectUnavailableError
from packages.core.tests.turns.fakedb import PACKET, FakeArenaDb

REPO = Path(__file__).resolve().parents[3]
BASE = "http://127.0.0.1:8080"
PLANNED_N = 30  # S8 1.3 baseline
TURNS = 3  # A1's deep update falls on the third exchange
EMAIL = "a@example.test"
WHO = DevIdentity(user_id=user_id_for(EMAIL), email=EMAIL, display_name="A", roles=frozenset({"investigator"}))


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _no_sleep(_s: float) -> None:
    return None


@dataclass(frozen=True)
class Req:
    body: object = None
    raw: bool = False
    headers: dict[str, str] = field(default_factory=dict)
    params: dict[str, str | int] = field(default_factory=dict)


class Harness:
    def __init__(self, *, identity: DevIdentity | None = WHO, mode: str = "practice") -> None:
        self.db = FakeArenaDb(WHO.user_id, mode=mode)
        self.db.acks["ex4"] = datetime(2026, 10, 11, tzinfo=UTC)  # acknowledged unless a test says otherwise
        self.subject_error: SubjectUnavailableError | None = None
        self.referee_error: RefereeError | None = None

        def make_db(_c: Connector, _actor: UUID) -> ArenaDb:
            return self.db

        port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep))
        self.state = ApiState(
            connect=self.db._connect,
            identity=identity,
            port=port,
            subject=self.subject,
            debrief=self.debrief,
            make_db=make_db,
            stream_max_s=0.3,
            stream_poll_s=0.01,
            ping_after_s=0.05,
        )
        self.app = create_app(self.state, guard_config({}), phoenix_url=None)

    async def subject(self, _trial: UUID, work_item: UUID, _actor: UUID | None) -> SubjectOutcome:
        if self.subject_error is not None:
            raise self.subject_error
        return self.db.record_answer(work_item)

    async def debrief(self, session: UUID) -> dict[str, Any]:
        if self.referee_error is not None:
            raise self.referee_error
        self.db.debriefs[session] = {"schema_version": "debrief.v1", "session_id": str(session)}
        return self.db.debriefs[session]

    async def _call(self, method: str, path: str, request: Req) -> httpx.Response:
        transport = httpx.ASGITransport(app=self.app)
        headers = dict(request.headers)
        async with httpx.AsyncClient(transport=transport, base_url=BASE) as client:
            if method == "POST" and not request.raw:
                me = await client.get("/api/me")
                token = me.json().get("csrf_token", "")
                client.cookies.set("arena_csrf", token)
                headers.update({"Origin": BASE, "X-Arena-CSRF": token})
            return await client.request(method, path, json=request.body, headers=headers, params=request.params)

    def get(
        self, path: str, *, headers: dict[str, str] | None = None, params: dict[str, str | int] | None = None
    ) -> httpx.Response:
        return run(self._call("GET", path, Req(headers=headers or {}, params=params or {})))

    def post(
        self, path: str, body: object = None, *, raw: bool = False, headers: dict[str, str] | None = None
    ) -> httpx.Response:
        return run(self._call("POST", path, Req(body=body, raw=raw, headers=headers or {})))

    @property
    def trial(self) -> str:
        return str(self.db.trial_id)

    def start(self, mode: str = "practice") -> dict[str, Any]:
        r = self.post(
            "/api/sessions", {"case_id": PACKET["case_id"], "mode": mode, "voice": False, "idem_key": str(uuid4())}
        )
        assert r.status_code == HTTPStatus.OK, r.text
        return dict(r.json())

    def turn(self, question: str = "What happened at B-12?", version: int | None = None) -> httpx.Response:
        body = {
            "question": question,
            "release_ids": [],
            "expected_version": self.db.version if version is None else version,
            "idem_key": str(uuid4()),
        }
        return self.post(f"/api/trials/{self.trial}/turns", body)


FINDING = {
    "label": "insufficient_evidence",
    "likelihood": "roughly_even_chance",
    "confidence": "low",
    "basis_flag_refs": [],
    "cited_turns": [1],
    "cited_records": ["doc-01"],
    "corroboration_needed": ["the work orders for that afternoon"],
    "rationale": "The entry is not yet tested against the work orders.",
}


# ------------------------------------------------------------------ D10 boundary and identity (S5 10.3, 10.4)


def test_health_is_liveness_only() -> None:
    h = Harness(identity=None)
    assert h.get("/api/health").json() == {"ok": True}


def test_a_foreign_host_is_421_before_routing() -> None:
    h = Harness()
    assert h.get("/api/me", headers={"Host": "evil.example"}).status_code == HTTPStatus.MISDIRECTED_REQUEST


def test_posts_need_an_allowed_origin_and_the_csrf_header() -> None:
    h = Harness()
    body = {"case_id": PACKET["case_id"], "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    foreign = h.post("/api/sessions", body, raw=True, headers={"Origin": "http://evil.example"})
    no_csrf = h.post("/api/sessions", body, raw=True, headers={"Origin": BASE})
    assert (foreign.status_code, no_csrf.status_code) == (403, 403)
    assert "start_session" not in h.db.calls


def test_internal_paths_are_not_served_here() -> None:
    assert Harness().post("/internal/answer", {}, raw=True).status_code == HTTPStatus.UNAUTHORIZED


def test_a_user_outside_the_allowlist_is_403_everywhere() -> None:
    h = Harness(identity=None)
    assert h.get("/api/me").status_code == HTTPStatus.FORBIDDEN
    assert h.get("/api/cases").status_code == HTTPStatus.FORBIDDEN


def test_the_kill_switch_pauses_every_api_route() -> None:
    h = Harness()
    h.db.paused = True
    r = h.get("/api/cases")
    assert (r.status_code, r.json()) == (503, {"code": "paused"})


def test_me_sets_the_csrf_cookie_and_reports_the_identity() -> None:
    h = Harness()
    h.db.acks.clear()
    r = h.get("/api/me")
    body = r.json()
    assert body["user_id"] == str(WHO.user_id)
    assert body["ex4_acknowledged"] is None
    assert body["study"] is None
    assert "arena_csrf=" in r.headers["set-cookie"]
    assert "samesite=strict" in r.headers["set-cookie"].lower()
    assert h.post("/api/me/ack-ex4").status_code == HTTPStatus.OK
    assert h.get("/api/me").json()["ex4_acknowledged"].startswith("2026-10-11")


def test_config_flags() -> None:
    body = Harness().get("/api/config").json()
    assert body["question_max_chars"] == QUESTION_MAX_CHARS
    assert body["voice_available"] is False
    assert body["paused"] is False


# ------------------------------------------------------------------ cases and sessions


def test_cases_list_one_variant_per_family_and_the_brief() -> None:
    h = Harness()
    cases = h.get("/api/cases").json()["cases"]
    assert [c["case_id"] for c in cases] == [PACKET["case_id"]]
    assert "role" not in json.dumps(cases)
    brief = h.get(f"/api/cases/{PACKET['case_id']}").json()
    assert brief["brief"]["case_id"] == PACKET["case_id"]
    assert h.get("/api/cases/C-ZZZZZZZZ").status_code == HTTPStatus.NOT_FOUND


def test_session_start_and_read() -> None:
    h = Harness()
    started = h.start()
    assert started["phase"] == "practice"
    assert started["trial_id"] == h.trial
    s = h.get(f"/api/sessions/{started['session_id']}").json()
    assert s["status"] == "running"
    assert h.get(f"/api/sessions/{uuid4()}").status_code == HTTPStatus.NOT_FOUND


def test_session_start_refusals() -> None:
    h = Harness()
    voice = h.post(
        "/api/sessions", {"case_id": PACKET["case_id"], "mode": "practice", "voice": True, "idem_key": str(uuid4())}
    )
    unassigned = h.post(
        "/api/sessions", {"case_id": "C-ZZZZZZZZ", "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    )
    assert (voice.status_code, unassigned.status_code) == (422, 404)
    h.db.fail_next["start_session"] = ArenaError("AR040", "daily session quota reached")
    quota = h.post(
        "/api/sessions", {"case_id": PACKET["case_id"], "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    )
    assert quota.status_code == HTTPStatus.TOO_MANY_REQUESTS
    h.db.fail_next["start_session"] = ArenaError("AR007", "pre and post tests run in assessment mode")
    refused = h.post(
        "/api/sessions", {"case_id": PACKET["case_id"], "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    )
    assert refused.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ------------------------------------------------------------------ the interview (S5 5.2, 5.4)


def test_a_whole_practice_interview() -> None:
    h = Harness()
    h.start()
    for n in range(1, TURNS + 1):
        r = h.turn()
        assert r.status_code == HTTPStatus.OK, r.text
        assert r.json()["turn_no"] == n
        assert r.json()["last_seq"] == len(h.db.events)
    snap = h.get(f"/api/trials/{h.trial}/snapshot").json()
    assert snap["exchanges_used"] == TURNS
    assert len(snap["cards"]) == TURNS
    assert len(snap["updates"]) == 1
    ev = h.post(f"/api/trials/{h.trial}/evidence-requests", {"record_ids": ["rec-01"], "idem_key": str(uuid4())})
    assert ev.json()["released"][0]["record_id"] == "rec-01"
    done = h.post(f"/api/trials/{h.trial}/finding", {"finding": FINDING, "idem_key": str(uuid4())})
    assert done.status_code == HTTPStatus.OK
    assert done.json()["status"] == "completed"
    assert done.json()["commitment_hash"] == "c" * 64


def test_a_601_character_question_is_422_before_anything_is_written() -> None:
    h = Harness()
    h.start()
    assert h.turn("x" * 601).status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert "submit_question" not in h.db.calls


def test_a_stale_turn_is_409_and_an_unknown_trial_404() -> None:
    h = Harness()
    h.start()
    h.turn()
    stale = h.turn(version=0)
    assert (stale.status_code, stale.json()["code"]) == (409, "stale_version")
    other = h.post(
        f"/api/trials/{uuid4()}/turns",
        {"question": "Q?", "release_ids": [], "expected_version": 0, "idem_key": str(uuid4())},
    )
    assert other.status_code == HTTPStatus.NOT_FOUND
    for path in ("snapshot", "recording"):
        assert h.get(f"/api/trials/{uuid4()}/{path}").status_code == HTTPStatus.NOT_FOUND


def test_subject_unavailable_is_503() -> None:
    h = Harness()
    h.start()
    h.subject_error = SubjectUnavailableError("provider_failed")
    assert h.turn().status_code == HTTPStatus.SERVICE_UNAVAILABLE


def test_evidence_and_finding_refusals() -> None:
    h = Harness()
    h.start()
    h.turn()
    unknown = h.post(f"/api/trials/{h.trial}/evidence-requests", {"record_ids": ["rec-05"], "idem_key": str(uuid4())})
    assert unknown.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    extra = h.post(f"/api/trials/{h.trial}/finding", {"finding": {**FINDING, "verdict": "x"}, "idem_key": str(uuid4())})
    long = h.post(
        f"/api/trials/{h.trial}/finding", {"finding": {**FINDING, "rationale": "x" * 601}, "idem_key": str(uuid4())}
    )
    half = h.post(
        f"/api/trials/{h.trial}/finding", {"finding": {**FINDING, "cited_turns": [1.5]}, "idem_key": str(uuid4())}
    )
    absent = h.post(
        f"/api/trials/{h.trial}/finding",
        {"finding": {**FINDING, "cited_records": ["doc-04"]}, "idem_key": str(uuid4())},
    )
    assert [r.status_code for r in (extra, long, half, absent)] == [422, 422, 422, 422]
    assert h.db.finding is None
    for path in ("evidence-requests", "finding"):
        assert h.post(
            f"/api/trials/{uuid4()}/{path}", {"record_ids": ["rec-01"], "finding": FINDING, "idem_key": str(uuid4())}
        ).status_code in (404, 422)


# ------------------------------------------------------------------ stream (S5 6.3, 6.4)


def _sse(h: Harness, after: int = 0) -> list[dict[str, Any]]:
    ticket = h.post(f"/api/trials/{h.trial}/stream-tickets").json()["ticket"]
    body = h.get(f"/api/trials/{h.trial}/events", params={"ticket": ticket, "after": after}).text
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]


def test_the_stream_replays_after_the_cursor_and_pings() -> None:
    h = Harness()
    h.start()
    h.turn()
    h.turn()
    frames = _sse(h)
    assert [f["type"] for f in frames] == ["question.accepted", "subject.answer", "coach.card"] * 2
    assert [f["seq"] for f in _sse(h, after=3)] == [4, 5, 6]


def test_a_ticket_is_single_use_and_bound_to_its_trial() -> None:
    h = Harness()
    h.start()
    ticket = h.post(f"/api/trials/{h.trial}/stream-tickets").json()["ticket"]
    wrong = h.get(f"/api/trials/{uuid4()}/events", params={"ticket": ticket})
    assert wrong.status_code == HTTPStatus.UNAUTHORIZED
    assert h.get(f"/api/trials/{h.trial}/events", params={"ticket": ticket}).status_code == HTTPStatus.UNAUTHORIZED
    assert h.post(f"/api/trials/{uuid4()}/stream-tickets").status_code == HTTPStatus.NOT_FOUND


def test_after_the_debrief_the_ticket_route_answers_stream_closed() -> None:
    h = Harness()
    started = h.start()
    h.turn()
    h.post(f"/api/trials/{h.trial}/finding", {"finding": FINDING, "idem_key": str(uuid4())})
    assert h.get(f"/api/sessions/{started['session_id']}/debrief").json() == {"status": "scoring"}
    published = h.post(f"/api/sessions/{started['session_id']}/debrief")
    assert published.json()["schema_version"] == "debrief.v1"
    assert h.get(f"/api/sessions/{started['session_id']}/debrief").json()["schema_version"] == "debrief.v1"
    closed = h.post(f"/api/trials/{h.trial}/stream-tickets")
    assert (closed.status_code, closed.json()) == (409, {"code": "stream_closed"})


@pytest.mark.parametrize(("status", "expected"), [(409, 409), (500, 502)])
def test_debrief_referee_errors(status: int, expected: int) -> None:
    h = Harness()
    started = h.start()
    h.referee_error = RefereeError(status, "nope")
    assert h.post(f"/api/sessions/{started['session_id']}/debrief").status_code == expected
    assert h.post(f"/api/sessions/{uuid4()}/debrief").status_code == HTTPStatus.NOT_FOUND


def test_assessment_stream_withholds_cards_until_the_end() -> None:
    h = Harness(mode="assessment")
    h.start(mode="assessment")
    h.turn()
    assert "coach.card" not in {f["type"] for f in _sse(h)}


# ------------------------------------------------------------------ recording, telemetry


def test_recording_route_returns_the_player_format() -> None:
    h = Harness()
    h.start()
    h.turn()
    rec = h.get(f"/api/trials/{h.trial}/recording").json()
    assert rec["format"] == "arena.recording.v1"
    assert rec["debrief"] is None
    assert [e["frame"]["type"] for e in rec["events"]][:2] == ["question.accepted", "subject.thinking"]


def test_kpi4_ack_and_contract_violation() -> None:
    h = Harness()
    h.start()
    ack = h.post("/api/telemetry/kpi4", {"trial_id": h.trial, "turn_no": 1, "client_valid": True})
    assert ack.json() == {"recorded": True}
    bad = h.post("/api/telemetry/kpi4", {"trial_id": h.trial, "turn_no": 1, "client_valid": True, "at": 1})
    assert bad.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    h.db.fail_next["ack_card"] = ArenaError("AR040", "no")
    assert (
        h.post("/api/telemetry/kpi4", {"trial_id": h.trial, "turn_no": 1, "client_valid": True}).status_code
        == HTTPStatus.NOT_FOUND
    )
    assert h.post("/api/telemetry/contract-violation", {"frame": "x"}).status_code == HTTPStatus.NO_CONTENT


def test_an_open_stream_hears_the_kill_switch() -> None:
    h = Harness()
    h.start()
    h.turn()
    ticket = h.post(f"/api/trials/{h.trial}/stream-tickets").json()["ticket"]
    h.db.paused = True  # turned on after the middleware's last read (it caches for 5 s)
    body = h.get(f"/api/trials/{h.trial}/events", params={"ticket": ticket}).text
    frames = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
    assert frames[-1]["type"] == "notice"
    assert frames[-1]["data"]["kind"] == "paused"


# ------------------------------------------------------------------ leaderboards (S5 5.5, S6 4.10)

WP16_BOARDS = json.loads((REPO / "web" / "src" / "fixtures" / "leaderboard.wp16.json").read_text(encoding="utf-8"))


def _published(h: Harness, status: str = "revealed") -> UUID:
    tournament = uuid4()
    h.db.tournaments[tournament] = status
    for board in ("assistant", "subject"):
        body = WP16_BOARDS[board]
        h.db.boards.append(
            {"tournament": tournament, "board": board, "label": "original", "manifest_version": 1, "body": body}
        )
    return tournament


def test_a_revealed_board_is_passed_through_unchanged() -> None:
    h = Harness()
    tournament = _published(h)
    for board in ("assistant", "subject"):
        r = h.get(f"/api/leaderboards/{tournament}", params={"board": board})
        assert r.status_code == HTTPStatus.OK
        assert r.json() == WP16_BOARDS[board]
        assert r.headers["x-arena-board-label"] == "original"


def test_the_corrected_board_supersedes_the_original_which_stays_readable() -> None:
    h = Harness()
    tournament = _published(h)
    original_binding = WP16_BOARDS["assistant"]["binding"]
    corrected = {**WP16_BOARDS["assistant"], "binding": {**original_binding, "manifest_version": 2}}
    h.db.boards.append(
        {"tournament": tournament, "board": "assistant", "label": "corrected", "manifest_version": 2, "body": corrected}
    )
    latest = h.get(f"/api/leaderboards/{tournament}", params={"board": "assistant"})
    assert latest.json() == corrected
    assert latest.headers["x-arena-manifest-version"] == "2"
    original = h.get(f"/api/leaderboards/{tournament}", params={"board": "assistant", "label": "original"})
    assert original.json() == WP16_BOARDS["assistant"]


def test_no_board_before_reveal_and_unknown_or_unpublished_is_404() -> None:
    h = Harness()
    sealed = _published(h, status="sealed")
    early = h.get(f"/api/leaderboards/{sealed}", params={"board": "assistant"})
    assert early.status_code == HTTPStatus.CONFLICT
    assert early.json() == {"code": "not_revealed", "status": "sealed"}
    assert h.get(f"/api/leaderboards/{uuid4()}", params={"board": "assistant"}).status_code == HTTPStatus.NOT_FOUND
    empty = uuid4()
    h.db.tournaments[empty] = "revealed"
    assert h.get(f"/api/leaderboards/{empty}", params={"board": "subject"}).status_code == HTTPStatus.NOT_FOUND
    tournament = _published(h)
    bad = h.get(f"/api/leaderboards/{tournament}", params={"board": "investigator"})
    assert bad.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ------------------------------------------------------------------ progress (S5 5.5, S6 4.8, S3 6.1)


POST_SCORE = 6
FULL_POST_MEAN = 65.0


def _debrief(total: int | None, *, scored: bool = True) -> dict[str, Any]:
    return {"scored": scored, "rubric": {"scorable": total is not None, "total": total}}


def _test_session(h: Harness, phase: str, total: int | None) -> UUID:
    session = uuid4()
    h.db.more_sessions.append(
        {
            "session_id": session,
            "trial_id": uuid4(),
            "phase": phase,
            "voice": False,
            "created_at": datetime(2026, 10, 12, tzinfo=UTC),
            "mode": "assessment",
            "status": "finalized",
            "exchanges": 3,
            "variant_id": uuid4(),
        }
    )
    if total is not None:
        h.db.debriefs[session] = _debrief(total)
    return session


def _study(h: Harness, pre_ended: int = 2, post_ended: int = 2) -> None:
    h.db.study_row = {
        "code": "P1",
        "counterbalance": "AB",
        "pre_ended": pre_ended,
        "practice_ended": 3,
        "post_ended": post_ended,
        "pre": [uuid4(), uuid4()],
        "post": [uuid4(), uuid4()],
        "tested": [],
    }


def test_progress_lists_the_sessions_and_no_kpi1_before_the_protocol_is_complete() -> None:
    h = Harness()
    _test_session(h, "pre", 8)
    body = h.get("/api/progress").json()
    assert [s["phase"] for s in body["sessions"]] == ["practice", "pre"]
    assert body["sessions"][0]["case_title"] == PACKET["title"]
    assert body["sessions"][1]["case_title"] is None
    assert body["kpi1"] is None


def test_kpi1_waits_for_both_post_tests_and_every_debrief() -> None:
    h = Harness()
    _study(h, post_ended=1)
    for phase, total in (("pre", 30), ("pre", 50), ("post", 60)):
        _test_session(h, phase, total)
    assert h.get("/api/progress").json()["kpi1"] is None  # one post-test still to come
    _study(h)
    pending = _test_session(h, "post", None)  # ended, its debrief not yet published
    assert h.get("/api/progress").json()["kpi1"] is None
    h.db.debriefs[pending] = _debrief(70)
    assert h.get("/api/progress").json()["kpi1"]["post"] == FULL_POST_MEAN


def test_progress_kpi1_is_the_per_participant_pair_of_means() -> None:
    h = Harness()
    _study(h)
    _test_session(h, "pre", 8)
    _test_session(h, "pre", 10)
    unscorable = _test_session(h, "post", None)
    h.db.debriefs[unscorable] = _debrief(None)  # published but unscorable: left out of the mean
    _test_session(h, "post", 12)
    _test_session(h, "post", 15)
    kpi1 = h.get("/api/progress").json()["kpi1"]
    assert kpi1 == {"pre": 9.0, "post": 13.5, "absolute_change": 4.5, "relative_change": 0.5}


def test_progress_relative_change_is_null_at_a_zero_baseline() -> None:
    h = Harness()
    _study(h)
    _test_session(h, "pre", 0)
    _test_session(h, "pre", 0)
    _test_session(h, "post", POST_SCORE)
    _test_session(h, "post", POST_SCORE)
    kpi1 = h.get("/api/progress").json()["kpi1"]
    assert kpi1["absolute_change"] == POST_SCORE
    assert kpi1["relative_change"] is None


def test_an_unscored_voice_debrief_has_no_score() -> None:
    h = Harness()
    _study(h)
    for phase in ("pre", "pre"):
        voice = _test_session(h, phase, None)
        h.db.debriefs[voice] = _debrief(None, scored=False)
    _test_session(h, "post", POST_SCORE)
    _test_session(h, "post", POST_SCORE)
    assert h.get("/api/progress").json()["kpi1"] is None  # no scorable pre-test: attrition


def test_a_session_does_not_start_before_the_ex4_acknowledgement() -> None:
    h = Harness()
    h.db.acks.clear()
    body = {"case_id": PACKET["case_id"], "mode": "practice", "voice": False, "idem_key": str(uuid4())}
    refused = h.post("/api/sessions", body)
    assert refused.status_code == HTTPStatus.FORBIDDEN
    assert refused.json() == {"code": "ex4_required"}
    assert "start_session" not in h.db.calls
    assert h.post("/api/me/ack-ex4").status_code == HTTPStatus.OK
    assert h.post("/api/sessions", body).status_code == HTTPStatus.OK


# ------------------------------------------------------------------ trust center (S5 5.5, S6 4.11)


def test_each_trust_section_reads_published_data_only() -> None:
    h = Harness()
    checks = h.get("/api/trust/isolation").json()["checks"]
    assert checks[0]["check"] == "hidden_text_scan"
    assert "evidence" not in checks[0]
    assert h.get("/api/trust/commitments").json() == {"commitments": []}
    fairness = h.get("/api/trust/fairness").json()
    assert fairness["published"] is False
    assert fairness["style_fpr"] == []
    assert h.get("/api/trust/methodology").json() == {"calibration": []}
    budget = h.get("/api/trust/budget").json()
    assert budget["ceiling_usd"] == "0.000000"  # plan not applied: the page says so (FE-TRUST-4)
    assert budget["planned_n"] == PLANNED_N
    assert h.get("/api/trust/other").status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert h.get("/api/config").json()["planned_n"] == PLANNED_N
