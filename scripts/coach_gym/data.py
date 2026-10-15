"""Coach Gym dataset builder (`make coach-gym-dataset`): DEV-split trials only, as `arena_referee`.

Every query joins the trial to its family and filters `f.split = 'dev'` in SQL, so a hidden trial is never read:
the trial list cannot return one, and a direct read of a hidden trial id (`fetch_trial`) finds nothing and raises
`HiddenSplitError` (proved against the real migrated database in `tools/tests/it_coach_gym.py`).
`arena_core.coachgym.examples.build_examples` refuses a non-dev trial once more.

Read per trial: the public packet and the variant's role (`sealed.evaluator_packets.role`, the ground truth),
answered turns, released records, R1's stored labels (`sealed.judgments`, `<trial>:referee_subject`; a replay
trial's are its source corpus transcript's) and the human T-LAB calibration labels of that same transcript (the
source's and the replay's own; a turn takes the human label only when every human who rated it agrees). Also
the dev variants' private and evaluator canaries, which the cheat check must never find in a candidate or a
lesson.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from arena_core.coachgym.examples import HiddenSplitError, Role, TrialRecord
from arena_core.contracts.adapter import adapt_subject_report
from arena_core.contracts.common import turn_no
from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.contracts.review import LabelSubmission
from arena_core.db.pool import Connector, one_statement

# Every statement joins the trial (`t`) to its family and carries the dev-only predicate `f.split = 'dev'`
# (spelled out in each literal; `tools/tests/test_coach_gym_data.py` checks every one of them).
LIST_TRIALS = (
    "select t.id from arena.trials t"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev'"
    " and exists (select 1 from arena.turns u where u.trial_id = t.id and u.answer is not null)"
    " order by t.created_at, t.id"
)
TRIAL = (
    "select f.family_code, f.split, ep.role, pp.packet, coalesce(t.source_trial_id, t.id) from arena.trials t"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " join sealed.evaluator_packets ep on ep.variant_id = t.variant_id"
    " join arena.public_packets pp on pp.variant_id = t.variant_id"
    " where f.split = 'dev' and t.id = %s"
)
TURNS = (
    "select u.turn_no, u.question, u.answer from arena.turns u join arena.trials t on t.id = u.trial_id"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev' and u.trial_id = %s and u.answer is not null order by u.turn_no"
)
RELEASED = (
    "select r.record_id, r.title, r.content, r.released_after_exchanges"
    " from arena.released_evidence r join arena.trials t on t.id = r.trial_id"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev' and r.trial_id = %s order by r.release_seq"
)
R1 = (
    "select j.payload from sealed.judgments j join arena.trials t on t.id = j.trial_id"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev' and j.idempotency_key = %s"
)
HUMAN_LABELS = (
    "select j.payload from sealed.judgments j join arena.trials t on t.id = j.trial_id"
    " join arena.case_variants v on v.id = t.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev' and j.trial_id = any(%s) and j.kind = 'calibration' and j.payload ->> 'task' = 'T-LAB'"
    " order by j.created_at"
)
CANARIES = (
    "select ep.packet ->> 'canary', sp.packet ->> 'canary' from sealed.evaluator_packets ep"
    " join subject.private_packets sp on sp.variant_id = ep.variant_id"
    " join arena.case_variants v on v.id = ep.variant_id join arena.case_families f on f.id = v.family_id"
    " where f.split = 'dev'"
)

# The SQL above, in one tuple, so a test can assert every statement carries the dev predicate.
STATEMENTS = (LIST_TRIALS, TRIAL, TURNS, RELEASED, R1, HUMAN_LABELS, CANARIES)


async def _rows(connect: Connector, query: str, params: Sequence[object] = ()) -> list[tuple[Any, ...]]:
    async with connect() as conn:
        cur = await one_statement(conn, query, params)
        return list(await cur.fetchall())


async def dev_trial_ids(connect: Connector) -> list[str]:
    return [str(r[0]) for r in await _rows(connect, LIST_TRIALS)]


def referee_labels(payload: Mapping[str, Any] | None) -> dict[int, str]:
    """R1's per-turn labels through the one S2-to-S3 adapter; none when the trial was never judged."""
    if payload is None:
        return {}
    report = RefereeSubjectReport.model_validate(payload["report"])
    labels = adapt_subject_report(report, frozenset(payload.get("quote_invalid", ())))
    return {t: lab.label for t, lab in labels.items()}


def human_labels(payloads: Sequence[Mapping[str, Any]]) -> dict[int, str]:
    """The T-LAB labels every rater of a turn agrees on (a split vote leaves the turn to the referee)."""
    votes: dict[int, set[str]] = defaultdict(set)
    for payload in payloads:
        for verdict in LabelSubmission.model_validate(payload).turns:
            votes[turn_no(verdict.turn_id)].add(verdict.label)
    return {t: next(iter(v)) for t, v in sorted(votes.items()) if len(v) == 1}


async def fetch_trial(connect: Connector, trial_id: str) -> TrialRecord:
    """One dev trial; a hidden (or unknown) trial id finds nothing and is refused."""
    tid = UUID(trial_id)
    found = await _rows(connect, TRIAL, (tid,))
    if not found:
        msg = f"trial {trial_id} is not a dev-split trial (or does not exist); refused"
        raise HiddenSplitError(msg)
    family_code, split, role, packet, r1_trial = found[0]
    turns = await _rows(connect, TURNS, (tid,))
    released = await _rows(connect, RELEASED, (tid,))
    r1 = await _rows(connect, R1, (f"{r1_trial}:referee_subject",))
    # Human labels of the same transcript: a replay's source corpus transcript's (as for R1) and its own.
    humans = await _rows(connect, HUMAN_LABELS, (sorted({tid, UUID(str(r1_trial))}, key=str),))
    return TrialRecord(
        trial_id=trial_id,
        family_code=str(family_code),
        split=str(split),
        role=cast("Role", role),
        public_packet=packet,
        released=[{"record_id": r[0], "title": r[1], "content": r[2], "after_exchanges": int(r[3])} for r in released],
        transcript=[{"turn_no": int(r[0]), "question": r[1], "answer": r[2]} for r in turns],
        referee_labels=referee_labels(r1[0][0] if r1 else None),
        human_labels=human_labels([r[0] for r in humans]),
    )


@dataclass(frozen=True)
class DevData:
    trials: list[TrialRecord]
    canaries: list[str]


async def fetch_dev_data(connect: Connector) -> DevData:
    trials = [await fetch_trial(connect, t) for t in await dev_trial_ids(connect)]
    canaries = sorted({c for row in await _rows(connect, CANARIES) for c in row if c})
    return DevData(trials, canaries)
