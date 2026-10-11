"""The referee's real database IO (S4 4.1-4.4, 4.2 grants already in place: `arena_referee` reads every
table of `arena`, `subject`, `sealed`, `training` and `ops`, and holds the write functions WP-14 and WP-16
add -- `ledger.reveal`, `ledger.seal_corrected_manifest`, the `arena.isolation_checks` insert and the
`arena.leaderboards` insert). One short-lived connection per operation (`Connector`, S5 6.4); the pooled
connector lands with WP-13.

This is the one module that touches `psycopg`; everything above it (`mapping`, `scoring`, `debrief`,
`isolation`, `leaderboard`) is pure and takes plain rows. Deliberately thin: each function is close to its
SQL, so a reviewer can check it against the schema directly.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.db.pool import Connector
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall
from arena_core.scoring.inclusion import Exec
from arena_core.scoring.ranking import IG_ITEMS, IsolationResult, isolation_result
from arena_core.scoring.rubric import RubricResult
from arena_referee.debrief import DebriefDeps, DebriefProvenance, SessionInfo
from arena_referee.mapping import TrialData
from arena_referee.scoring import ScoringDeps

# ---------------------------------------------------------------- trial context (reads)


_PACKET_QUERIES: Mapping[str, str] = {
    "subject.private_packets": "select packet from subject.private_packets where variant_id = %s",
    "arena.public_packets": "select packet from arena.public_packets where variant_id = %s",
    "sealed.hidden_public_packets": "select packet from sealed.hidden_public_packets where variant_id = %s",
}


async def _packet_row(connect: Connector, table: str, variant_id: UUID) -> Mapping[str, Any] | None:
    query = _PACKET_QUERIES[table]
    async with connect() as conn:
        cur = await conn.execute(query, (variant_id,))
        row = await cur.fetchone()
        return cast("Mapping[str, Any] | None", row[0] if row else None)


async def fetch_trial_kind(connect: Connector, trial_id: str) -> str | None:
    """`arena.trials.kind` ('training', 'interactive', 'replay_corpus' or 'replay'), or None if the trial
    does not exist. A separate, cheap lookup from `fetch_trial_data` (shared by the interactive scoring
    route and R3's training-session path, so it cannot itself refuse a kind) -- `score.py`'s route uses
    this to refuse a corpus or replay trial with a clear error instead of mis-scoring it (S5 5.3)."""
    async with connect() as conn:
        cur = await conn.execute("select kind from arena.trials where id = %s", (UUID(trial_id),))
        row = await cur.fetchone()
        return cast("str | None", row[0] if row else None)


async def fetch_trial_data(connect: Connector, trial_id: str) -> TrialData:
    """Everything one trial's R1/R2 (or R3's two calls) read (S2 7.1-7.3, 7.5), already fetched."""
    trial_uuid = UUID(trial_id)
    async with connect() as conn:
        cur = await conn.execute(
            "select t.variant_id, f.split from arena.trials t"
            " join arena.case_variants v on v.id = t.variant_id"
            " join arena.case_families f on f.id = v.family_id"
            " where t.id = %s",
            (trial_uuid,),
        )
        row = await cur.fetchone()
    if row is None:
        msg = f"no trial {trial_id}"
        raise LookupError(msg)
    variant_id, split = row[0], cast("Literal['dev', 'hidden']", row[1])

    async with connect() as conn:
        cur = await conn.execute("select packet from sealed.evaluator_packets where variant_id = %s", (variant_id,))
        evaluator_row = await cur.fetchone()
    if evaluator_row is None:
        msg = f"no evaluator packet for variant {variant_id}"
        raise LookupError(msg)
    canonical_facts = evaluator_row[0]["canonical_facts"]

    private_packet = await _packet_row(connect, "subject.private_packets", variant_id)
    public_packet = await _packet_row(connect, "arena.public_packets", variant_id)
    if public_packet is None:
        public_packet = await _packet_row(connect, "sealed.hidden_public_packets", variant_id)
    if private_packet is None or public_packet is None:
        msg = f"variant {variant_id} is missing its private or public packet"
        raise LookupError(msg)

    async with connect() as conn:
        cur = await conn.execute(
            "select record_id, title, content, released_after_exchanges"
            " from arena.released_evidence where trial_id = %s order by release_seq",
            (trial_uuid,),
        )
        released = [
            {"record_id": r[0], "title": r[1], "content": r[2], "released_after": r[3], "date": None}
            for r in await cur.fetchall()
        ]

    async with connect() as conn:
        # `answer is not null`: a turn can exist with no answer yet (SG2-39's subject_quarantined leaves a
        # row with a null answer and answered_at, turn_answer_shape); the referee's transcript is committed
        # exchanges only (S2 6.10's "no answer to label when the first turn was quarantined" is exactly the
        # zero-row case this filter produces), matching `empty_subject_report()`'s "no transcript" branch
        # and `TranscriptTurn`'s non-null `answer`.
        cur = await conn.execute(
            "select turn_no, question, answer, question_source from arena.turns"
            " where trial_id = %s and answer is not null order by turn_no",
            (trial_uuid,),
        )
        transcript = [
            {"turn_no": r[0], "question": r[1], "answer": r[2], "question_source": r[3]} for r in await cur.fetchall()
        ]

    async with connect() as conn:
        cur = await conn.execute(
            "select payload from arena.trial_events where trial_id = %s and kind = 'coach_card' order by seq",
            (trial_uuid,),
        )
        cards = [r[0] for r in await cur.fetchall()]

    async with connect() as conn:
        cur = await conn.execute("select finding from arena.final_findings where trial_id = %s", (trial_uuid,))
        finding_row = await cur.fetchone()
    final_finding = finding_row[0] if finding_row else None

    return TrialData(
        trial_id=trial_id,
        split=split,
        canonical_facts=canonical_facts,
        private_packet=private_packet,
        public_packet=public_packet,
        released=released,
        transcript=transcript,
        cards=cards,
        final_finding=final_finding,
    )


# ---------------------------------------------------------------- sealed writes (S2 7.2, S3 4.2)


async def get_judgment(connect: Connector, idempotency_key: str) -> Mapping[str, Any] | None:
    async with connect() as conn:
        cur = await conn.execute("select payload from sealed.judgments where idempotency_key = %s", (idempotency_key,))
        row = await cur.fetchone()
        return cast("Mapping[str, Any] | None", row[0] if row else None)


async def store_labels(
    connect: Connector, trial_id: str, labeler: str, rows: list[dict[str, Any]], prompt_sha256: str
) -> None:
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "select sealed.record_independent_labels(%s, %s, %s, %s)",
            (UUID(trial_id), labeler, Jsonb(rows), prompt_sha256),
        )


@dataclass(frozen=True, kw_only=True)
class JudgmentRow:
    trial_id: str
    kind: str
    rater_id: str | None
    payload: Mapping[str, Any]
    prompt_sha256: str | None
    idempotency_key: str


async def store_judgment(connect: Connector, row: JudgmentRow) -> None:
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "select sealed.record_judgment(%s, %s, %s, %s, %s, %s)",
            (
                UUID(row.trial_id),
                row.kind,
                row.rater_id,
                Jsonb(dict(row.payload)),
                row.prompt_sha256,
                row.idempotency_key,
            ),
        )


async def adjudicate_valid(connect: Connector, trial_id: str, reason: str, evidence_ref: str) -> None:
    """S3 4.2 item 1: the automatic `valid` verdict, `decided_by='auto_rule'`, idempotent on the evidence
    reference (the R1 stage key), so a resumed call reaches the same adjudication."""
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "select ledger.adjudicate_validity(%s, 'valid', %s, %s, 'auto_rule', %s)",
            (UUID(trial_id), reason, evidence_ref, f"{evidence_ref}:validity"),
        )


def make_scoring_deps(connect: Connector, port: AgentPort, prompt_sha256: str) -> ScoringDeps:
    """`ScoringDeps` wired to the real database and agent port."""

    async def _fetch(trial_id: str) -> TrialData:
        return await fetch_trial_data(connect, trial_id)

    async def _get(key: str) -> Mapping[str, Any] | None:
        return await get_judgment(connect, key)

    async def _store_labels(trial_id: str, labeler: str, rows: list[dict[str, Any]], _prompt_sha256: str) -> None:
        await store_labels(connect, trial_id, labeler, rows, prompt_sha256)

    async def _store_judgment(
        trial_id: str, kind: str, rater_id: str | None, payload: Mapping[str, Any], idempotency_key: str
    ) -> None:
        await store_judgment(
            connect,
            JudgmentRow(
                trial_id=trial_id,
                kind=kind,
                rater_id=rater_id,
                payload=payload,
                prompt_sha256=prompt_sha256,
                idempotency_key=idempotency_key,
            ),
        )

    async def _adjudicate(trial_id: str, reason: str, evidence_ref: str) -> None:
        await adjudicate_valid(connect, trial_id, reason, evidence_ref)

    async def _run_subject(call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        return (await port.run(call)).value

    async def _run_assistant(call: AgentCall[RefereeAssistantReport]) -> RefereeAssistantReport:
        return (await port.run(call)).value

    return ScoringDeps(
        fetch_trial_data=_fetch,
        get_judgment=_get,
        store_labels=_store_labels,
        store_judgment=_store_judgment,
        adjudicate_valid=_adjudicate,
        run_subject_call=_run_subject,
        run_assistant_call=_run_assistant,
        prompt_sha256=prompt_sha256,
    )


# ---------------------------------------------------------------- training session and debrief (S5 5.4)


async def fetch_session(connect: Connector, session_id: str) -> SessionInfo:
    session_uuid = UUID(session_id)
    async with connect() as conn:
        cur = await conn.execute(
            "select s.trial_id, s.voice, t.variant_id, t.status from training.sessions s"
            " join arena.trials t on t.id = s.trial_id where s.id = %s",
            (session_uuid,),
        )
        row = await cur.fetchone()
    if row is None:
        msg = f"no session {session_id}"
        raise LookupError(msg)
    trial_id, voice, variant_id, trial_status = str(row[0]), bool(row[1]), row[2], cast("str", row[3])

    async with connect() as conn:
        cur = await conn.execute("select packet from sealed.evaluator_packets where variant_id = %s", (variant_id,))
        evaluator_row = await cur.fetchone()
    if evaluator_row is None:
        msg = f"no evaluator packet for variant {variant_id}"
        raise LookupError(msg)

    async with connect() as conn:
        cur = await conn.execute("select finding from arena.final_findings where trial_id = %s", (row[0],))
        finding_row = await cur.fetchone()
    committed_finding = None if finding_row is None else StoredFinding.model_validate(finding_row[0])

    return SessionInfo(
        trial_id=trial_id,
        voice=voice,
        trial_status=trial_status,
        evaluator_packet=evaluator_row[0],
        committed_finding=committed_finding,
    )


async def get_debrief(connect: Connector, session_id: str) -> Mapping[str, Any] | None:
    async with connect() as conn:
        cur = await conn.execute("select payload from training.debriefs where session_id = %s", (UUID(session_id),))
        row = await cur.fetchone()
        return cast("Mapping[str, Any] | None", row[0] if row else None)


async def publish_debrief(connect: Connector, session_id: str, payload: Mapping[str, Any]) -> None:
    async with connect() as conn, conn.transaction():
        await conn.execute("select training.publish_debrief(%s, %s)", (UUID(session_id), Jsonb(dict(payload))))


async def store_rubric_score(connect: Connector, session_id: str, result: RubricResult, scorer_ref: str) -> None:
    """`training.rubric_scores`: written only when the rubric is scorable (S5 5.6, SG2-38); idempotent on
    (session, scorer, scorer_ref) through the table's own unique constraint."""
    if not result.scorable:
        return
    rationale = {
        "checks": {check: {"result": r.result, "turns": list(r.turns)} for check, r in sorted(result.checks.items())}
    }
    values = (
        UUID(session_id),
        "proxy",
        scorer_ref,
        result.dimensions["D1"],
        result.dimensions["D2"],
        result.dimensions["D3"],
        result.dimensions["D4"],
        result.dimensions["D5"],
        Jsonb(rationale),
    )
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "insert into training.rubric_scores"
            " (session_id, scorer, scorer_ref, clarity_neutrality, response_relevance, evidence_follow_up,"
            "  alternative_testing, supported_closure, rationale)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " on conflict (session_id, scorer, scorer_ref) do nothing",
            values,
        )


