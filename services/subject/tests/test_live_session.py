"""The voice session against a scripted Live backend (S5 7.4, 7.5, 7.8; S2 9.4, AT-VOICE-3, AT-VOICE-5).

The real F01 deceptive dev packet and the committed S1 manifest drive the instruction builder; the relay, the
database store and Live are doubles. Nothing here touches a network or a database.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Any, TypedDict, Unpack
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import ManifestMismatchError, committed_manifest
from arena_core.db.calls import SettleOutcome, UsageReport, UsageResult
from arena_core.db.voice import OpenedVoice, VoiceOpenRefusedError
from arena_core.voice import protocol as p
from arena_core.voice.live import (
    FakeLive,
    FakeLiveConnection,
    LiveAudio,
    LiveInterrupted,
    LiveTranscript,
    LiveTurnComplete,
    LiveUsage,
)
from arena_subject import live_session
from arena_subject.live_session import RelayClosedError, VoiceSession

REPO = Path(__file__).resolve().parents[3]
START = p.Start(uuid4(), uuid4(), uuid4(), "practice")
VS, RES = uuid4(), uuid4()
GATE_LOCKED = "g:01 condition"
POLL_S = 0.005
AUDIO_OUT_TOKENS = 40
TWO = 2
FRAMES_PER_S = 10
PER_S = 25


def gate_line(instruction: str) -> str:
    return next(line for line in instruction.splitlines() if line.startswith(GATE_LOCKED))


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


@cache
def _variant() -> dict[str, Any]:
    raw: dict[str, Any] = json.loads((REPO / "cases" / "dev" / "F01.json").read_text(encoding="utf-8"))
    return dict(raw["variants"]["deceptive"])


def context(released: list[str] | None = None, exchanges: int = 0) -> dict[str, Any]:
    v = _variant()
    return {
        "private_packet": v["private_packet"],
        "public_packet": v["public_packet"],
        "subject_manifest": committed_manifest("S1").model_dump(mode="json"),
        "released_evidence": [{"record_id": r} for r in released or []],
        "voice_exchanges": [
            {
                "exchange_no": i + 1,
                "lines": [
                    {"role": "investigator", "text": f"Earlier question {i + 1}?", "partial": False},
                    {"role": "subject", "text": f"Earlier answer {i + 1}.", "partial": False},
                ],
            }
            for i in range(exchanges)
        ],
        "kill_switch": False,
        "spend_usd": 0,
        "shutoff_usd": 2.26,
    }


@dataclass
class Store:
    released: list[str] = field(default_factory=list)
    exchanges: int = 0
    release_on_store: dict[int, list[str]] = field(default_factory=dict)
    store_delay: float = 0.0
    shutoff_after: int | None = None
    refuse: int | None = None
    kill: bool = False
    fail_usage: bool = False
    log: list[tuple[str, Any]] = field(default_factory=list)
    stored: list[tuple[int, list[dict[str, Any]]]] = field(default_factory=list)
    usage: list[UsageReport] = field(default_factory=list)

    async def open(self, start: p.Start) -> OpenedVoice:
        self.log.append(("open", start))
        if self.refuse is not None:
            raise VoiceOpenRefusedError(self.refuse, "refused")
        return OpenedVoice(VS, RES)

    async def dispatch(self, reservation_id: UUID) -> bool:
        self.log.append(("dispatch", reservation_id))
        return not self.kill

    async def context(self, voice_session: UUID) -> dict[str, Any]:
        del voice_session
        return context(self.released, self.exchanges + len(self.stored))

    async def record_exchange(self, voice_session: UUID, exchange_no: int, lines: list[dict[str, Any]]) -> list[str]:
        del voice_session
        await asyncio.sleep(self.store_delay)
        assert exchange_no == self.exchanges + len(self.stored) + 1
        self.stored.append((exchange_no, lines))
        self.log.append(("exchange", exchange_no))
        new = self.release_on_store.get(exchange_no, [])
        self.released.extend(new)
        return new

    async def record_usage(self, report: UsageReport) -> UsageResult:
        if self.fail_usage:
            msg = "database unavailable"
            raise ConnectionError(msg)
        self.usage.append(report)
        shutoff = self.shutoff_after is not None and len(self.usage) >= self.shutoff_after
        return UsageResult("recorded", Decimal("0.01"), Decimal("0.01"), Decimal("3.39"), shutoff)

    async def close(self, voice_session: UUID, close_code: str) -> None:
        del voice_session
        self.log.append(("close", close_code))

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> None:
        del reservation_id
        self.log.append(("settle", outcome))


@dataclass
class Relay:
    """The arena-api leg: a queue of inbound frames; outbound frames and the close code are recorded."""

    inbound: asyncio.Queue[bytes | str | int] = field(default_factory=asyncio.Queue)
    sent: list[bytes | str] = field(default_factory=list)
    closed: int | None = None
    on_close: Callable[[], None] | None = None

    async def receive(self) -> bytes | str:
        item = await self.inbound.get()
        if isinstance(item, int):
            raise RelayClosedError(item)
        return item

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int) -> None:
        self.closed = code
        if self.on_close is not None:
            self.on_close()

    def frames(self, kind: str | None = None) -> list[dict[str, Any]]:
        out = [json.loads(s) for s in self.sent if isinstance(s, str)]
        return [f for f in out if kind is None or f["type"] == kind]


SPEECH = b"\x10\x27" * 1600  # 100 ms of loud PCM16 at 16 kHz


class Opts(TypedDict, total=False):
    clock: Callable[[], float]
    sleep: Callable[[float], Awaitable[None]]
    idle_s: float
    audio_cap_s: float


def session(
    store: Store, conn: FakeLiveConnection | None = None, **kw: Unpack[Opts]
) -> tuple[VoiceSession, Relay, FakeLive]:
    relay = Relay()
    relay.inbound.put_nowait(p.start_frame(START))
    live = FakeLive(next_connection=conn or FakeLiveConnection(auto=False))
    return VoiceSession(relay, store, live, **kw), relay, live


async def until(predicate: Callable[[], bool], limit_s: float = 2.0) -> None:
    for _ in range(int(limit_s / POLL_S)):
        if predicate():
            return
        await asyncio.sleep(POLL_S)
    raise TimeoutError


def exchange(conn: FakeLiveConnection, question: str, answer: str) -> None:
    conn.push(LiveTranscript("investigator", question, finished=True))
    conn.push(LiveAudio(b"\x00\x01" * 6000))
    conn.push(LiveTranscript("subject", answer, finished=True))
    conn.push(LiveTurnComplete())
    conn.push(LiveUsage(text_in=100, audio_in=50, text_out=10, audio_out=AUDIO_OUT_TOKENS, thinking=5))


def test_one_exchange_is_stored_and_framed_then_stop_closes_1000_and_settles_after_close() -> None:
    async def go() -> tuple[Store, Relay, FakeLive]:
        store = Store()
        s, relay, live = session(store)
        task = asyncio.create_task(s.run())
        await until(lambda: bool(live.connections))
        conn = live.connections[0]
        exchange(conn, "Where were you at two?", "In the archive room.")
        await until(lambda: bool(store.usage))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))
        await task
        return store, relay, live

    store, relay, live = run(go())
    assert relay.closed == p.NORMAL
    assert store.stored == [
        (
            1,
            [
                {"role": "investigator", "text": "Where were you at two?", "partial": False},
                {"role": "subject", "text": "In the archive room.", "partial": False},
            ],
        )
    ]
    kinds = [f["type"] for f in relay.frames()]
    assert kinds[:2] == ["exchange_count", "transcription"]
    assert "utterance_start" in kinds
    assert "utterance_end" in kinds
    assert relay.frames("exchange") == [{"type": "exchange", "exchange_no": 1, "lines": store.stored[0][1]}]
    assert relay.frames("exchange_count")[-1] == {"type": "exchange_count", "used": 1, "cap": 12}
    assert any(isinstance(x, bytes) and len(x) <= p.MAX_AUDIO_OUT_BYTES for x in relay.sent)
    # The instruction renders the unreleased gate LOCKED; no update went to Live (nothing was released).
    instruction = live.setups[0]["system_instruction"]
    assert gate_line(instruction).endswith("status: LOCKED")
    assert live.connections[0].instructions == []
    assert store.usage[0].audio_output_tokens == AUDIO_OUT_TOKENS
    assert store.usage[0].status == "usage"
    assert store.log[-2:] == [("close", "1000"), ("settle", "committed")]


def test_transcription_order_late_fragment_lands_in_the_window_it_arrived_in() -> None:
    async def go() -> Store:
        store = Store()
        s, relay, live = session(store)
        task = asyncio.create_task(s.run())
        await until(lambda: bool(live.connections))
        conn = live.connections[0]
        conn.push(LiveTranscript("investigator", "Where were", finished=False))
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTranscript("subject", "I was in", finished=False))
        conn.push(LiveTranscript("subject", " the hall.", finished=True))
        conn.push(LiveTurnComplete())
        await until(lambda: len(store.stored) == 1)
        conn.push(LiveTranscript("investigator", " you at two?", finished=True))
        conn.push(LiveTranscript("investigator", " And after?", finished=True))
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTranscript("subject", "Lunch.", finished=True))
        conn.push(LiveTurnComplete())
        await until(lambda: len(store.stored) > 1)
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))
        await task
        return store

    store = run(go())
    assert store.stored[0][1] == [
        {"role": "investigator", "text": "Where were", "partial": False},
        {"role": "subject", "text": "I was in the hall.", "partial": False},
    ]
    assert store.stored[1][1] == [
        {"role": "investigator", "text": "you at two? And after?", "partial": False},
        {"role": "subject", "text": "Lunch.", "partial": False},
    ]


async def _drive(
    store: Store,
    script: Callable[[Relay, FakeLiveConnection], Coroutine[Any, Any, None]],
    conn: FakeLiveConnection | None = None,
    **kw: Unpack[Opts],
) -> tuple[Relay, FakeLive]:
    s, relay, live = session(store, conn, **kw)
    task = asyncio.create_task(s.run())
    await until(lambda: bool(live.connections) or task.done())
    if live.connections:
        await script(relay, live.connections[0])
    async with asyncio.timeout(3):
        await task
    return relay, live


@pytest.mark.parametrize(
    ("said", "rule"), [("I filed it as f:04 that day.", "G3"), ("Well, as an AI I would not.", "G4")]
)
def test_guard_hit_on_subject_speech_closes_4409_and_records_the_rule(said: str, rule: str) -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        del relay
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTranscript("subject", said, finished=False))

    relay, _ = run(_drive(store, script))
    assert relay.closed == p.SUBJECT_GUARD
    assert ("close", f"guard:{rule}") in store.log
    assert store.stored == []
    # Output arrived with no usage report: it is estimated from its bytes on one closing receipt.
    assert [u.audio_output_tokens > 0 for u in store.usage] == [True]
    assert store.log[-1] == ("settle", "committed")


def test_meter_shutoff_closes_4413_and_settles_only_after_the_close() -> None:
    store = Store(shutoff_after=1)
    order: list[str] = []

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        relay.on_close = lambda: order.append("relay_closed")
        exchange(conn, "Where?", "Here.")

    relay, _ = run(_drive(store, script))
    assert relay.closed == p.COST
    assert ("close", "4413") in store.log
    assert order == ["relay_closed"]
    assert store.log[-1] == ("settle", "committed")


def test_the_twelfth_exchange_sends_the_count_then_closes_4410_and_no_thirteenth_is_stored() -> None:
    store = Store(exchanges=11)

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        del relay
        exchange(conn, "Last question?", "Last answer.")
        conn.push(LiveTranscript("investigator", "One more?", finished=True))
        conn.push(LiveTurnComplete())

    relay, _ = run(_drive(store, script))
    assert relay.closed == p.EXCHANGE_CAP_REACHED
    assert [n for n, _ in store.stored] == [12]
    assert relay.frames("exchange_count")[-1] == {"type": "exchange_count", "used": 12, "cap": 12}
    assert relay.frames("utterance_end")


def test_a_trial_already_at_the_cap_closes_4410_before_live_opens() -> None:
    store = Store(exchanges=12)
    relay, live = run(_drive(store, lambda _r, _c: asyncio.sleep(0)))
    assert relay.closed == p.EXCHANGE_CAP_REACHED
    assert live.connections == []


@dataclass
class TracingConnection(FakeLiveConnection):
    trace: list[str] = field(default_factory=list)

    async def update_instruction(self, text: str) -> None:
        self.trace.append("update")
        await super().update_instruction(text)

    async def send_audio(self, pcm: bytes) -> None:
        self.trace.append("audio")
        await super().send_audio(pcm)


def test_scheduled_release_reaches_live_before_held_audio_even_with_a_slow_store() -> None:
    store = Store(release_on_store={1: ["rec-02"]}, store_delay=0.5)
    conn = TracingConnection(auto=False)

    async def script(relay: Relay, c: FakeLiveConnection) -> None:
        exchange(c, "Where?", "Here.")
        await asyncio.sleep(0.05)
        relay.inbound.put_nowait(SPEECH)  # question k+1 starts while k is being stored
        await until(lambda: "audio" in conn.trace)
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    run(_drive(store, script, conn=conn))
    assert conn.trace == ["update", "audio"]
    assert gate_line(conn.instructions[0]).endswith("status: CLOSED")


def test_context_changed_updates_at_once_when_no_exchange_is_open_and_after_the_store_otherwise() -> None:
    store = Store()
    conn = FakeLiveConnection(auto=False)

    async def script(relay: Relay, c: FakeLiveConnection) -> None:
        store.released.append("rec-01")
        relay.inbound.put_nowait(p.CONTEXT_CHANGED)
        await until(lambda: len(c.instructions) == 1)
        c.push(LiveTranscript("investigator", "And then?", finished=True))
        await until(lambda: any(f["type"] == "transcription" for f in relay.frames()))
        relay.inbound.put_nowait(p.CONTEXT_CHANGED)
        await asyncio.sleep(0.05)
        assert len(c.instructions) == 1  # an exchange is open: the update waits for its store
        exchange(c, "", "Then I left.")
        await until(lambda: len(c.instructions) > 1)
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    run(_drive(store, script, conn=conn))
    assert len(conn.instructions) == TWO
    assert store.stored[0][0] == 1


@pytest.mark.parametrize(
    "bad",
    [
        json.dumps({"type": "played", "utterance": 1}),
        json.dumps({"type": "start"}),
        "x" * 513,
        b"\x00" * 3201,
        b"\x00",
    ],
)
def test_a_bad_relay_frame_closes_4400(bad: str | bytes) -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        del conn
        relay.inbound.put_nowait(bad)

    relay, live = run(_drive(store, script))
    assert relay.closed == p.PROTOCOL
    assert live.connections[0].audio_in == []
    assert ("close", "4400") in store.log
    assert store.log[-1] == ("settle", "committed")


def test_audio_held_past_five_seconds_closes_4400() -> None:
    store = Store(store_delay=1.0)

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        exchange(conn, "Where?", "Here.")
        await asyncio.sleep(0.05)
        for _ in range(51):
            relay.inbound.put_nowait(b"\x00\x01" * 1600)

    relay, _ = run(_drive(store, script, clock=_ticker()))
    assert relay.closed == p.PROTOCOL


def _ticker() -> Callable[[], float]:
    """A clock that advances 100 ms per read, so 51 frames stay under the rate limit."""
    now = [0.0]

    def clock() -> float:
        now[0] += 0.1
        return now[0]

    return clock


def test_the_first_frame_must_be_start() -> None:
    relay = Relay()
    relay.inbound.put_nowait(json.dumps({"type": "stop"}))
    store = Store()
    run(VoiceSession(relay, store, FakeLive()).run())
    assert relay.closed == p.PROTOCOL
    assert store.log == []


@pytest.mark.parametrize("code", [p.REFUSED, p.COST])
def test_a_refused_open_closes_with_its_code_and_settles_nothing(code: int) -> None:
    store = Store(refuse=code)
    relay, live = run(_drive(store, lambda _r, _c: asyncio.sleep(0)))
    assert relay.closed == code
    assert live.connections == []
    assert [k for k, _ in store.log] == ["open"]


def test_kill_switch_at_dispatch_closes_4423_and_releases_the_hold() -> None:
    store = Store(kill=True)
    relay, live = run(_drive(store, lambda _r, _c: asyncio.sleep(0)))
    assert relay.closed == p.KILL
    assert live.connections == []
    assert store.log[-2:] == [("close", "4423"), ("settle", "released")]


def test_a_transport_drop_mid_answer_closes_the_session_and_stores_nothing_partial() -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        conn.push(LiveTranscript("investigator", "Where?", finished=True))
        conn.push(LiveAudio(b"\x00\x01" * 100))
        await until(lambda: bool(relay.frames("utterance_start")))
        relay.inbound.put_nowait(p.TRANSPORT)

    _relay, _ = run(_drive(store, script))
    assert store.stored == []
    assert ("close", "1006") in store.log
    assert len(store.usage) == 1  # the cut-off answer, estimated
    assert store.log[-1] == ("settle", "committed")


def test_idle_closes_4408_and_the_audio_cap_closes_1000() -> None:
    async def nap(_s: float) -> None:
        await asyncio.sleep(0.001)

    now = [0.0]

    def clock() -> float:
        now[0] += 5
        return now[0]

    relay, _ = run(_drive(Store(), lambda _r, _c: asyncio.sleep(0), clock=clock, sleep=nap))
    assert relay.closed == p.IDLE
    relay, _ = run(_drive(Store(), lambda _r, _c: asyncio.sleep(0), clock=clock, sleep=nap, idle_s=1e9, audio_cap_s=30))
    assert relay.closed == p.NORMAL
    assert relay.frames("warning")[0]["reason"] == "ending_soon"


def test_interrupt_by_button_mutes_the_rest_of_the_utterance_and_marks_it_partial() -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        conn.push(LiveTranscript("investigator", "Where?", finished=True))
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTranscript("subject", "I was", finished=False))
        await until(lambda: bool(relay.frames("utterance_start")))
        relay.inbound.put_nowait(json.dumps({"type": "interrupt"}))
        await until(lambda: bool(relay.frames("interrupted")))
        sent = len(relay.sent)
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTurnComplete())
        await until(lambda: bool(store.stored))
        assert not any(isinstance(x, bytes) for x in relay.sent[sent:])
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    run(_drive(store, script))
    assert store.stored[0][1][-1] == {"role": "subject", "text": "I was", "partial": True}


def test_live_reported_interruption_marks_the_subject_line_partial() -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        conn.push(LiveAudio(b"\x00\x01" * 100))
        conn.push(LiveTranscript("subject", "I was", finished=False))
        conn.push(LiveInterrupted())
        conn.push(LiveTranscript("investigator", "Stop there.", finished=True))
        conn.push(LiveTurnComplete())
        await until(lambda: bool(store.stored))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    relay, _ = run(_drive(store, script))
    assert relay.frames("interrupted") == [{"type": "interrupted", "utterance": 1}]
    assert store.stored[0][1][0]["partial"] is True


def test_fake_live_answers_spoken_audio_end_to_end() -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        del conn
        for _ in range(4):
            relay.inbound.put_nowait(SPEECH)
        for _ in range(8):
            relay.inbound.put_nowait(b"\x00\x00" * 1600)
        await until(lambda: bool(store.stored))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    relay, _ = run(_drive(store, script, conn=FakeLiveConnection(), clock=_ticker()))
    assert store.stored[0][1][0] == {"role": "investigator", "text": "Question 1.", "partial": False}
    assert any(isinstance(x, bytes) for x in relay.sent)
    assert store.log[-1] == ("settle", "committed")


def test_a_manifest_this_checkout_cannot_load_closes_4401_and_releases_the_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def absent(manifest: object) -> object:
        # A registered candidate whose prompt file this checkout does not have (a manifest from another branch).
        del manifest
        msg = "manifest_mismatch for S1: prompts/subject/style.v2.txt unreadable (FileNotFoundError)"
        raise ManifestMismatchError(msg)

    monkeypatch.setattr(live_session, "load_prompts", absent)
    store = Store()
    relay, live = run(_drive(store, lambda _r, _c: asyncio.sleep(0)))
    assert relay.closed == p.REFUSED
    assert live.connections == []
    assert store.log[-2:] == [("close", "4401"), ("settle", "released")]


def test_audio_that_waited_while_live_opened_is_forwarded_whole_not_refused_as_a_burst() -> None:
    store = Store()
    backlog = 100  # 10 s of frames the relay delivered while the session was opening

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        await until(lambda: len(conn.audio_in) == backlog)
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    s, relay, live = session(store)
    for _ in range(backlog):
        relay.inbound.put_nowait(b"\x00\x01" * 1600)

    async def go() -> None:
        task = asyncio.create_task(s.run())
        await until(lambda: bool(live.connections))
        await script(relay, live.connections[0])
        await task

    run(go())
    assert relay.closed == p.NORMAL


def test_the_twelfth_exchange_records_the_final_usage_before_it_closes() -> None:
    store = Store(exchanges=11)

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        del relay
        exchange(conn, "Last question?", "Last answer.")  # its usage report follows its turn_complete

    relay, _ = run(_drive(store, script))
    assert relay.closed == p.EXCHANGE_CAP_REACHED
    assert len(store.usage) == 1
    assert store.log[-1] == ("settle", "committed")


def test_a_reconnect_carries_the_stored_conversation_into_the_new_live_session() -> None:
    store = Store(exchanges=2, release_on_store={3: ["rec-02"]})

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        exchange(conn, "And now?", "Now I recall.")
        await until(lambda: bool(conn.instructions))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    _, live = run(_drive(store, script))
    instruction = str(live.setups[0]["system_instruction"])
    earlier = instruction.split("EARLIER IN THIS INTERVIEW", 1)[1]
    assert "Investigator: Earlier question 1?" in earlier
    assert earlier.index("You: Earlier answer 1.") < earlier.index("Investigator: Earlier question 2?")
    # The update after a release keeps the earlier conversation (it replaces the instruction).
    assert "You: Earlier answer 2." in live.connections[0].instructions[0]
    assert store.stored[0][0] == store.exchanges + 1


def test_unreported_input_is_estimated_at_the_close_and_a_late_report_replaces_the_estimate() -> None:
    store = Store()

    async def listened(relay: Relay, conn: FakeLiveConnection) -> None:
        for _ in range(FRAMES_PER_S):  # one second of investigator audio, hung up before any transcription
            relay.inbound.put_nowait(SPEECH)
        await until(lambda: len(conn.audio_in) == FRAMES_PER_S)
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    run(_drive(store, listened))
    assert [(u.audio_input_tokens, u.audio_output_tokens, u.input_tokens) for u in store.usage] == [(25, 0, 0)]
    assert store.log[-1] == ("settle", "committed")

    late = Store()

    async def reported(relay: Relay, conn: FakeLiveConnection) -> None:
        conn.push(LiveTranscript("investigator", "Where were you?", finished=True))
        await until(lambda: bool(relay.frames("transcription")))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))
        await asyncio.sleep(0.1)
        conn.push(LiveUsage(text_in=50, audio_in=40, text_out=0, audio_out=0, thinking=0))

    run(_drive(late, reported))
    assert len(late.usage) == 1
    assert late.log[-1] == ("settle", "committed")


def test_an_estimate_that_cannot_be_recorded_settles_usage_unknown() -> None:
    store = Store(fail_usage=True)

    async def listened(relay: Relay, conn: FakeLiveConnection) -> None:
        relay.inbound.put_nowait(SPEECH)
        await until(lambda: bool(conn.audio_in))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))

    run(_drive(store, listened))
    assert store.log[-1] == ("settle", "usage_unknown")


def test_audio_produced_during_the_closing_wait_is_still_metered() -> None:
    store = Store()

    async def script(relay: Relay, conn: FakeLiveConnection) -> None:
        conn.push(LiveTranscript("investigator", "Where?", finished=True))
        conn.push(LiveAudio(b"\x00\x01" * 24_000))  # one second of answer
        await until(lambda: bool(relay.frames("utterance_start")))
        relay.inbound.put_nowait(json.dumps({"type": "stop"}))
        await asyncio.sleep(0.1)
        conn.push(LiveAudio(b"\x00\x01" * 24_000))  # one more second while the close waits for a report

    run(_drive(store, script))
    assert [u.audio_output_tokens for u in store.usage] == [2 * PER_S]
    assert store.log[-1] == ("settle", "committed")
