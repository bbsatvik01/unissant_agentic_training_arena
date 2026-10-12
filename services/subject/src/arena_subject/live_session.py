"""One voice session in arena-subject (S5 7.2 step 3, 7.4, 7.5; S2 9; lift targets: gokbase G1, G5, G6).

`run_voice` owns the whole life of one relay connection:

1. The first relay frame is `start`; claim, reserve and open run in one transaction (4401 binding, 4413 budget).
2. The Live instruction is built from `subject.voice_context`: the packet's ledger with each gate LOCKED until one
   of its precondition records is released (S2 9.3, SG1-03). The reservation is marked dispatched (kill switch:
   4423) and Live opens with S2 9.2's config.
3. Three loops run until the first terminal close: the relay pump (investigator audio to Live, held while an
   exchange is being stored; `stop`, `interrupt`, `context_changed`), the receive loop (Live audio to the relay
   inside numbered utterances, unpaired captions, exchange windows closed at each model `turn_complete`, usage to
   the meter, the voice guard on the subject's words) and the safety loop (2 s: 480 s audio cap with the 60 s
   warning, 90 s idle, kill switch and spend shutoff from the database).
4. On the terminal close the relay closes with its code (the only terminal signal, SG4-32), the voice session is
   closed with that code (`guard:G3`.. for a guard hit) and the reservation settles from the meter.

Exchange windows (SG3-40, SG3-41): fragments accumulate in arrival order, merged per consecutive same-role run;
`turn_complete` closes window k (the next number after the trial's stored exchanges, at most 12), stored with
`training.record_voice_exchange`; nothing pairs a question with an answer. A late fragment lands in the window it
arrives in. Releases reach Live only between exchanges (SG3-27, SG3-37): after a stored exchange that released
records, or after `context_changed`, the refreshed instruction goes to Live before held audio is forwarded.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

from arena_core.agents.manifests import CandidateManifest, ManifestMismatchError, load_prompts
from arena_core.agents.subject_prompts import (
    LiveNotAllowedError,
    SubjectPacket,
    build_live_instruction,
    live_setup,
)
from arena_core.db.calls import SettleOutcome, UsageReport, UsageResult
from arena_core.db.voice import OpenedVoice, VoiceOpenRefusedError
from arena_core.safety.guard import RecitalIndex, check_speech
from arena_core.voice import protocol as p
from arena_core.voice.live import (
    LiveAudio,
    LiveBackend,
    LiveClosedError,
    LiveConnection,
    LiveInterrupted,
    LiveTranscript,
    LiveTurnComplete,
)
from arena_subject.answer import build_recital_index
from arena_subject.live_meter import LiveMeter

log = logging.getLogger("arena_subject.voice")
TICK_S = 2.0
DB_EVERY_TICKS = 5  # kill switch and spend read from the database every 10 s (the meter reads them on every report)


class RelayClosedError(Exception):
    """The relay leg closed; `code` is its close code (a transport drop when it gave none)."""

    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


class Relay(Protocol):
    async def receive(self) -> bytes | str: ...

    async def send_text(self, data: str) -> None: ...

    async def send_bytes(self, data: bytes) -> None: ...

    async def close(self, code: int) -> None: ...


class VoiceStore(Protocol):
    async def open(self, start: p.Start) -> OpenedVoice: ...

    async def dispatch(self, reservation_id: UUID) -> bool: ...

    async def context(self, voice_session: UUID) -> dict[str, Any]: ...

    async def record_exchange(
        self, voice_session: UUID, exchange_no: int, lines: list[dict[str, Any]]
    ) -> list[str]: ...

    async def record_usage(self, report: UsageReport) -> UsageResult: ...

    async def close(self, voice_session: UUID, close_code: str) -> None: ...

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> None: ...


@dataclass
class _Line:
    role: p.Role
    text: str
    partial: bool = False


def released_ids(ctx: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(str(r["record_id"]) for r in ctx.get("released_evidence", []))


def packet_of(ctx: Mapping[str, Any]) -> SubjectPacket:
    # subject.voice_context serves an open voice session only, and a voice ticket is claimable only on a
    # development-split trial (claim_voice_ticket), so the split here is dev by construction.
    return SubjectPacket.from_private_packet(ctx["private_packet"], split="dev")


@dataclass
class VoiceSession:
    relay: Relay
    store: VoiceStore
    backend: LiveBackend
    clock: Callable[[], float] = time.monotonic
    tick_s: float = TICK_S
    audio_cap_s: float = p.AUDIO_CAP_S
    idle_s: float = p.IDLE_S
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    code: int | None = None
    guard_rule: str | None = None
    _done: asyncio.Event = field(default_factory=asyncio.Event)
    _window: list[_Line] = field(default_factory=list)
    _utterance: int = 0
    _open_utterance: int | None = None
    _muted_utterance: int | None = None
    _holding: bool = False
    _held: list[bytes] = field(default_factory=list)
    _held_bytes: int = 0
    _pending_update: bool = False
    _used: int = 0
    _started: float = 0.0
    _last_activity: float = 0.0
    _warned: bool = False
    _live: LiveConnection | None = None
    _opened: OpenedVoice | None = None
    _packet: SubjectPacket | None = None
    _prompts: Any = None
    _recital: RecitalIndex | None = None
    _meter: LiveMeter | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    # ------------------------------------------------------------------ terminal close

    def end(self, code: int, rule: str | None = None) -> None:
        """The first terminal close wins; set before any await so a later frame cannot replace it (G1 `close`)."""
        if self.code is None:
            self.code = code
            self.guard_rule = rule
        self._done.set()

    # ------------------------------------------------------------------ run

    async def run(self) -> None:
        try:
            await self._run()
        finally:
            await self._finish()

    async def _run(self) -> None:
        try:
            first = await self.relay.receive()
            start = p.parse_start(first) if isinstance(first, str) else None
        except p.ProtocolViolationError:
            start = None
        except RelayClosedError as exc:
            self.end(exc.code)
            return
        if start is None:
            self.end(p.PROTOCOL)
            return
        opening = time.monotonic()
        try:
            self._opened = await self.store.open(start)
        except VoiceOpenRefusedError as exc:
            log.info("voice session refused: %s", exc.reason)
            self.end(exc.code)
            return
        ctx = await self.store.context(self._opened.voice_session_id)
        self._used = len(ctx.get("voice_exchanges", []))
        if self._used >= p.EXCHANGE_CAP:
            self.end(p.EXCHANGE_CAP_REACHED)
            return
        try:
            manifest = CandidateManifest.model_validate(ctx["subject_manifest"])
            self._prompts = load_prompts(manifest)
            self._packet = packet_of(ctx)
            voice_id = str(ctx["public_packet"]["presentation"]["voice_id"])
            setup = live_setup(self._packet, released_ids(ctx), self._prompts, voice_id)
        except (LiveNotAllowedError, ManifestMismatchError, KeyError, ValueError) as exc:
            log.warning("voice setup refused: %s", type(exc).__name__)
            self.end(p.REFUSED)
            return
        self._recital = build_recital_index(setup["system_instruction"], ctx["private_packet"], ctx["public_packet"])
        if not await self.store.dispatch(self._opened.reservation_id):
            self.end(p.KILL)
            return
        self._meter = LiveMeter(self.store.record_usage, self._opened.reservation_id, self.backend.model)
        try:
            async with self.backend.connect(setup) as live:
                self._live = live
                self._started = self._last_activity = self.clock()
                log.info("voice session open in %.2f s", time.monotonic() - opening)
                await self.relay.send_text(p.frame("exchange_count", used=self._used, cap=p.EXCHANGE_CAP))
                await self._loops(live)
        except Exception:
            log.exception("voice: the Live connection failed")
            self.end(p.SERVER_ERROR)

    async def _loops(self, live: LiveConnection) -> None:
        tasks = [
            asyncio.create_task(self._guarded(self._pump(live))),
            asyncio.create_task(self._guarded(self._receive(live))),
            asyncio.create_task(self._guarded(self._safety())),
        ]
        try:
            await self._done.wait()
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def _guarded(self, loop: Awaitable[None]) -> None:
        try:
            await loop
        except p.ProtocolViolationError as exc:
            log.info("voice protocol violation: %s", exc)
            self.end(p.PROTOCOL)
        except RelayClosedError as exc:
            self.end(exc.code)
        except LiveClosedError:
            self.end(p.SERVER_ERROR)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("voice session loop failed")
            self.end(p.SERVER_ERROR)

    async def _finish(self) -> None:
        code = self.code if self.code is not None else p.SERVER_ERROR
        with contextlib.suppress(Exception):
            await self.relay.close(code)
        if self._opened is None:
            return
        try:
            await self.store.close(self._opened.voice_session_id, p.close_code_text(code, self.guard_rule))
        finally:
            outcome: SettleOutcome = self._meter.outcome() if self._meter is not None else "released"
            await self.store.settle(self._opened.reservation_id, outcome)

    # ------------------------------------------------------------------ relay -> Live

    async def _pump(self, live: LiveConnection) -> None:
        while True:
            message = await self.relay.receive()
            if isinstance(message, bytes):
                # Size only: the rate is enforced on arrival at arena-api's edge. Frames that waited here while
                # Live was opening arrive back to back, which is not the browser's rate.
                p.check_browser_audio(message)
                async with self._lock:
                    if not self._holding:
                        await live.send_audio(message)
                        continue
                    self._held.append(message)
                    self._held_bytes += len(message)
                    if self._held_bytes > p.HELD_AUDIO_MAX_BYTES:
                        msg = "held audio over 5 s"
                        raise p.ProtocolViolationError(msg)
                continue
            control = p.parse_relay_text(message)
            if control.kind == "stop":
                self.end(p.NORMAL)
                return
            if control.kind == "interrupt":
                await self._interrupt()
            else:
                async with self._lock:
                    self._pending_update = True
                    if not self._exchange_open():
                        await self._apply_update(live)

    def _exchange_open(self) -> bool:
        return bool(self._window) or self._open_utterance is not None

    async def _interrupt(self) -> None:
        if self._open_utterance is not None:
            self._muted_utterance = self._open_utterance
            await self.relay.send_text(p.frame("interrupted", utterance=self._open_utterance))
            self._open_utterance = None
            self._mark_partial()

    def _mark_partial(self) -> None:
        for line in reversed(self._window):
            if line.role == "subject":
                line.partial = True
                return

    # ------------------------------------------------------------------ Live -> relay

    async def _receive(self, live: LiveConnection) -> None:
        async for event in live.events():
            if isinstance(event, LiveAudio):
                await self._audio(event.data)
            elif isinstance(event, LiveTranscript):
                await self._transcript(event)
            elif isinstance(event, LiveInterrupted):
                if self._open_utterance is not None:
                    await self.relay.send_text(p.frame("interrupted", utterance=self._open_utterance))
                    self._open_utterance = None
                self._mark_partial()
            elif isinstance(event, LiveTurnComplete):
                await self._turn_complete(live)
            elif self._meter is not None and await self._meter.record(event):
                self.end(p.COST)
            if self._done.is_set():
                return

    async def _audio(self, data: bytes) -> None:
        if self._meter is not None:
            self._meter.output_seen()
        self._last_activity = self.clock()
        if self._open_utterance is None:
            if self._muted_utterance is not None and self._muted_utterance == self._utterance:
                return  # the rest of an utterance the investigator interrupted by button is not played
            self._utterance += 1
            self._open_utterance = self._utterance
            await self.relay.send_text(p.frame("utterance_start", utterance=self._utterance))
        for i in range(0, len(data), p.MAX_AUDIO_OUT_BYTES):
            await self.relay.send_bytes(data[i : i + p.MAX_AUDIO_OUT_BYTES])

    async def _transcript(self, event: LiveTranscript) -> None:
        self._last_activity = self.clock()
        if event.text:
            last = self._window[-1] if self._window else None
            if last is not None and last.role == event.role:
                last.text += event.text
            else:
                self._window.append(_Line(event.role, event.text))
        await self.relay.send_text(
            p.frame(
                "transcription", role=event.role, text=event.text[: p.MAX_CAPTION_CHARS], partial=not event.finished
            )
        )
        if event.role == "subject":
            verdict = check_speech(self._subject_text())
            if not verdict.passed:
                self.end(p.SUBJECT_GUARD, verdict.rule)

    def _subject_text(self) -> str:
        return " ".join(line.text for line in self._window if line.role == "subject")

    async def _turn_complete(self, live: LiveConnection) -> None:
        if self._open_utterance is not None:
            await self.relay.send_text(p.frame("utterance_end", utterance=self._open_utterance))
            self._open_utterance = None
        self._muted_utterance = None
        lines = [
            {"role": line.role, "text": text, "partial": line.partial}
            for line in self._window
            if (text := p.cut_words(line.text, p.MAX_LINE_CHARS))
        ]
        if not lines:
            self._window.clear()
            return
        verdict = check_speech(self._subject_text(), self._recital)
        if not verdict.passed:
            self.end(p.SUBJECT_GUARD, verdict.rule)
            return
        opened = self._opened
        if opened is None:  # the loops run only after open
            return
        async with self._lock:
            self._holding = True
        exchange_no = self._used + 1
        released = await self.store.record_exchange(opened.voice_session_id, exchange_no, lines)
        self._used = exchange_no
        self._window.clear()
        await self.relay.send_text(p.frame("exchange", exchange_no=exchange_no, lines=lines))
        await self.relay.send_text(p.frame("exchange_count", used=exchange_no, cap=p.EXCHANGE_CAP))
        async with self._lock:
            if released:
                self._pending_update = True
            if self._pending_update:
                await self._apply_update(live)
            if self._used >= p.EXCHANGE_CAP:
                # Capture stops at the store; the browser plays what it received, then shows the end (SG4-28).
                self.end(p.EXCHANGE_CAP_REACHED)
                return
            for chunk in self._held:
                await live.send_audio(chunk)
            self._held.clear()
            self._held_bytes = 0
            self._holding = False

    async def _apply_update(self, live: LiveConnection) -> None:
        """Send Live the instruction re-rendered from the database's releases (S2 9.2), at an exchange boundary."""
        if self._opened is None or self._packet is None:  # the loops run only after open
            return
        ctx = await self.store.context(self._opened.voice_session_id)
        await live.update_instruction(build_live_instruction(self._packet, released_ids(ctx), self._prompts))
        self._pending_update = False

    # ------------------------------------------------------------------ safety loop

    async def _safety(self) -> None:
        ticks = 0
        while True:
            await self.sleep(self.tick_s)
            ticks += 1
            now = self.clock()
            remaining = self.audio_cap_s - (now - self._started)
            if remaining <= 0:
                self.end(p.NORMAL)
                return
            if now - self._last_activity >= self.idle_s:
                self.end(p.IDLE)
                return
            await self.relay.send_text(p.frame("timer_tick", time_remaining=int(remaining)))
            if remaining <= p.WARNING_BEFORE_S and not self._warned:
                self._warned = True
                await self.relay.send_text(p.frame("warning", reason="ending_soon", seconds=int(remaining)))
            if ticks % DB_EVERY_TICKS == 0 and self._opened is not None:
                ctx = await self.store.context(self._opened.voice_session_id)
                if ctx.get("kill_switch"):
                    self.end(p.KILL)
                    return
                if float(ctx.get("spend_usd", 0)) >= float(ctx.get("shutoff_usd", 1e9)):
                    self.end(p.COST)
                    return