def make_debrief_deps(connect: Connector, scoring: ScoringDeps, provenance: DebriefProvenance) -> DebriefDeps:
    async def _fetch_session(session_id: str) -> SessionInfo:
        return await fetch_session(connect, session_id)

    async def _get_debrief(session_id: str) -> Mapping[str, Any] | None:
        return await get_debrief(connect, session_id)

    async def _publish(session_id: str, payload: Mapping[str, Any]) -> None:
        await publish_debrief(connect, session_id, payload)

    async def _store_rubric_score(session_id: str, result: RubricResult, scorer_ref: str) -> None:
        await store_rubric_score(connect, session_id, result, scorer_ref)

    return DebriefDeps(
        scoring=scoring,
        fetch_session=_fetch_session,
        get_debrief=_get_debrief,
        publish_debrief=_publish,
        store_rubric_score=_store_rubric_score,
        provenance=provenance,
    )


# ---------------------------------------------------------------- blinded trainer review queue (S3 7.3)


@dataclass(frozen=True, kw_only=True)
class NewReviewItem:
    """One task for the sampler or an operator script to assign (S3 7.2-7.3); never exposed to the rater.

    `payload` needs no `item_id`: `create_review_item` sets (or overwrites) it to the id it generates, so
    the stored item's own `item_id` field always matches the row it came from.
    """

    kind: str
    instrument: str | None
    rater_user_id: UUID
    context_trial_id: UUID
    context_session_id: UUID | None
    payload: Mapping[str, Any]


