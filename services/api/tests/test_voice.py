"""The voice ticket route and the relay WebSocket (S5 7.2, 7.3, 7.8 ticket and protocol items; G4 suite pattern).

arena-api runs in process over the in-memory S4 (`fakedb`); arena-subject's leg is an in-memory double that
records what the relay forwards and closes with whatever code a test gives it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.typing import Subprotocol

from arena_api.app import create_app
from arena_api.state import ApiState
from arena_api.voice_relay import SubjectLeg
from arena_core.db.arena import ArenaDb, ArenaError, SessionStart
from arena_core.db.pool import Connector
from arena_core.http_guard import GuardConfig
from arena_core.identity import DevIdentity, user_id_for
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from arena_core.turns.orchestrator import SubjectOutcome
from arena_core.voice import protocol as p
from packages.core.tests.turns.fakedb import PACKET, FakeArenaDb

EMAIL = "v@example.test"
WHO = DevIdentity(user_id=user_id_for(EMAIL), email=EMAIL, display_name="V", roles=frozenset({"investigator"}))
ORIGIN = "http://127.0.0.1:8080"
HTTP_OK = 200


class VoiceDb(FakeArenaDb):
    """The fake S4 with voice tickets: single use, bound to the trial (a hidden or refused trial raises AR040)."""

    def __init__(self, actor: UUID) -> None:
        super().__init__(actor)
        self.voice_ticket: str | None = None
        self.redeemed: list[str] = []
        self.refuse_mint = False
        self.starts: list[SessionStart] = []
        self.voice = True
        self.stored: list[dict[str, Any]] = []

    async def trial(self, trial: UUID) -> dict[str, Any] | None:
        row = await super().trial(trial)
        return None if row is None else {**row, "voice": self.voice}

    async def voice_exchanges(self, trial: UUID) -> list[dict[str, Any]]:
        assert trial == self.trial_id
        return self.stored

    async def start_session(self, start: SessionStart) -> dict[str, Any]:
        self.starts.append(start)
        return await super().start_session(start)

    async def issue_ticket(self, kind: str, trial: UUID) -> str:
        if kind != "voice":
            return await super().issue_ticket(kind, trial)
        if self.refuse_mint or trial != self.trial_id:
            raise ArenaError("AR040", "ticket refused")
        self.voice_ticket = secrets.token_hex(32)
        return self.voice_ticket

    async def redeem_ticket(self, token: str, kind: str) -> dict[str, Any]:
        if kind != "voice":
            return await super().redeem_ticket(kind, token)
        self.redeemed.append(token)
        if token != self.voice_ticket:
            raise ArenaError("AR040", "ticket refused")
        self.voice_ticket = None
        return {
            "ticket_id": str(uuid4()),
            "user_id": str(self.actor),
            "trial_id": str(self.trial_id),
            "mode": "practice",
            "split": "dev",
        }


@dataclass
class Leg:
    """arena-subject's side: records what arrives; `reply` frames go to the browser, then it closes with `code`."""

    got: list[bytes | str] = field(default_factory=list)
    reply: list[bytes | str] = field(default_factory=list)
    code: int = p.NORMAL
    close_after: int = 1  # close once this many frames arrived
    closed_by_api: int | None = None
    _arrived: asyncio.Event = field(default_factory=asyncio.Event)

    async def send(self, data: bytes | str) -> None:
        self.got.append(data)
        if len(self.got) >= self.close_after:
            self._arrived.set()

    async def frames(self) -> AsyncIterator[bytes | str]:
        await self._arrived.wait()
        for item in self.reply:
            yield item

    async def close(self, code: int) -> None:
        self.closed_by_api = code
        self._arrived.set()

    @property
    def close_code(self) -> int | None:
        return self.code


