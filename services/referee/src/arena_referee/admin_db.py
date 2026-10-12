"""The admin console's reads and lifecycle calls (S5 5.5 admin table; S6 4.13), as `arena_referee`.

Every lifecycle step is the S4 function itself (`arena.create_tournament`, `add_planned_trials`,
`freeze_tournament`, `close_tournament_run`, `begin_scoring`, `ledger.adjudicate_validity`), each idempotent in
the database; nothing here decides a transition. The reveal preconditions are read as booleans in the order and
with the rules of `ledger.check_reveal_preconditions` (S4 6), so the console can show which one blocks reveal
before the admin presses it; reveal itself re-checks them in the database.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection

from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.db.pool import Connector
from arena_core.referee.pipeline import decide_validity
from arena_core.referee.validity_review import ValidityReviewInputs, build_validity_review

_TOURNAMENTS_SQL = (
    "select id, name, split, status, seed, max_exchanges, roster_sha256, created_at, revealed_at from arena.tournaments"
)


def _tournament(row: tuple[Any, ...]) -> dict[str, Any]:
    keys = ("id", "name", "split", "status", "seed", "max_exchanges", "roster_sha256", "created_at", "revealed_at")
    out = dict(zip(keys, row, strict=True))
    out["id"] = str(out["id"])
    for key in ("created_at", "revealed_at"):
        out[key] = None if out[key] is None else out[key].isoformat()
    return out


async def budget(connect: Connector) -> list[dict[str, Any]]:
    """`ops.budget_status()`: per-bucket ceiling, liability, open holds, headroom and the kill switch (money as
    decimal strings, never floats)."""
    async with connect() as conn:
        cur = await conn.execute(
            "select bucket, parent, ceiling_usd, liability_usd, open_usd, headroom_usd, kill_switch"
            " from ops.budget_status() order by bucket"
        )
        rows = await cur.fetchall()
    return [
        {
            "bucket": r[0],
            "parent": r[1],
            "ceiling_usd": str(r[2]),
            "liability_usd": str(r[3]),
            "open_usd": str(r[4]),
            "headroom_usd": str(r[5]),
            "kill_switch": bool(r[6]),
        }
        for r in rows
    ]


async def tournaments(connect: Connector) -> list[dict[str, Any]]:
    async with connect() as conn:
        cur = await conn.execute(_TOURNAMENTS_SQL + " order by created_at")
        return [_tournament(r) for r in await cur.fetchall()]


async def tournament(connect: Connector, tournament_id: UUID) -> dict[str, Any] | None:
    async with connect() as conn:
        cur = await conn.execute(_TOURNAMENTS_SQL + " where id = %s", (tournament_id,))
        row = await cur.fetchone()
    return None if row is None else _tournament(row)


# ledger.check_reveal_preconditions' checks as booleans, in its order (S4 6). first_unverified_finalization is
# not granted to arena_referee, so the commitment check applies its population (every trial_finalized event of the
# tournament and every completed terminal record) and its predicate (ledger.verify_commitment) here.
_PRECONDITIONS_SQL = """
select t.status = 'scoring',
       t.roster_sha256 is not null and t.roster_sha256 = arena.roster_digest(t.id),
       not exists (select 1 from ledger.planned_execution(t.id) e where e.state is null),
       not exists (select 1 from ledger.planned_execution(t.id) e
                    where e.track in ('interactive', 'replay_corpus') and e.state in ('completed', 'assistant_failed')
                      and not exists (select 1 from ledger.validity_adjudications a where a.trial_id = e.trial_id)),
       not exists (select 1 from arena.planned_trials where tournament_id = t.id and track = 'replay_corpus')
         or exists (select 1 from ledger.corpus_seals s, ledger.corpus_digest(t.id) d
                     where s.tournament_id = t.id and s.corpus_sha256 = d.corpus_sha256),
       not exists (select 1 from (select e.trial_id from ledger.events e
                                   where e.event_type = 'trial_finalized' and e.tournament_id = t.id
                                  union
                                  select r.trial_id from ledger.terminal_records r
                                    join arena.trials x on x.id = r.trial_id
                                   where x.tournament_id = t.id and r.state = 'completed') f
                    where not ledger.verify_commitment(f.trial_id)),
       t.split <> 'hidden' or sealed.verify_hidden_seal(),
       ledger.verify_chain() is null
  from arena.tournaments t where t.id = %s