async def create_review_item(connect: Connector, item: NewReviewItem) -> UUID:
    """Generates the item's id here, never in SQL: the payload (`contracts.review`'s `RubricItem` /
    `LabelItem` / `FlagItem`) carries its own required `item_id`, and `get_review_item` hands that payload
    back unchanged, so the row's id and the payload's `item_id` must be set from the same value."""
    item_id = uuid4()
    payload = {**dict(item.payload), "item_id": str(item_id)}
    async with connect() as conn, conn.transaction():
        cur = await conn.execute(
            "select training.create_review_item(%s, %s, %s, %s, %s, %s)",
            (
                item.kind,
                item.instrument,
                item.rater_user_id,
                item.context_trial_id,
                item.context_session_id,
                Jsonb(payload),
            ),
        )
        row = await cur.fetchone()
    if row is None:
        msg = "create_review_item returned no row"
        raise LookupError(msg)
    return cast("UUID", row[0])


async def list_review_items(connect: Connector, rater_user_id: UUID) -> list[Mapping[str, Any]]:
    async with connect() as conn:
        cur = await conn.execute("select training.list_review_items(%s)", (rater_user_id,))
        row = await cur.fetchone()
    return cast("list[Mapping[str, Any]]", row[0] if row else [])


async def get_review_item(connect: Connector, item_id: UUID, rater_user_id: UUID) -> Mapping[str, Any] | None:
    async with connect() as conn:
        cur = await conn.execute("select training.get_review_item(%s, %s)", (item_id, rater_user_id))
        row = await cur.fetchone()
    return cast("Mapping[str, Any] | None", row[0] if row else None)