class Harness:
    """arena-api served by uvicorn on a free loopback port, in this test's event loop."""

    def __init__(self, leg: Leg | None = None) -> None:
        self.db = VoiceDb(WHO.user_id)
        self.db.acks["ex4"] = datetime(2026, 10, 11, tzinfo=UTC)
        self.leg = leg or Leg()
        self.dialed = 0

        def make_db(_c: Connector, _actor: UUID) -> ArenaDb:
            return self.db

        async def subject(_t: UUID, _w: UUID, _a: UUID | None) -> SubjectOutcome:
            raise AssertionError

        async def debrief(_s: UUID) -> dict[str, Any]:
            raise AssertionError

        def dial() -> AbstractAsyncContextManager[SubjectLeg]:
            @asynccontextmanager
            async def _open() -> AsyncIterator[SubjectLeg]:
                self.dialed += 1
                yield self.leg

            return _open()

        self.state = ApiState(
            connect=self.db._connect,
            identity=WHO,
            port=AgentPort(FakeAdapter(canned={}), RunBudget(Decimal(1)), PortOptions()),
            subject=subject,
            debrief=debrief,
            make_db=make_db,
            voice_dialer=dial,
        )
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.port = int(self.sock.getsockname()[1])
        self.origin = f"http://127.0.0.1:{self.port}"
        hosts = frozenset({f"127.0.0.1:{self.port}"})
        self.app = create_app(self.state, GuardConfig(allowed_hosts=hosts, allowed_origins=frozenset({self.origin})))
        self.http = httpx.AsyncClient(base_url=self.origin)

    async def mint(self) -> str:
        r = await self.post("/api/voice/tickets", {"trial_id": str(self.db.trial_id)})
        assert r.status_code == HTTP_OK, r.text
        ticket: str = r.json()["ticket"]
        return ticket

    async def post(self, path: str, body: object) -> httpx.Response:
        me = await self.http.get("/api/me")
        token = me.json()["csrf_token"]
        self.http.cookies.set("arena_csrf", token)
        return await self.http.post(path, json=body, headers={"Origin": self.origin, "X-Arena-CSRF": token})

    def connect(self, ticket: str, *, origin: str | None = None, host: str = "127.0.0.1") -> connect:
        """A WebSocket to the relay; `host` names the URL's host (the Host header), the socket is always loopback."""
        return connect(
            f"ws://{host}:{self.port}/api/voice/ws",
            subprotocols=[Subprotocol(ticket)],
            additional_headers={"Origin": origin or self.origin},
            host="127.0.0.1",
            port=self.port,
        )


def serve(test: Callable[[Harness], Awaitable[None]], leg: Leg | None = None) -> Harness:
    h = Harness(leg)

    async def go() -> None:
        server = uvicorn.Server(uvicorn.Config(h.app, log_level="warning", lifespan="off"))
        task = asyncio.create_task(server.serve(sockets=[h.sock]))
        for _ in range(500):
            if server.started:
                break
            await asyncio.sleep(0.01)
        try:
            await test(h)
        finally:
            await h.http.aclose()
            server.should_exit = True
            await task

    asyncio.run(go())
    return h


async def closed_with(ws: ClientConnection) -> int:
    with contextlib.suppress(ConnectionClosed):
        while True:
            await ws.recv()
    code = ws.close_code
    assert code is not None
    return code


def test_a_ticket_relays_start_audio_and_subject_frames_and_the_subject_close_code() -> None:
    leg = Leg(
        reply=[p.frame("utterance_start", utterance=1), b"\x00\x01" * 10, p.frame("ended"), b"\x00" * 9602],
        code=p.EXCHANGE_CAP_REACHED,
        close_after=2,
    )

    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            assert ws.subprotocol == ticket
            await ws.send(b"\x01\x00" * 1600)
            assert json.loads(await ws.recv()) == {"type": "utterance_start", "utterance": 1}
            assert await ws.recv() == b"\x00\x01" * 10
            # the unknown `ended` frame and the oversize audio were dropped; the close code is the terminal signal
            assert await closed_with(ws) == p.EXCHANGE_CAP_REACHED

    h = serve(test, leg)
    start = json.loads(str(leg.got[0]))
    assert start["type"] == "start"
    assert start["trial_id"] == str(h.db.trial_id)
    assert start["user_id"] == str(WHO.user_id)
    assert leg.got[1] == b"\x01\x00" * 1600


def test_a_replayed_ticket_closes_4401() -> None:
    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            await ws.send(json.dumps({"type": "stop"}))
            await closed_with(ws)
        async with h.connect(ticket) as ws:
            assert await closed_with(ws) == p.REFUSED

    assert serve(test).dialed == 1


def test_a_foreign_origin_closes_4403_and_leaves_the_ticket_unconsumed() -> None:
    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket, origin="http://evil.example") as ws:
            assert await closed_with(ws) == p.ORIGIN
        assert h.db.redeemed == []
        assert h.db.voice_ticket == ticket

    serve(test)


def test_a_foreign_host_is_refused_before_the_upgrade() -> None:
    async def test(h: Harness) -> None:
        ticket = await h.mint()
        with pytest.raises(InvalidStatus):
            async with h.connect(ticket, host="evil.example"):
                pass
        assert h.db.redeemed == []

    serve(test)