"""
PRECONDITION_NAMES = (
    "status_scoring",
    "roster_frozen",
    "every_trial_recorded",
    "subject_reviews_resolved",
    "replay_corpus_sealed",
    "commitments_verify",
    "hidden_split_seal_verifies",
    "ledger_chain_verifies",
)


async def reveal_preconditions(connect: Connector, tournament_id: UUID) -> list[dict[str, Any]]:
    async with connect() as conn:
        cur = await conn.execute(_PRECONDITIONS_SQL, (tournament_id,))
        row = await cur.fetchone()
    if row is None:
        return []
    return [{"name": name, "passed": bool(passed)} for name, passed in zip(PRECONDITION_NAMES, row, strict=True)]


async def progress(connect: Connector, tournament_id: UUID) -> list[dict[str, Any]]:
    """`arena.v_tournament_progress`: counts per track and block (no trial id)."""
    async with connect() as conn:
        cur = await conn.execute(
            "select track, block_no, planned, running, ended, states::text from arena.v_tournament_progress"
            " where tournament_id = %s order by track, block_no",
            (tournament_id,),
        )
        rows = await cur.fetchall()
    return [
        {"track": r[0], "block": r[1], "planned": r[2], "running": r[3], "ended": r[4], "states": json.loads(r[5])}
        for r in rows
    ]


async def call(connect: Connector, sql: str, params: tuple[object, ...]) -> object:
    """One S4 lifecycle function in its own transaction; its value (or None)."""
    async with connect() as conn, conn.transaction():
        cur = await conn.execute(sql, params)
        row = await cur.fetchone()
    return None if row is None else row[0]


_ROSTER_KEYS = ("track", "block_no", "variant_id", "assistant_candidate_id", "subject_candidate_id", "repeat")


async def roster_has(connect: Connector, tournament_id: UUID, rows: list[dict[str, Any]]) -> bool:
    """Whether every submitted roster row is already planned, every field it names equal (its position, track,
    block, variant, candidates, repeat and replay source): only an identical repeat is a no-op."""
    async with connect() as conn:
        cur = await conn.execute(
            "select p.position, p.track, b.block_no, p.variant_id::text, p.assistant_candidate_id::text,"
            " p.subject_candidate_id::text, p.repeat, s.position"
            " from arena.planned_trials p left join arena.blocks b on b.id = p.block_id"
            " left join arena.planned_trials s on s.id = p.source_planned_trial_id where p.tournament_id = %s",
            (tournament_id,),
        )
        planned = {
            int(r[0]): {**dict(zip(_ROSTER_KEYS, r[1:7], strict=True)), "source_position": r[7]}
            for r in await cur.fetchall()
        }
    for row in rows:
        position = row.get("position")
        have = planned.get(position) if isinstance(position, int) else None
        if have is None:
            return False
        for key, value in row.items():
            if key == "position":
                continue
            if key not in have or str(have[key]) != str(value):
                return False
    return True


@dataclass(frozen=True)
class Verdict:
    trial_id: UUID
    verdict: str
    reason: str
    evidence_ref: str
    decided_by: str
    idempotency_key: str


async def adjudicate(connect: Connector, v: Verdict) -> str:
    """`ledger.adjudicate_validity` (S3 4.2 item 2): the human verdict, idempotent on its key."""
    value = await call(
        connect,
        "select ledger.adjudicate_validity(%s, %s, %s, %s, %s, %s)::text",
        (v.trial_id, v.verdict, v.reason, v.evidence_ref, v.decided_by, v.idempotency_key),
    )
    return str(value)


# S3 4.2 item 2: a proposed subject_invalid (no verdict yet: a valid proposal is adjudicated automatically), and a
# sample of the automatic valid verdicts (one trial in ten, by a hash of its id, so the sample is reproducible)
# until a human verdict joins the automatic one.
_PENDING_SQL = """
select e.trial_id, j.payload::text, t.id,
       case when exists (select 1 from ledger.validity_adjudications a where a.trial_id = e.trial_id)
            then 'valid' else 'subject_invalid' end
  from arena.tournaments t
  cross join lateral ledger.planned_execution(t.id) e
  join sealed.judgments j on j.idempotency_key = e.trial_id::text || ':referee_subject'
 where e.track in ('interactive', 'replay_corpus') and e.state in ('completed', 'assistant_failed')
   and (not exists (select 1 from ledger.validity_adjudications a where a.trial_id = e.trial_id)
        or (('x' || substr(md5(e.trial_id::text), 1, 8))::bit(32)::bigint % 10 = 0
            and exists (select 1 from ledger.validity_adjudications a
                         where a.trial_id = e.trial_id and a.decided_by = 'auto_rule')
            and not exists (select 1 from ledger.validity_adjudications a
                             where a.trial_id = e.trial_id and a.decided_by <> 'auto_rule')))
 order by e.trial_id
