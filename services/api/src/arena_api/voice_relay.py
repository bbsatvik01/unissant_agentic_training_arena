"""The bounded-frame relay between the browser and arena-subject's Live session (S5 7.1, 7.3; lift target: gokbase G4).

Browser frames are re-validated here before anything is forwarded: PCM16 audio of at most 3,200 bytes at most 15
frames a second over 2 s, and the text frames `stop` and `interrupt`; anything else closes 4400 and nothing of it
reaches arena-subject. The internal leg is built from scratch (no inbound header is forwarded) with the api's own
caller token, and its first frame is `start`. From arena-subject, audio of at most 9,600 bytes and the S5 7.3 text
frames are passed on; anything else is dropped. arena-subject's close code is the browser's close code (the only
terminal signal, SG4-32). `context_changed` goes to arena-subject when an evidence request on the trial released
something (7.4). In a practice session, each `exchange` frame from arena-subject is also coached (UI v2 amendment
to D7): `coach(exchange_no)` builds the exchange's card off the relay's path and its `coach.card` text frame is
sent to the browser after the exchange, one card at a time and in exchange order, so the earpiece can speak it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Protocol
from uuid import UUID

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from arena_core.voice import protocol as p

log = logging.getLogger("arena_api.voice")
CARD_GRACE_S = 15.0  # how long a closing relay waits for the session's last coach cards (a card call's deadline)


class SubjectLeg(Protocol):
    async def send(self, data: bytes | str) -> None: ...

    def frames(self) -> AsyncIterator[bytes | str]: ...

    async def close(self, code: int) -> None: ...

    @property
    def close_code(self) -> int | None: ...


SubjectDialer = Callable[[], AbstractAsyncContextManager[SubjectLeg]]
# exchange number -> the browser's `coach.card` text frame for it, or None when there is no card
ExchangeCoach = Callable[[int], Awaitable[str | None]]


class _WsLeg:
    def __init__(self, ws: ClientConnection) -> None:
        self._ws = ws

    async def send(self, data: bytes | str) -> None:
        await self._ws.send(data)

    async def frames(self) -> AsyncIterator[bytes | str]:
        with contextlib.suppress(ConnectionClosed):
            async for message in self._ws:
                yield message

    async def close(self, code: int) -> None:
        await self._ws.close(code)

    @property
    def close_code(self) -> int | None:
        return self._ws.close_code


def subject_dialer(token: str, url: str) -> SubjectDialer:
    """Dial arena-subject's `/internal/voice/ws` with the api's caller token (and nothing else from the browser)."""

    @asynccontextmanager
    async def dial() -> AsyncIterator[SubjectLeg]:
        async with ws_connect(
            url, additional_headers={"Authorization": f"Bearer {token}"}, max_size=2**20, open_timeout=10
        ) as ws:
            yield _WsLeg(ws)

    return dial


class VoiceRelay:
    """One browser connection relayed to one arena-subject voice session."""

    def __init__(
        self,
        browser: WebSocket,
        leg: SubjectLeg,
        clock: Callable[[], float] = time.monotonic,
        coach: ExchangeCoach | None = None,
    ) -> None:
        self._browser = browser
        self._leg = leg
        self._rate = p.AudioRate()
        self._clock = clock
        self._lock = asyncio.Lock()
        self._send = asyncio.Lock()  # one browser send at a time: the subject pump and the coach both send
        self._coach = coach
        self._exchanges: asyncio.Queue[int] = asyncio.Queue()
        self.code: int | None = None

    async def context_changed(self) -> None:
        async with self._lock:
            with contextlib.suppress(ConnectionClosed):
                await self._leg.send(p.CONTEXT_CHANGED)

    async def run(self, start: p.Start) -> int:
        """Relay until either side ends; returns the close code sent to the browser."""
        await self._leg.send(p.start_frame(start))
        up = asyncio.create_task(self._browser_to_subject())
        down = asyncio.create_task(self._subject_to_browser())
        cards = asyncio.create_task(self._cards(self._coach)) if self._coach is not None else None
        _, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if cards is not None:
            # The session ended at an exchange (the cap, the investigator's stop): its last card is still on its way.
            # While the browser is there, wait a bounded time for the queued cards before closing.
            if self._browser.client_state == WebSocketState.CONNECTED:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._exchanges.join(), CARD_GRACE_S)
            cards.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cards
        code = self.code if self.code is not None else (self._leg.close_code or p.SERVER_ERROR)
        if self._browser.client_state == WebSocketState.CONNECTED:
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await self._browser.close(code)
        return code

    async def _browser_to_subject(self) -> None:
        try:
            while True:
                message = await self._browser.receive()
                if message["type"] == "websocket.disconnect":
                    # The browser left (hang-up after stop, tab closed, network): the subject session ends as a
                    # transport drop unless it already closed.
                    await self._leg.close(1001)
                    self.code = None
                    return
                data = message.get("bytes")
                if data is not None:
                    p.check_browser_audio(data)
                    self._rate.admit(self._clock())
                    async with self._lock:
                        await self._leg.send(bytes(data))
                    continue
                control = p.parse_browser_text(str(message.get("text") or ""))
                async with self._lock:
                    await self._leg.send(p.frame(control.kind))
        except p.ProtocolViolationError as exc:
            log.info("voice: browser protocol violation: %s", exc)
            self.code = p.PROTOCOL
            with contextlib.suppress(ConnectionClosed):
                await self._leg.close(p.PROTOCOL)
        except ConnectionClosed:  # silent-ok: arena-subject closed; its close code is read by the other pump
            return

    async def _subject_to_browser(self) -> None:
        async for message in self._leg.frames():
            try:
                if isinstance(message, bytes):
                    if len(message) <= p.MAX_AUDIO_OUT_BYTES:
                        async with self._send:
                            await self._browser.send_bytes(message)
                elif p.subject_frame_allowed(message):
                    async with self._send:
                        await self._browser.send_text(message)
                    self._note_exchange(message)
            except (WebSocketDisconnect, RuntimeError):  # silent-ok: the browser left; the relay ends
                return
        code = self._leg.close_code
        if self.code is None and code is not None:
            self.code = code

    def _note_exchange(self, message: str) -> None:
        """Queue a completed exchange for its card (practice sessions only: `coach` is None otherwise)."""
        if self._coach is None:
            return
        frame = json.loads(message)
        number = frame.get("exchange_no")
        if frame.get("type") == "exchange" and isinstance(number, int) and not isinstance(number, bool):
            self._exchanges.put_nowait(number)

    async def _cards(self, coach: ExchangeCoach) -> None:
        """Coach each queued exchange in order and send its card; a card that fails is skipped (`coach` logs it)."""
        while True:
            exchange_no = await self._exchanges.get()
            try:
                text = await coach(exchange_no)
                if text is not None:
                    async with self._send:
                        await self._browser.send_text(text)
            except (WebSocketDisconnect, RuntimeError):  # silent-ok: the browser left; the relay is ending
                return
            finally:
                self._exchanges.task_done()


class RelayRegistry:
    """The open relays by trial, so the evidence route can send `context_changed` (one voice session per trial)."""

    def __init__(self) -> None:
        self._by_trial: dict[UUID, VoiceRelay] = {}

    def add(self, trial: UUID, relay: VoiceRelay) -> None:
        self._by_trial[trial] = relay

    def remove(self, trial: UUID, relay: VoiceRelay) -> None:
        if self._by_trial.get(trial) is relay:
            del self._by_trial[trial]

    async def context_changed(self, trial: UUID) -> bool:
        relay = self._by_trial.get(trial)
        if relay is None:
            return False
        await relay.context_changed()
        return True