def test_a_ticket_in_the_wrong_shape_closes_4401_without_redeeming() -> None:
    async def test(h: Harness) -> None:
        async with h.connect("not-a-ticket") as ws:
            assert await closed_with(ws) == p.REFUSED
        assert h.db.redeemed == []

    serve(test)


def test_a_refused_mint_answers_the_refusal() -> None:
    async def test(h: Harness) -> None:
        h.db.refuse_mint = True
        r = await h.post("/api/voice/tickets", {"trial_id": str(h.db.trial_id)})
        assert r.status_code != HTTP_OK
        assert "ticket" not in r.json()

    serve(test)


@pytest.mark.parametrize(
    "bad",
    [
        "x" * 513,
        json.dumps({"type": "played", "utterance": 1}),
        json.dumps({"type": "context_changed"}),
        json.dumps({"type": "start"}),
        json.dumps({"type": "unknown"}),
        b"\x00" * 3201,
    ],
)
def test_a_bad_browser_frame_closes_4400_and_nothing_of_it_is_forwarded(bad: str | bytes) -> None:
    leg = Leg(close_after=10**6)

    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            await ws.send(bad)
            assert await closed_with(ws) == p.PROTOCOL

    serve(test, leg)
    assert len(leg.got) == 1  # only `start`
    assert leg.closed_by_api == p.PROTOCOL


def test_stop_and_interrupt_are_forwarded_as_closed_frames() -> None:
    leg = Leg(close_after=3)

    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            await ws.send(json.dumps({"type": "interrupt"}))
            await ws.send(json.dumps({"type": "stop"}))
            assert await closed_with(ws) == p.NORMAL

    serve(test, leg)
    assert [json.loads(str(x))["type"] for x in leg.got[1:]] == ["interrupt", "stop"]


def test_an_evidence_request_that_released_a_record_sends_context_changed_to_the_open_relay() -> None:
    leg = Leg(close_after=3)

    async def test(h: Harness) -> None:
        h.db.exchanges = 3  # rec-01 is requestable after three exchanges
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            await ws.send(b"\x00\x00" * 10)
            r = await h.post(
                f"/api/trials/{h.db.trial_id}/evidence-requests", {"record_ids": ["rec-01"], "idem_key": str(uuid4())}
            )
            assert r.json()["released"][0]["record_id"] == "rec-01"
            assert await closed_with(ws) == p.NORMAL

    serve(test, leg)
    assert json.loads(str(leg.got[-1])) == {"type": "context_changed"}


def test_a_voice_session_starts_with_the_voice_flag_and_config_offers_voice() -> None:
    async def test(h: Harness) -> None:
        r = await h.post(
            "/api/sessions", {"case_id": PACKET["case_id"], "mode": "practice", "voice": True, "idem_key": str(uuid4())}
        )
        assert r.status_code == HTTP_OK, r.text
        config = (await h.http.get("/api/config")).json()
        assert config["voice_available"] is True

    h = serve(test)
    assert [s.voice for s in h.db.starts] == [True]


def test_the_snapshot_of_a_voice_session_is_the_voice_branch_with_the_stored_windows() -> None:
    lines = [
        {"role": "investigator", "text": "Where?", "partial": False},
        {"role": "subject", "text": "Here.", "partial": True},
    ]

    async def test(h: Harness) -> None:
        h.db.stored = [{"exchange_no": n, "lines": lines} for n in (1, 2, 3)]
        snap = (await h.http.get(f"/api/trials/{h.db.trial_id}/snapshot")).json()
        assert snap["channel"] == "voice"
        assert snap["exchanges_used"] == len(h.db.stored)
        assert snap["voice_exchanges"] == h.db.stored
        assert snap["turns"] == []
        h.db.voice = False
        text = (await h.http.get(f"/api/trials/{h.db.trial_id}/snapshot")).json()
        assert text["channel"] == "text"
        assert text["voice_exchanges"] == []

    serve(test)


def test_audio_faster_than_fifteen_frames_a_second_closes_4400_at_the_edge() -> None:
    leg = Leg(close_after=10**6)

    async def test(h: Harness) -> None:
        ticket = await h.mint()
        async with h.connect(ticket) as ws:
            for _ in range(p.AUDIO_RATE_MAX_FRAMES + 1):
                await ws.send(b"\x00\x00" * 1600)
            assert await closed_with(ws) == p.PROTOCOL

    serve(test, leg)
    assert leg.closed_by_api == p.PROTOCOL
    assert len(leg.got) == 1 + p.AUDIO_RATE_MAX_FRAMES  # start and the frames the window allows
