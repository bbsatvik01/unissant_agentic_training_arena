"""The bounded-frame relay between the browser and arena-subject's Live session (S5 7.1, 7.3; lift target: gokbase G4).

Browser frames are re-validated here before anything is forwarded: PCM16 audio of at most 3,200 bytes at most 15
frames a second over 2 s, and the text frames `stop` and `interrupt`; anything else closes 4400 and nothing of it
reaches arena-subject. The internal leg is built from scratch (no inbound header is forwarded) with the api's own
caller token, and its first frame is `start`. From arena-subject, audio of at most 9,600 bytes and the S5 7.3 text
frames are passed on; anything else is dropped. arena-subject's close code is the browser's close code (the only
terminal signal, SG4-32). `context_changed` goes to arena-subject when an evidence request on the trial released
something (7.4).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Protocol
from uuid import UUID

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from arena_core.voice import protocol as p

log = logging.getLogger("arena_api.voice")


class SubjectLeg(Protocol):
    async def send(self, data: bytes | str) -> None: ...

    def frames(self) -> AsyncIterator[bytes | str]: ...

    async def close(self, code: int) -> None: ...

    @property
    def close_code(self) -> int | None: ...


SubjectDialer = Callable[[], AbstractAsyncContextManager[SubjectLeg]]


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

    def __init__(self, browser: WebSocket, leg: SubjectLeg, clock: Callable[[], float] = time.monotonic) -> None:
        self._browser = browser
        self._leg = leg
        self._rate = p.AudioRate()
        self._clock = clock
        self._lock = asyncio.Lock()
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
        _, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError):
                await task
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
                        await self._browser.send_bytes(message)
                elif p.subject_frame_allowed(message):
                    await self._browser.send_text(message)
            except (WebSocketDisconnect, RuntimeError):  # silent-ok: the browser left; the relay ends
                return
        code = self._leg.close_code
        if self.code is None and code is not None:
            self.code = code


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