async def submit_review_item(
    connect: Connector, item_id: UUID, rater_user_id: UUID, submission: Mapping[str, Any]
) -> Mapping[str, Any]:
    async with connect() as conn, conn.transaction():
        cur = await conn.execute(
            "select training.submit_review_item(%s, %s, %s)", (item_id, rater_user_id, Jsonb(dict(submission)))
        )
        row = await cur.fetchone()
    if row is None:
        msg = "submit_review_item returned no row"
        raise LookupError(msg)
    return cast("Mapping[str, Any]", row[0])


# ---------------------------------------------------------------- reveal and corrections (S3 4.4, S4 7.5, WP-16)


@dataclass(frozen=True)
class RevealResult:
    manifest_id: str
    manifest_sha256: str
    manifest_version: int


async def reveal_tournament(connect: Connector, tournament_id: str) -> RevealResult:
    """`ledger.reveal` (S4 6): manifest version 1, published nonces, status `revealed`. A second call is the
    spec's own no-op (RV-15): the same manifest id and hash come back, never a new row."""
    async with connect() as conn, conn.transaction():
        cur = await conn.execute("select ledger.reveal(%s)", (UUID(tournament_id),))
        row = await cur.fetchone()
    result = cast("Mapping[str, Any]", row[0] if row else {})
    return RevealResult(str(result["manifest_id"]), str(result["manifest_sha256"]), 1)


