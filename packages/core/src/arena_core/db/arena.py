"""`arena_public` calls for the investigator path (S5 5, 6; S4 5.2-5.4, 6.3; WP-13).

Every call opens its own connection and transaction, sets `arena.actor_id` for that transaction (S4 2.3: an
investigator request names its actor; a harness request never does) and runs one S4 function or one projection
view read. A function's jsonb result is parsed as JSON; an error S4 raises (`AR001`..`AR040`, `42501`) becomes
`ArenaError` with its SQLSTATE so a route can map it to an HTTP status. The caller never supplies a turn number,
a version it did not read, or a hash.

`release_between_turns` is the one two-statement call: `open_work_item('release')` and `release_evidence` in one
transaction (S5 5.4, SG1-32), so the item is bound to the version the release then checks.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from arena_core.db.calls import Conn
from arena_core.db.pool import Connector

EVENTS_PAGE = 200  # S4 arena.events_after: at most 200 rows per call


class ArenaError(Exception):
    """An S4 refusal: `code` is the SQLSTATE (`AR002` stale version, `AR004` turn in progress, ...)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _arena_error(exc: psycopg.Error) -> ArenaError:
    diag = exc.diag
    return ArenaError(exc.sqlstate or "XX000", diag.message_primary or str(exc))


def iso(value: datetime) -> str:
    """A timestamp as the wire's ISO 8601 with milliseconds and `Z` (contracts `Timestamp`)."""
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class SessionStart:
    """The arguments of `training.start_session`; the phase is never sent (SG4-10)."""

    variant: UUID
    mode: str
    coach: UUID
    subject: UUID
    voice: bool
    key: str


@dataclass(frozen=True)
class EventRow:
    """One `arena.v_trial_events` row."""

    seq: int
    kind: str
    visibility: str
    transcript_version: int
    turn_no: int
    payload: dict[str, Any]
    created_at: datetime


