"""Applicability triggers for R2 and R3's `r3_investigator` call, derived by code from R1's report (S2 7.2, C-12;
S3 1.5, 2.2-2.6).

Each trigger names a sub-check, its trigger turn, turn pair, record or turn-record pair, and the questions of the
scored sequence that judge it; IDs only, never a label word. The windows are S3's:

| Sub-check | Trigger | Questions to judge |
| --- | --- | --- |
| 2a | an answer labeled `evasion` | the next two questions |
| 2b | an answer labeled `genuine_uncertainty` | every later question |
| 3c | a record released (`released_after` exchanges) | the next three questions after the release |
| 3e | a visible contradiction (`contracts.adapter.contradiction_triggers`) | every later question |
| 4b | an answer with `innocent_explanation_offered` | the next three questions |

A visible contradiction is a turn pair exactly as `trajectory.conflicts` lists it, or a turn and a visible
document; its window opens after the later of the two.

"Questions" are the scored sequence's own (S3 2.2): an investigator's questions, or an assistant's proposals.
`questions` maps each question's turn label (the ID the referee report keys it by: the question's turn for an
investigator, the proposing card's turn for an assistant) to what it was written knowing: the answers and the
releases it saw. A card sees its own turn's answer but not a release made after that exchange (S2 4.4.1), so an
answer-driven window can start at the same card while a record-driven one starts at the next. A trigger with no
question after it is not applicable (S3 2.2) and gets no entry.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from arena_core.contracts.adapter import contradiction_triggers
from arena_core.contracts.common import turn_no
from arena_core.contracts.referee import RefereeSubjectReport
from arena_core.contracts.review import TriggerEntry

NEXT_TWO = 2
NEXT_THREE = 3


# What a question was written knowing: (answers seen, releases seen), in exchanges.
Timing = tuple[int, int]


def assistant_questions(card_turns: Iterable[int]) -> dict[int, Timing]:
    """The proposal on the card of turn n saw answers 1..n and the records released before question n
    (`released_after <= n - 1`, S2 4.4.1); it is asked (or would be) at exchange n + 1."""
    return {n: (n, n - 1) for n in card_turns}


def investigator_questions(turns: Iterable[int]) -> dict[int, Timing]:
    """The investigator's question of turn n is written after n - 1 exchanges and their releases."""
    return {n: (n - 1, n - 1) for n in turns}


def _window(questions: Mapping[int, Timing], answers: int, releases: int, limit: int | None) -> list[int]:
    """The first `limit` questions, in order, written after seeing answer `answers` and release `releases`."""
    seen = [label for label in sorted(questions) if questions[label][0] >= answers and questions[label][1] >= releases]
    return seen[:limit]


def derive_triggers(
    report: RefereeSubjectReport,
    available_after: Mapping[str, int],
    questions: Mapping[int, Timing],
) -> list[TriggerEntry]:
    """Every trigger S3's applicability rules produce for one trial, in sub-check order.

    `available_after`: each visible document's availability, 0 for an initial document and the release exchange for
    a released record (the same population the citation check uses, D5). A question answers an answer-driven
    trigger once it was written after that answer, and a record-driven one once it was written after the release."""
    entries: list[TriggerEntry] = []

    def add(subcheck: str, turns: list[int], record: str | None, limit: int | None) -> None:
        answers = max(turns, default=0)
        releases = available_after[record] if record is not None else 0
        window = _window(questions, answers, releases, limit)
        if window:
            entries.append(
                TriggerEntry(subcheck_id=subcheck, trigger_turns=turns, trigger_record=record, question_turns=window)
            )

    for t in report.turns:
        if t.label == "evasion":
            add("2a", [turn_no(t.turn_id)], None, NEXT_TWO)
    for t in report.turns:
        if t.label == "genuine_uncertainty":
            add("2b", [turn_no(t.turn_id)], None, None)
    for record, _after in sorted(available_after.items(), key=lambda x: (x[1], x[0])):
        if record.startswith("rec-"):
            add("3c", [], record, NEXT_THREE)
    for c in contradiction_triggers(report, available_after):
        add("3e", list(c.turns), c.record_id, None)
    for t in report.turns:
        if t.innocent_explanation_offered:
            add("4b", [turn_no(t.turn_id)], None, NEXT_THREE)
    return entries