async def seal_corrected_manifest(connect: Connector, tournament_id: str) -> RevealResult:
    """`ledger.seal_corrected_manifest` (S4 6): version n + 1 with `supersedes_id`; v1 never changes. No
    trial line changed (RV-18) returns the latest version with no new row -- the caller never republishes a
    "corrected" board for a manifest id a board already exists for (the table's own `unique(manifest_id,
    board)`, S4 4.2)."""
    async with connect() as conn, conn.transaction():
        cur = await conn.execute("select ledger.seal_corrected_manifest(%s)", (UUID(tournament_id),))
        row = await cur.fetchone()
    result = cast("Mapping[str, Any]", row[0] if row else {})
    return RevealResult(str(result["manifest_id"]), str(result["manifest_sha256"]), int(result["version"]))


# ---------------------------------------------------------------- isolation gate (S3 9, WP-16)

CHECK_NAMES: Mapping[str, str] = {
    "IG-1": "ig1_privilege_tests",
    "IG-2": "ig2_route_tests",
    "IG-3": "ig3_assistant_context",
    "IG-4": "ig4_hidden_text_scan",
    "IG-5": "ig5_commitment_verification",
    "IG-6": "ig6_canary_audit",
}
_IG_ITEM_BY_CHECK_NAME = {v: k for k, v in CHECK_NAMES.items()}


@dataclass(frozen=True, kw_only=True)
class IsolationCheckRow:
    check_name: str
    passed: bool
    evidence_hash: str
    commit_sha: str
    candidate_id: str | None


async def record_isolation_check(connect: Connector, row: IsolationCheckRow) -> None:
    """`arena.isolation_checks` (S4 4.1, S3 9): append-only, one row per item per run. `candidate_id` is set
    only for IG-6's canary attribution (FX-I02); every other item's row carries none."""
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "insert into arena.isolation_checks (candidate_id, check_name, passed, evidence) values (%s, %s, %s, %s)",
            (
                UUID(row.candidate_id) if row.candidate_id else None,
                row.check_name,
                row.passed,
                Jsonb({"hash": row.evidence_hash, "commit_sha": row.commit_sha}),
            ),
        )


async def fetch_isolation_result(connect: Connector, commit_sha: str) -> IsolationResult:
    """The latest row per check name for this commit (S3 9's preamble: `isolation_pass` is scoped to the
    running code version and migration version), folded through WP-15's `isolation_result`."""
    async with connect() as conn:
        cur = await conn.execute(
            "select distinct on (check_name) check_name, passed, evidence ->> 'hash'"
            " from arena.isolation_checks where evidence ->> 'commit_sha' = %s"
            " order by check_name, created_at desc",
            (commit_sha,),
        )
        rows = await cur.fetchall()
    items: dict[str, tuple[bool, str]] = {}
    for check_name, passed, evidence_hash in rows:
        item = _IG_ITEM_BY_CHECK_NAME.get(check_name)
        if item in IG_ITEMS:
            items[item] = (bool(passed), evidence_hash or "")
    return isolation_result(items)


# ---------------------------------------------------------------- leaderboard trial facts (S3 5.3-5.6, WP-16)


@dataclass(frozen=True)
class TrialFacts:
    """One planned trial's raw facts for the leaderboard (S4 `ledger.build_manifest`'s own inputs, read
    again rather than reparsed from the sealed manifest text, so the classification label -- which the
    manifest never carries -- joins in the same query). A replay row's `verdict` is its source corpus
    transcript's (D2); a replay_corpus row has no `assistant_id` and is excluded from every assistant's
    leaderboard (subject-only track)."""

    planned_trial_id: str
    track: str
    assistant_id: str | None
    family_id: str
    role: str
    block_id: str | None
    exec_state: Exec
    verdict: str | None
    classification: str | None
    settled_cost: Decimal


_COACH_PURPOSES = ("coach.card", "coach.deep", "coach.final")