class ArenaDb:
    """The `arena_public` calls one actor makes. `actor` None is a harness request (no investigator)."""

    def __init__(self, connect: Connector, actor: UUID | None) -> None:
        self._connect = connect
        self.actor = actor

    async def _begin(self, conn: Conn) -> None:
        if self.actor is not None:
            await conn.execute("select set_config('arena.actor_id', %s, true)", (str(self.actor),))

    async def fetch(self, query: str, params: Sequence[object] = ()) -> list[tuple[Any, ...]]:
        """Run one statement in its own transaction as this actor and return every row."""
        try:
            async with self._connect() as conn, conn.transaction():
                await self._begin(conn)
                cur = await conn.execute(query, params)
                return list(await cur.fetchall())
        except psycopg.Error as exc:
            raise _arena_error(exc) from exc

    async def value(self, query: str, params: Sequence[object] = ()) -> object:
        """One scalar value (a jsonb result is read as text)."""
        rows = await self.fetch(query, params)
        if not rows:
            msg = "query returned no row"
            raise ArenaError("XX000", msg)
        return rows[0][0]

    async def obj(self, query: str, params: Sequence[object] = ()) -> dict[str, Any]:
        """One jsonb object result."""
        raw = await self.value(query, params)
        parsed = json.loads(raw) if isinstance(raw, str) else None
        if not isinstance(parsed, dict):
            msg = "the function did not return a jsonb object"
            raise ArenaError("XX000", msg)
        return parsed

    # ------------------------------------------------------------------ sessions and turns (S4 5.3, 6.3)

    async def start_session(self, start: SessionStart) -> dict[str, Any]:
        return await self.obj(
            "select training.start_session(%s, %s, %s, %s, %s, %s)::text",
            (start.variant, start.mode, start.coach, start.subject, start.voice, start.key),
        )

    async def submit_question(self, trial: UUID, expected_version: int, text: str, key: str) -> dict[str, Any]:
        return await self.obj(
            "select arena.submit_question(%s, %s, %s, %s)::text", (trial, expected_version, text, key)
        )

    async def open_work_item(
        self, trial: UUID, kind: str, request_key: str, expected_version: int | None = None
    ) -> dict[str, Any]:
        return await self.obj(
            "select arena.open_work_item(%s, %s, %s, %s)::text", (trial, kind, request_key, expected_version)
        )

    async def release_evidence(self, trial: UUID, work_item: UUID, record_ids: list[str]) -> dict[str, Any]:
        return await self.obj("select arena.release_evidence(%s, %s, %s)::text", (trial, work_item, record_ids))

    async def release_between_turns(self, trial: UUID, request_key: str, record_ids: list[str]) -> dict[str, Any]:
        """S5 5.4: the release item and the release in one transaction."""
        try:
            async with self._connect() as conn, conn.transaction():
                await self._begin(conn)
                cur = await conn.execute("select arena.open_work_item(%s, 'release', %s)::text", (trial, request_key))
                item = json.loads((await cur.fetchone() or ("{}",))[0])
                if item.get("status") == "done":
                    return dict(item["result"])
                cur = await conn.execute(
                    "select arena.release_evidence(%s, %s, %s)::text", (trial, item["work_item_id"], record_ids)
                )
                return dict(json.loads((await cur.fetchone() or ("{}",))[0]))
        except psycopg.Error as exc:
            raise _arena_error(exc) from exc

    async def record_coaching_event(
        self, trial: UUID, work_item: UUID, payload: dict[str, Any], kind: str
    ) -> dict[str, Any]:
        return await self.obj(
            "select arena.record_coaching_event(%s, %s, %s, %s)::text", (trial, work_item, Jsonb(payload), kind)
        )

    async def finalize_trial(self, trial: UUID, work_item: UUID, finding: dict[str, Any]) -> dict[str, Any]:
        return await self.obj("select arena.finalize_trial(%s, %s, %s)::text", (trial, work_item, Jsonb(finding)))

    async def record_execution_failure(self, trial: UUID, work_item: UUID, state: str, reason: str) -> dict[str, Any]:
        return await self.obj(
            "select arena.record_execution_failure(%s, %s, %s, %s)::text", (trial, work_item, state, reason)
        )

    async def trial_context(self, trial: UUID, work_item: UUID) -> dict[str, Any]:
        return await self.obj("select arena.trial_context(%s, %s)::text", (trial, work_item))

    # ------------------------------------------------------------------ tickets and events (S5 6.3, 6.4)

    async def issue_ticket(self, kind: str, trial: UUID) -> str:
        return str(await self.value("select training.issue_access_ticket(%s, %s)", (kind, trial)))

    async def redeem_ticket(self, token: str, kind: str) -> dict[str, Any]:
        return await self.obj("select training.redeem_access_ticket(%s, %s)::text", (token, kind))

    async def trial_events(self, trial: UUID, after: int, limit: int = EVENTS_PAGE) -> list[EventRow]:
        """The actor's trial events after `after` through `arena.v_trial_events` (S5 6.2: the owner's own training
        trial; debrief rows only once the trial ended, S4 enforcing it a second time)."""
        rows = await self.fetch(
            "select seq, kind, visibility, transcript_version, turn_no, payload::text, created_at"
            " from arena.v_trial_events where trial_id = %s and seq > %s order by seq limit %s",
            (trial, after, limit),
        )
        return [EventRow(int(r[0]), str(r[1]), str(r[2]), int(r[3]), int(r[4]), json.loads(r[5]), r[6]) for r in rows]

    async def all_events(self, trial: UUID) -> list[EventRow]:
        out: list[EventRow] = []
        while True:
            page = await self.trial_events(trial, out[-1].seq if out else 0)
            out.extend(page)
            if len(page) < EVENTS_PAGE:
                return out

    # ------------------------------------------------------------------ projection reads

    async def trial(self, trial: UUID) -> dict[str, Any] | None:
        """`arena.v_trials` joined with the actor's session (`training.v_my_sessions`): the actor's own training
        trial only, else None (no existence oracle)."""
        rows = await self.fetch(
            "select t.id, t.mode, t.status, t.transcript_version, t.exchanges, t.max_exchanges, t.coaching_pending,"
            " t.execution_state, t.variant_id, s.id, s.voice, t.started_at, t.assistant_candidate_id"
            " from arena.v_trials t join training.v_my_sessions s on s.trial_id = t.id where t.id = %s",
            (trial,),
        )
        if not rows:
            return None
        r = rows[0]
        keys = (
            "trial_id",
            "mode",
            "status",
            "transcript_version",
            "exchanges",
            "max_exchanges",
            "coaching_pending",
            "execution_state",
            "variant_id",
            "session_id",
            "voice",
            "started_at",
            "assistant_candidate_id",
        )
        return dict(zip(keys, r, strict=True))

    async def released(self, trial: UUID) -> list[dict[str, Any]]:
        rows = await self.fetch(
            "select record_id, released_after_exchanges, content::text from arena.v_released_evidence"
            " where trial_id = %s order by release_seq",
            (trial,),
        )
        return [{"record_id": r[0], "released_after_exchanges": int(r[1]), "content": json.loads(r[2])} for r in rows]

    async def public_packet(self, variant: UUID) -> dict[str, Any] | None:
        rows = await self.fetch("select public_packet::text from arena.v_dev_cases where variant_id = %s", (variant,))
        return json.loads(rows[0][0]) if rows else None

    async def study(self) -> dict[str, Any] | None:
        """`training.v_my_study`: the actor's KPI-1 participant state, None for a non-participant."""
        rows = await self.fetch(
            "select code, counterbalance, pre_ended, practice_ended, post_ended, pre_variant_ids, post_variant_ids,"
            " tested_variant_ids from training.v_my_study"
        )
        if not rows:
            return None
        keys = ("code", "counterbalance", "pre_ended", "practice_ended", "post_ended", "pre", "post", "tested")
        return dict(zip(keys, rows[0], strict=True))

    async def dev_cases(self) -> list[dict[str, Any]]:
        rows = await self.fetch(
            "select variant_id, family_code, variant_code, public_packet::text, kpi1_set from arena.v_dev_cases"
        )
        return [
            {
                "variant_id": r[0],
                "family_code": r[1],
                "variant_code": r[2],
                "public_packet": json.loads(r[3]),
                "kpi1_set": bool(r[4]),
            }
            for r in rows
        ]

    async def my_sessions(self) -> list[dict[str, Any]]:
        rows = await self.fetch(
            "select id, trial_id, phase, voice, created_at, mode, status, exchanges, variant_id, ended_at"
            " from training.v_my_sessions order by created_at"
        )
        keys = ("session_id", "trial_id", "phase", "voice", "created_at", "mode", "status", "exchanges", "variant_id")
        return [dict(zip(keys, r[:9], strict=True)) for r in rows]

    async def candidate(self, kind: str, name: str) -> tuple[UUID, dict[str, Any]] | None:
        """The newest registered candidate of this kind and name (`arena.v_candidates`)."""
        rows = await self.fetch(
            "select id, manifest::text from arena.v_candidates where kind = %s and name = %s"
            " order by created_at desc limit 1",
            (kind, name),
        )
        return (rows[0][0], json.loads(rows[0][1])) if rows else None

    async def manifest(self, candidate: UUID) -> dict[str, Any] | None:
        rows = await self.fetch("select manifest::text, sha256 from arena.v_candidates where id = %s", (candidate,))
        return {"manifest": json.loads(rows[0][0]), "sha256": rows[0][1]} if rows else None

    async def debrief(self, session: UUID) -> dict[str, Any] | None:
        rows = await self.fetch("select payload::text from training.v_my_debrief where session_id = %s", (session,))
        return json.loads(rows[0][0]) if rows else None

    async def public_config(self) -> dict[str, Any]:
        rows = await self.fetch(
            "select paused, text_sessions_per_user_day, voice_sessions_per_user_day from ops.v_public_config"
        )
        r = rows[0] if rows else (False, None, None)
        return {"paused": bool(r[0]), "text_sessions_per_user_day": r[1], "voice_sessions_per_user_day": r[2]}

    async def acknowledgements(self) -> dict[str, datetime]:
        rows = await self.fetch("select kind, acknowledged_at from training.v_my_acknowledgements")
        return {str(r[0]): r[1] for r in rows}

    async def acknowledge(self, kind: str) -> datetime:
        value = await self.value("select training.acknowledge(%s)", (kind,))
        if not isinstance(value, datetime):
            msg = "training.acknowledge returned no time"
            raise ArenaError("XX000", msg)
        return value

    async def ack_card(self, trial: UUID, turn_no: int, client_valid: bool) -> bool:
        return bool(await self.value("select ops.ack_card(%s, %s::smallint, %s)", (trial, turn_no, client_valid)))
