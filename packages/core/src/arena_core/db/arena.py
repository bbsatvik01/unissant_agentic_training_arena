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
from arena_core.db.pool import Connector, one_statement
from arena_core.events.projections import LedgerRow, tournament_frames

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


@dataclass(frozen=True)
class CoachEvent:
    """One `coach_card` or `coach_unavailable` event of a running tournament trial (`arena.harness_trial_state`)."""

    seq: int
    kind: str
    turn_no: int
    payload: dict[str, Any]


@dataclass(frozen=True)
class HarnessTrialState:
    """`arena.harness_trial_state` (WP-28; S5 5.3): what the tournament job reads back of the trial it is running,
    between its own steps, on a dev and a hidden split alike. `released` rows carry `record_id`, `title` and
    `released_after_exchanges`, never the record's content."""

    public_packet: dict[str, Any] | None  # None only if the variant has none (S4 ingest stores one per variant)
    open_question: bool
    released: list[dict[str, Any]]
    coach_events: list[CoachEvent]


class ArenaDb:
    """The `arena_public` calls one actor makes. `actor` None is a harness request (no investigator)."""

    def __init__(self, connect: Connector, actor: UUID | None) -> None:
        self._connect = connect
        self.actor = actor

    @property
    def connector(self) -> Connector:
        return self._connect

    async def _begin(self, conn: Conn) -> None:
        if self.actor is not None:
            await conn.execute("select set_config('arena.actor_id', %s, true)", (str(self.actor),))

    async def fetch(self, query: str, params: Sequence[object] = ()) -> list[tuple[Any, ...]]:
        """Run one statement in its own transaction as this actor and return every row."""
        try:
            async with self._connect() as conn:
                actor = None if self.actor is None else str(self.actor)
                cur = await one_statement(conn, query, params, actor=actor)
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

    async def hidden_packet(self, variant: UUID) -> dict[str, Any] | None:
        """S4/S6 visibility: `variant`'s hidden-split public packet (`sealed.hidden_public_packets`), readable
        through `arena.v_hidden_cases` only once some trial on it is `arena.trial_visible` -- a revealed hidden
        tournament, never before (SCN-12). `events.load`'s shared packet resolution falls back to this only
        when `public_packet` (the dev split) finds nothing, so a dev variant is never looked up twice."""
        rows = await self.fetch(
            "select public_packet::text from arena.v_hidden_cases where variant_id = %s", (variant,)
        )
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

    async def tournament_status(self, tournament: UUID) -> str | None:
        """`arena.v_tournaments`: the tournament's status, None when there is no such tournament."""
        rows = await self.fetch("select status from arena.v_tournaments where id = %s", (tournament,))
        return str(rows[0][0]) if rows else None

    async def leaderboard(self, tournament: UUID, board: str, label: str | None) -> dict[str, Any] | None:
        """`arena.v_leaderboards`: the published body of one board (S5 5.5), the given label or else the one bound
        to the latest manifest (a corrected board supersedes the original, S6 4.10). None when none is published."""
        rows = await self.fetch(
            "select body::text, label, manifest_version from arena.v_leaderboards"
            " where tournament_id = %s and board = %s and (%s::text is null or label = %s::text)"
            " order by manifest_version desc limit 1",
            (tournament, board, label, label),
        )
        if not rows:
            return None
        return {"body": json.loads(rows[0][0]), "label": str(rows[0][1]), "manifest_version": int(rows[0][2])}

    # ------------------------------------------------------------------ tournament arena (S5 6.2, S6 4.9)

    async def tournaments(self) -> list[dict[str, Any]]:
        """`arena.v_tournaments` (S6 4.9's list, `GET /api/tournaments`): every tournament, oldest first."""
        rows = await self.fetch(
            "select id, name, split, status, seed, roster_sha256 from arena.v_tournaments order by created_at"
        )
        return [
            {
                "id": str(r[0]),
                "name": str(r[1]),
                "split": str(r[2]),
                "status": str(r[3]),
                "seed": int(r[4]),
                "roster_sha256": r[5],
            }
            for r in rows
        ]

    async def tournament_progress(self, tournament: UUID) -> list[dict[str, Any]]:
        """`arena.v_tournament_progress` (D9, SG3-15): per track and block, planned trials and counts by
        execution state -- the one view a hidden tournament exposes before reveal (S6 4.9's progress table),
        and part of a dev or revealed tournament's own `GET /api/tournaments/{id}` too."""
        rows = await self.fetch(
            "select track, block_no, planned, states::text from arena.v_tournament_progress"
            " where tournament_id = %s order by track, block_no",
            (tournament,),
        )
        return [
            {"track": str(r[0]), "block": r[1], "planned": int(r[2]), "counts_by_state": json.loads(r[3])} for r in rows
        ]

    async def _tournament_trial_refs(self, tournament: UUID) -> dict[UUID, dict[str, Any]]:
        """Every tournament trial's planned position (`trial_ref`, S5 6.2's opaque per-tournament ordinal:
        `arena.v_planned_trials.position`, "seeded order across the tournament"), track, block, pairing and
        whether it ever started, keyed by trial id. The pairing names the registered assistant and subject
        candidates (S6 4.9's "A1 x S1"; `arena.v_candidates.name`, always `A{n}`/`S{n}` for the official
        lineup): a `replay` planned trial carries no subject of its own (`arena.planned_trials`'s own track
        shape), so its pairing names the subject of the corpus trial it replays instead
        (`source_planned_trial_id`); a `replay_corpus` trial carries no assistant, so its pairing is `None`
        (its caller never frames one, S6 4.9: counts only). `never_started` is `started_at is null`: a
        `budget_skipped` or `source_unavailable` attempt never reaches `arena.start_trial`'s own update
        (S4 EF-01, EF-09), the same signal `events.load.load_tournament_trial` already reads for the same
        reason.

        Called after the ledger read in `tournament_events` (never before it, SG3-xx): under `read
        committed`, a row this call's own SELECT sees was committed strictly before this statement started,
        so a trial whose `trial_started` row the earlier ledger read already returned is guaranteed to have
        its `arena.trials`/`arena.planned_trials` rows visible here too -- reading refs first could race a
        concurrent retry's start between the two queries and silently drop that trial's frame forever."""
        rows = await self.fetch(
            "select t.id, p.position, p.track, p.block_no, ac.name, coalesce(sc.name, ssc.name), t.started_at"
            " from arena.v_trials t join arena.v_planned_trials p on p.id = t.planned_trial_id"
            " left join arena.v_planned_trials sp on sp.id = p.source_planned_trial_id"
            " left join arena.v_candidates ac on ac.id = p.assistant_candidate_id"
            " left join arena.v_candidates sc on sc.id = p.subject_candidate_id"
            " left join arena.v_candidates ssc on ssc.id = sp.subject_candidate_id"
            " where t.tournament_id = %s",
            (tournament,),
        )
        out: dict[UUID, dict[str, Any]] = {}
        for trial_id, position, track, block_no, assistant_name, subject_name, started_at in rows:
            both_named = assistant_name is not None and subject_name is not None
            pairing = f"{assistant_name} x {subject_name}" if both_named else None
            out[trial_id] = {
                "trial_ref": int(position),
                "track": str(track),
                "block": block_no,
                "pairing": pairing,
                "never_started": started_at is None,
            }
        return out

    async def tournament_events(
        self, tournament: UUID, after: int, limit: int = 200
    ) -> tuple[list[dict[str, Any]], int]:
        """`GET /api/tournaments/{id}/events?after=` on a dev or revealed tournament (S5 6.2, S6 4.9, 5.3):
        `ledger.v_events` after the global cursor, joined to each row's own trial (`_tournament_trial_refs`,
        read second -- see its own docstring) and projected (`events.projections.tournament_frames`, the
        only module that builds a frame, S5 1.2 item 2); never called for a hidden tournament before reveal
        (the route serves counts instead, D9). The returned cursor never regresses below `after`: an empty
        page (nothing new since the caller's own cursor) must answer that cursor back, not
        `tournament_frames`'s own "nothing consumed yet" 0 -- a caller that trusts the advertised cursor
        literally, rather than folding it with its previous one the way the existing client's `foldPoll`
        does (`Math.max`), would otherwise reread the whole tournament from the start."""
        rows = await self.fetch(
            "select seq, event_type, trial_id::text, payload::text, created_us from ledger.v_events"
            " where tournament_id = %s and seq > %s order by seq",
            (tournament, after),
        )
        refs = await self._tournament_trial_refs(tournament)
        ledger_rows: list[LedgerRow] = []
        for seq, event_type, trial_id, payload_text, created_us in rows:
            ref = refs.get(UUID(trial_id)) if trial_id is not None else None
            ledger_rows.append(
                LedgerRow(
                    seq=int(seq),
                    event_type=str(event_type),
                    trial_id=trial_id,
                    created_at=iso(datetime.fromtimestamp(int(created_us) / 1_000_000, tz=UTC)),
                    payload=json.loads(payload_text),
                    trial_ref=None if ref is None else ref["trial_ref"],
                    track=None if ref is None else ref["track"],
                    block=None if ref is None else ref["block"],
                    pairing=None if ref is None else ref["pairing"],
                    never_started=False if ref is None else ref["never_started"],
                )
            )
        frames, last = tournament_frames(ledger_rows, str(tournament), limit)
        return frames, max(after, last)

    # ------------------------------------------------------------------ trust center (S6 4.11)

    async def isolation_checks(self) -> list[dict[str, Any]]:
        """`arena.v_isolation_checks`: the latest run per check and candidate (S6 4.11): check, candidate, pass or
        fail, run time and commit (never the evidence)."""
        rows = await self.fetch(
            "select check_name, candidate_name, passed, run_at, commit_sha from"
            " (select distinct on (check_name, candidate_id) check_name, candidate_name, passed, run_at, commit_sha"
            "  from arena.v_isolation_checks order by check_name, candidate_id, run_at desc) latest"
            " order by check_name, candidate_name"
        )
        return [
            {"check": r[0], "candidate": r[1], "passed": bool(r[2]), "run_at": iso(r[3]), "commit_sha": r[4]}
            for r in rows
        ]

    async def revealed_commitments(self) -> list[dict[str, Any]]:
        """The commitments of revealed tournaments' trials with their payload and the revealed nonce (S4 6:
        public after reveal), each trial named by an opaque per-tournament ordinal (`trial_ref`, S5 6.2)."""
        rows = await self.fetch(
            "select t.tournament_id, x.name, row_number() over (partition by t.tournament_id order by t.id),"
            " c.commitment_sha256, c.payload_text, n.nonce_hex"
            " from ledger.v_commitments c join arena.v_trials t on t.id = c.trial_id"
            " join arena.v_tournaments x on x.id = t.tournament_id and x.status = 'revealed'"
            " left join ledger.v_revealed_nonces n on n.trial_id = c.trial_id"
            " where c.payload_text is not null order by x.name, 3"
        )
        out = []
        for tournament, name, ref, commitment, payload_text, nonce in rows:
            payload = json.loads(payload_text)
            out.append(
                {
                    "tournament_id": str(tournament),
                    # Unique across tournaments: the tournament's name and the trial's ordinal in it.
                    "trial_ref": f"{name} #{int(ref)}",
                    "commitment_sha256": commitment,
                    "transcript_sha256": payload.get("transcript_sha256"),
                    "evidence_sha256": payload.get("evidence_sha256"),
                    "payload_text": payload_text,
                    "nonce": nonce,
                }
            )
        return out

    async def fairness(self) -> dict[str, Any] | None:
        """The fairness audit published with the newest assistant board (S3 8.1 item 4: published with the
        leaderboard; boards exist only after reveal), or None before any is published."""
        rows = await self.fetch(
            "select (body -> 'fairness')::text from arena.v_leaderboards"
            " where board = 'assistant' and body ? 'fairness' order by created_at desc limit 1"
        )
        return json.loads(rows[0][0]) if rows and rows[0][0] is not None else None

    async def budget_view(self) -> dict[str, Any]:
        """The `global` bucket (`ops.v_budget_status`) and spend by purpose label (`ops.v_call_costs`), money as
        decimal strings. `spent_usd` is the bucket's settled liability (liability minus open holds)."""
        rows = await self.fetch(
            "select ceiling_usd, liability_usd, open_usd from ops.v_budget_status where bucket = 'global'"
        )
        ceiling, liability, held = rows[0] if rows else (0, 0, 0)
        # Settled liability once per reservation (a usage_unknown settlement keeps its whole hold even when its
        # receipts carry no usage), so the purpose rows use the same accounting as the total.
        purposes = await self.fetch(
            "select purpose, count(*), coalesce(sum(settled), 0) from"
            " (select distinct reservation_id, purpose, coalesce(settled_usd, 0) as settled from ops.v_call_costs"
            "  where state in ('committed', 'usage_unknown')) settled_reservations"
            " group by purpose order by purpose"
        )
        return {
            "ceiling_usd": str(ceiling),
            "spent_usd": str(liability - held),
            "open_usd": str(held),
            "by_purpose": [{"purpose": p, "calls": int(n), "spent_usd": str(c)} for p, n, c in purposes],
        }

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

    async def tournament_split(self, tournament: UUID) -> str | None:
        """`arena.v_tournaments.split` ("dev" or "hidden"), or None for an unknown id: `GET
        /api/tournaments/{id}/events` serves counts only for a hidden tournament before reveal (D9)."""
        rows = await self.fetch("select split from arena.v_tournaments where id = %s", (tournament,))
        return None if not rows else str(rows[0][0])

    async def gate_rows_before_open(self, tournament: UUID) -> list[tuple[str, bool, str | None]]:
        """`arena.v_isolation_checks`: the latest row per check name recorded after the tournament's roster froze
        and before it went `running` (`check_name`, `passed`, `commit_sha`): the isolation gate the referee's
        open route runs fresh for a hidden tournament between the two (S1 L9, S3 9). Empty for an unknown or
        never-opened tournament, and for one opened without a gate run in that window."""
        rows = await self.fetch(
            "select distinct on (i.check_name) i.check_name, i.passed, i.commit_sha"
            " from arena.v_isolation_checks i join arena.v_tournaments t on t.id = %s"
            " where t.frozen_at is not null and t.running_at is not null"
            " and i.run_at > t.frozen_at and i.run_at <= t.running_at"
            " order by i.check_name, i.run_at desc",
            (tournament,),
        )
        return [(str(r[0]), bool(r[1]), None if r[2] is None else str(r[2])) for r in rows]

    async def harness_trial_state(self, trial: UUID) -> HarnessTrialState:
        """`arena.harness_trial_state` (WP-28): the job's own in-flight read of a running tournament trial -- the
        case's public packet, whether a question is open, the released records' ids, titles and exchange counts,
        and the coach card events -- for the harness's decisions between its steps (S2 8.2, 8.6; S5 5.3, 5.4).
        S4 refuses it to an investigator request and to any trial not `running` (AR040, AR001): it is never a
        recording or export read, which go through the reveal-gated projections (`arena_core.events.load`)."""
        raw = await self.obj("select arena.harness_trial_state(%s)::text", (trial,))
        return HarnessTrialState(
            public_packet=None if raw["public_packet"] is None else dict(raw["public_packet"]),
            open_question=bool(raw["open_question"]),
            released=[dict(r) for r in raw["released"]],
            coach_events=[
                CoachEvent(int(e["seq"]), str(e["kind"]), int(e["turn_no"]), dict(e["payload"]))
                for e in raw["coach_events"]
            ],
        )

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