"""


async def pending_reviews(connect: Connector) -> list[dict[str, Any]]:
    """S3 4.2 item 2's queue: every executed subject trial whose R1 is stored and that has no verdict yet (a
    `valid` proposal is adjudicated automatically, so what is left is a proposed `subject_invalid`). Blinded: the
    view carries no assistant identity, card or finding (AC-S3-4.4)."""
    async with connect() as conn:
        cur = await conn.execute(_PENDING_SQL)
        pending = await cur.fetchall()
        out = []
        for trial_id, payload, tournament_id, proposed in pending:
            review = await _review(conn, trial_id, json.loads(payload), proposed)
            out.append({**review, "tournament_id": str(tournament_id)})
    return out


async def _review(
    conn: AsyncConnection[Any], trial_id: UUID, payload: Mapping[str, Any], proposed: str
) -> dict[str, Any]:
    report = RefereeSubjectReport.model_validate(payload.get("report", payload))
    cur = await conn.execute(
        "select turn_no, question, answer from arena.turns where trial_id = %s order by turn_no", (trial_id,)
    )
    turns = await cur.fetchall()
    cur = await conn.execute(
        "select record_id, title, content::text from arena.released_evidence where trial_id = %s order by release_seq",
        (trial_id,),
    )
    released = await cur.fetchall()
    cur = await conn.execute(
        "select p.packet::text, e.packet::text from arena.trials t"
        " join subject.private_packets p on p.variant_id = t.variant_id"
        " join sealed.evaluator_packets e on e.variant_id = t.variant_id where t.id = %s",
        (trial_id,),
    )
    packets = await cur.fetchone()
    packet = json.loads(packets[0]) if packets else {}
    evaluator = json.loads(packets[1]) if packets else {}
    questions = {int(n): str(q) for n, q, _ in turns}
    answers = {int(n): str(a or "") for n, _, a in turns}
    # The deciding turns of S3 4.2's canonical rule (the same `decide_validity` R1's scoring applies).
    deciding = list(decide_validity(report, evaluator).deciding_turns) if evaluator else []
    view = build_validity_review(
        ValidityReviewInputs(
            trial_id=str(trial_id),
            proposed_verdict=proposed,
            deciding_turn_ids=deciding,
            report=report,
            questions=questions,
            answers=answers,
        )
    )
    return {
        "trial_id": str(trial_id),
        "proposed": proposed,
        "reasons": deciding,
        "evidence_ref": f"{trial_id}:referee_subject",
        "transcript": [{"turn_no": int(n), "question": q, "answer": a} for n, q, a in turns],
        "released": [{"record_id": r, "title": t, "content": json.loads(c)} for r, t, c in released],
        "facts": [{"id": f["id"], "text": f["text"]} for f in packet.get("facts", [])],
        # What compliance is judged against (S3 4.2 item 2): the whole private packet (persona, facts with their
        # classes, unknown facts, uncertainty, gates, behaviors, forbidden assertions) but its isolation canary.
        # Never the assistant's identity, cards or finding.
        "private_packet": {key: value for key, value in packet.items() if key != "canary"},
        "evidence": [
            {
                "turn_id": t.turn_id,
                "evidence_quote": t.evidence_quote,
                "failed_checks": list(t.failed_checks),
                "violated_fact_ids": list(t.violated_fact_ids),
            }
            for t in view.turns  # every reviewed turn, with R1's quote, also when no check failed
        ],
    }
