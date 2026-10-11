"""`arena_public` calls, shared by the investigator path (S5 5, 6; S4 5.2-5.4, 6.3; WP-13) and the tournament
job (S5 5.3; WP-17): both processes hold the one `arena_public` credential (S5 2.2), so one class wraps every
function and view that role may use. A harness or job call passes `actor=None` (no `arena.actor_id`, S4 2.3);
an investigator call passes the acting user.

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
from decimal import Decimal
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
class QuestionOrigin:
    """`arena.submit_question`'s harness-only arguments (S2 8.2, SG2-09): who asked, the relay test's
    verdict, and the relayed or rejected card's event, bundled so the wrapper takes one object instead of
    three positional arguments. The default (every field None) is an investigator's question, which carries
    no origin at all."""

    source: str | None = None
    relay_outcome: str | None = None
    proposal_seq: int | None = None


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

    async def submit_question(
        self, trial: UUID, expected_version: int, text: str, key: str, origin: QuestionOrigin | None = None
    ) -> dict[str, Any]:
        """S4 `arena.submit_question`: investigator calls pass no origin; harness calls name theirs
        (`harness_fixed`, `harness_fallback` or `assistant_relay`, S2 8.2, SG2-09)."""
        o = origin or QuestionOrigin()
        return await self.obj(
            "select arena.submit_question(%s, %s, %s, %s, %s, %s, %s)::text",
            (trial, expected_version, text, key, o.source, o.relay_outcome, o.proposal_seq),
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
                # A finished item goes through release_evidence too: S4 returns its stored result for the same ids
                # and refuses different ones (AR003).
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

    async def finalize_trial(self, trial: UUID, work_item: UUID, finding: dict[str, Any] | None) -> dict[str, Any]:
        """`arena.finalize_trial`: `finding` is null for a corpus transcript (S2 8.6; S4 6.2 item 3). SQL
        checks `p_final_finding is null`, so a corpus call sends an actual SQL NULL, never `Jsonb(None)`
        (which would bind the *jsonb value* `null`, not an absent parameter, and `is not null` is true for
        that)."""
        param = finding if finding is None else Jsonb(finding)
        return await self.obj("select arena.finalize_trial(%s, %s, %s)::text", (trial, work_item, param))

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

    async def open_question(self, trial: UUID) -> bool:
        """Whether the trial has a question with no answer yet (`arena.v_transcripts`)."""
        rows = await self.fetch(
            "select exists (select 1 from arena.v_transcripts where trial_id = %s and answer is null)", (trial,)
        )
        return bool(rows and rows[0][0])

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

    # ------------------------------------------------------------------ tournament job (S5 5.3; WP-17)

    async def start_trial(self, trial: UUID) -> dict[str, Any]:
        """S4 `arena.start_trial`: planned -> running, enforcing BKO-2's order; a replay trial whose corpus
        source did not complete and verify `valid` comes back `{"status": "terminated", "state":
        "source_unavailable", ...}` with no caller input (S4 derives it)."""
        return await self.obj("select arena.start_trial(%s)::text", (trial,))

    async def retry_trial(self, planned_trial: UUID) -> UUID:
        """S4 `arena.retry_trial`: a new attempt (same seed and position) after `infra_failed`, at most 3."""
        return UUID(str(await self.value("select arena.retry_trial(%s)", (planned_trial,))))

    async def advance_replay(self, trial: UUID, work_item: UUID) -> dict[str, Any]:
        """S4 `arena.advance_replay` (D2): copies the next sealed source turn into this replay trial."""
        return await self.obj("select arena.advance_replay(%s, %s)::text", (trial, work_item))

    async def work_item_results(self, trial: UUID) -> list[dict[str, Any]]:
        """S4 `arena.work_item_results` (D3): every step of the trial, for the job's own resume at restart."""
        raw = await self.value("select arena.work_item_results(%s)::text", (trial,))
        parsed = json.loads(raw) if isinstance(raw, str) else None
        return parsed if isinstance(parsed, list) else []

    async def tournament_trial(self, trial: UUID) -> dict[str, Any] | None:
        """`arena.v_trials` alone (no training-session join, S5 5.5): a tournament trial's own ids and
        execution state, read by the harness, the job and the D-021 recording export (D9, SG3-15)."""
        rows = await self.fetch(
            "select id, kind, status, transcript_version, exchanges, max_exchanges, coaching_pending,"
            " execution_state, variant_id, assistant_candidate_id, subject_candidate_id, planned_trial_id,"
            " started_at from arena.v_trials where id = %s",
            (trial,),
        )
        if not rows:
            return None
        keys = (
            "trial_id",
            "kind",
            "status",
            "transcript_version",
            "exchanges",
            "max_exchanges",
            "coaching_pending",
            "execution_state",
            "variant_id",
            "assistant_candidate_id",
            "subject_candidate_id",
            "planned_trial_id",
            "started_at",
        )
        return dict(zip(keys, rows[0], strict=True))

    async def released_with_titles(self, trial: UUID) -> list[dict[str, Any]]:
        """`arena.v_released_evidence`'s `record_id`, `title` and `released_after_exchanges` (the corpus
        harness needs the title for `replay_script.v1`'s evidence-slot question, S2 8.6; C-23)."""
        rows = await self.fetch(
            "select record_id, title, released_after_exchanges from arena.v_released_evidence"
            " where trial_id = %s order by release_seq",
            (trial,),
        )
        return [{"record_id": r[0], "title": r[1], "released_after_exchanges": int(r[2])} for r in rows]

    async def planned_trials(self, tournament: UUID) -> list[dict[str, Any]]:
        """`arena.v_planned_trials`: the frozen roster, position order (S5 5.3's "recorded seeded order")."""
        rows = await self.fetch(
            "select id, position, track, block_no, variant_id, assistant_candidate_id, subject_candidate_id,"
            " repeat, source_planned_trial_id from arena.v_planned_trials where tournament_id = %s order by position",
            (tournament,),
        )
        keys = (
            "planned_trial_id",
            "position",
            "track",
            "block_no",
            "variant_id",
            "assistant_candidate_id",
            "subject_candidate_id",
            "repeat",
            "source_planned_trial_id",
        )
        return [dict(zip(keys, r, strict=True)) for r in rows]

    async def planned_trial_attempts(self, tournament: UUID) -> dict[UUID, list[dict[str, Any]]]:
        """Every attempt (`arena.v_trials`) of every planned trial of the tournament, newest attempt last, for
        the job's resume check ("skips planned trials that already have an execution record", S5 5.3).
        `status` distinguishes a never-started attempt (`planned`, where `ops.admit_unit`'s pre-check still
        applies) from one already `running` (where only the per-call spend guard governs, S4 8.5)."""
        rows = await self.fetch(
            "select planned_trial_id, id, attempt, status, execution_state from arena.v_trials"
            " where tournament_id = %s order by planned_trial_id, attempt",
            (tournament,),
        )
        out: dict[UUID, list[dict[str, Any]]] = {}
        for planned_trial_id, trial_id, attempt, status, execution_state in rows:
            out.setdefault(planned_trial_id, []).append(
                {"trial_id": trial_id, "attempt": attempt, "status": status, "execution_state": execution_state}
            )
        return out

    async def admit_unit(self, bucket: str, high_cost_usd: Decimal) -> dict[str, Any]:
        """S4 `ops.admit_unit` (8.5): admit only with 1.5 x the unit's high cost free; holds nothing."""
        return await self.obj("select ops.admit_unit(%s, %s)::text", (bucket, high_cost_usd))
