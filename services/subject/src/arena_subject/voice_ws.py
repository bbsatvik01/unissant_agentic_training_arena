"""`/internal/voice/ws` plumbing (S5 7.1, 7.2 step 3): the database store a voice session uses, and the Starlette
WebSocket as the session's relay leg. Only `arena-api`'s caller token may open the route (the tournament's may
not), checked with the Host before the upgrade is accepted."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from arena_core.db import calls
from arena_core.db import voice as db_voice
from arena_core.db.calls import SettleOutcome, UsageReport, UsageResult
from arena_core.db.pool import Connector
from arena_core.voice import protocol as p
from arena_subject.live_session import RelayClosedError

VOICE_CALLER_VAR = "ARENA_VOICE_CALLER"
#: Close codes arena-api sends on the internal leg itself (a browser protocol violation); any other close of the
#: leg is a transport drop for the session (S5 7.5).
RELAY_TERMINAL_CODES = frozenset({p.PROTOCOL})


class DbVoiceStore:
    def __init__(self, connect: Connector) -> None:
        self._connect = connect

    async def open(self, start: p.Start) -> db_voice.OpenedVoice:
        async with self._connect() as conn:
            return await db_voice.open_voice(conn, start)

    async def dispatch(self, reservation_id: UUID) -> bool:
        async with self._connect() as conn:
            result = await calls.mark_dispatched(conn, reservation_id)
        return result.outcome in ("dispatched", "already_dispatched")

    async def context(self, voice_session: UUID) -> dict[str, Any]:
        async with self._connect() as conn:
            return await db_voice.voice_context(conn, voice_session)

    async def record_exchange(self, voice_session: UUID, exchange_no: int, lines: list[dict[str, Any]]) -> list[str]:
        async with self._connect() as conn:
            return await db_voice.record_exchange(conn, voice_session, exchange_no, lines)

    async def record_usage(self, report: UsageReport) -> UsageResult:
        async with self._connect() as conn:
            return await calls.record_usage(conn, report)

    async def close(self, voice_session: UUID, close_code: str) -> None:
        async with self._connect() as conn:
            await db_voice.close_voice(conn, voice_session, close_code)

    async def settle(self, reservation_id: UUID, outcome: SettleOutcome) -> None:
        async with self._connect() as conn:
            await calls.settle_voice_reservation(conn, reservation_id, outcome)


class StarletteRelay:
    """The accepted WebSocket from arena-api as a `Relay`."""

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws

    async def receive(self) -> bytes | str:
        message = await self._ws.receive()
        if message["type"] == "websocket.disconnect":
            code = int(message.get("code") or p.TRANSPORT)
            raise RelayClosedError(code if code in RELAY_TERMINAL_CODES else p.TRANSPORT)
        data = message.get("bytes")
        if data is not None:
            return bytes(data)
        return str(message.get("text") or "")

    async def send_text(self, data: str) -> None:
        try:
            await self._ws.send_text(data)
        except (WebSocketDisconnect, RuntimeError) as exc:
            raise RelayClosedError(p.TRANSPORT) from exc

    async def send_bytes(self, data: bytes) -> None:
        try:
            await self._ws.send_bytes(data)
        except (WebSocketDisconnect, RuntimeError) as exc:
            raise RelayClosedError(p.TRANSPORT) from exc

    async def close(self, code: int) -> None:
        if self._ws.application_state == WebSocketState.CONNECTED and self._ws.client_state == WebSocketState.CONNECTED:
            await self._ws.close(code)