async def fetch_tournament_trial_facts(connect: Connector, tournament_id: str) -> list[TrialFacts]:
    """`ledger.planned_execution` (already a read-only function reveal and the trust center use, S4) gives
    the latest attempt's state and trial id per planned trial; the adjudication lookup mirrors
    `ledger.build_manifest`'s own (a replay row reads its source transcript's). `settled_cost` sums every
    attempt's own coach calls (S5 3.3's `coach.card`/`coach.deep`/`coach.final` purposes) for this planned
    trial -- not only the latest attempt's `trial_id`: an earlier `infra_failed` attempt the candidate was
    still billed for (coach calls made before the retry) is this planned trial's own cost too (M22), never
    dropped just because a later attempt superseded it."""
    async with connect() as conn:
        cur = await conn.execute(
            "select p.id, p.track, p.assistant_candidate_id, f.family_code, ep.role, p.block_id,"
            "       e.state, adj.verdict, ff.classification,"
            "       coalesce((select sum(r.settled_usd) from ops.budget_reservations r"
            "                  where r.trial_id in (select t.id from arena.trials t where t.planned_trial_id = p.id)"
            "                    and r.purpose = any(%s)), 0)"
            "  from arena.planned_trials p"
            "  join arena.case_variants v on v.id = p.variant_id"
            "  join arena.case_families f on f.id = v.family_id"
            "  join sealed.evaluator_packets ep on ep.variant_id = p.variant_id"
            "  join ledger.planned_execution(%s) e on e.planned_trial_id = p.id"
            "  left join lateral ("
            "    select a.verdict from ledger.validity_adjudications a"
            "     where a.trial_id = coalesce("
            "             (select src.trial_id from ledger.planned_execution(%s) src"
            "               where src.planned_trial_id = p.source_planned_trial_id),"
            "             e.trial_id)"
            "     order by a.adj_seq desc limit 1"
            "  ) adj on true"
            "  left join arena.final_findings ff on ff.trial_id = e.trial_id"
            " where p.tournament_id = %s",
            (list(_COACH_PURPOSES), UUID(tournament_id), UUID(tournament_id), UUID(tournament_id)),
        )
        rows = await cur.fetchall()
    return [
        TrialFacts(
            planned_trial_id=str(r[0]),
            track=r[1],
            assistant_id=str(r[2]) if r[2] else None,
            family_id=r[3],
            role=r[4],
            block_id=str(r[5]) if r[5] else None,
            exec_state=Exec(r[6]),
            verdict=r[7],
            classification=r[8],
            settled_cost=Decimal(r[9]),
        )
        for r in rows
    ]


@dataclass(frozen=True, kw_only=True)
class LeaderboardRow:
    tournament_id: str
    manifest_id: str
    board: str
    label: str
    body: Mapping[str, Any]


async def write_leaderboard(connect: Connector, row: LeaderboardRow) -> None:
    """`arena.leaderboards` (S4 4.1-4.2): `original` only on manifest v1, `corrected` only on later versions
    (`arena.tg_leaderboard_label`); append-only, and idempotent on `unique(manifest_id, board)` (RV-18's
    no-op correction never republishes a second row for a manifest id that already has one)."""
    async with connect() as conn, conn.transaction():
        await conn.execute(
            "insert into arena.leaderboards (tournament_id, manifest_id, board, label, body)"
            " values (%s, %s, %s, %s, %s) on conflict (manifest_id, board) do nothing",
            (UUID(row.tournament_id), UUID(row.manifest_id), row.board, row.label, Jsonb(dict(row.body))),
        )


async def fetch_leaderboard(
    connect: Connector, tournament_id: str, *, board: str = "assistant", label: str = "original"
) -> Mapping[str, Any] | None:
    """The published body verbatim (D-020: the read side adds nothing the spec lacks), or `None` before that
    label exists for this tournament (not yet revealed, or not yet corrected). `label='corrected'` can have
    one row per corrected version over the tournament's life (each correction mints a new manifest id,
    `unique(manifest_id, board)` does not collapse them): the highest manifest version wins, never whichever
    row the server happens to return first."""
    async with connect() as conn:
        cur = await conn.execute(
            "select l.body from arena.leaderboards l join ledger.inclusion_manifests m on m.id = l.manifest_id"
            " where l.tournament_id = %s and l.board = %s and l.label = %s"
            " order by m.version desc limit 1",
            (UUID(tournament_id), board, label),
        )
        row = await cur.fetchone()
    return cast("Mapping[str, Any] | None", row[0] if row else None)


async def open_tournament(connect: Connector, tournament_id: str) -> None:
    """`arena.open_tournament` (S4): `frozen` -> `running`. Called only after the isolation gate passes
    (`arena_referee.isolation.open_hidden_tournament`, S1 L9) -- never a standalone action."""
    async with connect() as conn, conn.transaction():
        await conn.execute("select arena.open_tournament(%s)", (UUID(tournament_id),))
