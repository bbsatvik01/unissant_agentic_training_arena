"""arena_subject's voice-session functions (S5 7.2 step 3, 7.4; S4 voice tables): claim, reserve and open in one
transaction, the voice context, exchange storage, close and the orphan sweep. The meter's usage and settlement go
through `arena_core.db.calls` like every other reservation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from arena_core.db.calls import Conn
from arena_core.voice.protocol import Start

BUCKET = "global"
PURPOSE = "voice.session"  # S5 3.2 purpose labels


class VoiceOpenRefusedError(Exception):
    """The session cannot open: `code` is the close code (4401 binding or quota, 4413 budget)."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class OpenedVoice:
    voice_session_id: UUID
    reservation_id: UUID


def _obj(raw: object) -> dict[str, Any]:
    value = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(value, dict):
        msg = "voice function answered with a non-object"
        raise TypeError(msg)
    return value


async def open_voice(conn: Conn, start: Start) -> OpenedVoice:
    """`claim_voice_ticket`, `ops.reserve_voice` and `open_voice_session` in one transaction (S5 7.2 step 3)."""
    try:
        async with conn.transaction(), conn.cursor() as cur:
            await cur.execute(
                "select training.claim_voice_ticket(%s, %s, %s, %s)",
                (start.ticket_id, start.user_id, start.trial_id, start.mode),
            )
            row = await cur.fetchone()
            if row is None or row[0] is not True:
                raise VoiceOpenRefusedError(4401, "ticket binding refused")
            await cur.execute(
                "select ops.reserve_voice(%s, %s, 'voice_session', %s, %s, %s)::text",
                (f"voice:{start.ticket_id}", BUCKET, PURPOSE, start.trial_id, start.user_id),
            )
            row = await cur.fetchone()
            reserved = _obj(row[0] if row else None)
            if reserved.get("outcome") not in ("reserved", "exists"):
                raise VoiceOpenRefusedError(4413, f"reservation refused: {reserved.get('reason')}")
            reservation = UUID(str(reserved["id"]))
            await cur.execute("select training.open_voice_session(%s, %s)", (start.ticket_id, reservation))
            row = await cur.fetchone()
            if row is None or row[0] is None:
                raise VoiceOpenRefusedError(4401, "voice session refused")
            return OpenedVoice(UUID(str(row[0])), reservation)
    except psycopg.Error as exc:
        # AR040 from open_voice_session: the daily voice quota or a stale binding.
        raise VoiceOpenRefusedError(4401, f"voice session refused ({exc.sqlstate})") from exc


async def voice_context(conn: Conn, voice_session: UUID) -> dict[str, Any]:
    async with conn.transaction(), conn.cursor() as cur:
        await cur.execute("select subject.voice_context(%s)::text", (voice_session,))
        row = await cur.fetchone()
    return _obj(row[0] if row else None)


async def record_exchange(conn: Conn, voice_session: UUID, exchange_no: int, lines: list[dict[str, Any]]) -> list[str]:
    """`training.record_voice_exchange`: stores window `exchange_no` and returns the record ids its transaction
    released (the trial's scheduled releases due after it)."""
    async with conn.transaction(), conn.cursor() as cur:
        await cur.execute(
            "select training.record_voice_exchange(%s, %s::smallint, %s)::text",
            (voice_session, exchange_no, Jsonb(lines)),
        )
        row = await cur.fetchone()
    result = _obj(row[0] if row else None)
    return [str(r["record_id"]) for r in result.get("released", [])]


async def close_voice(conn: Conn, voice_session: UUID, close_code: str) -> None:
    async with conn.transaction(), conn.cursor() as cur:
        await cur.execute("select training.close_voice_session(%s, %s)", (voice_session, close_code))


async def close_orphans(conn: Conn) -> int:
    """`training.close_orphan_voice_sessions()` at arena-subject's start (S5 7.2 step 4)."""
    async with conn.transaction(), conn.cursor() as cur:
        await cur.execute("select training.close_orphan_voice_sessions()")
        row = await cur.fetchone()
    return int(row[0]) if row else 0
