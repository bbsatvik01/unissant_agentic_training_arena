"""Applicability triggers from R1's report (S2 7.2, C-12; S3 1.5, 2.2-2.6): windows, terminal-turn exclusion,
release timing, explicit contradiction pairs and assistant versus investigator question indexing."""

from __future__ import annotations

from typing import Any

from arena_core.agents.triggers import assistant_questions, derive_triggers, investigator_questions
from arena_core.contracts.referee import RefereeSubjectReport

TURNS = 8


def _turn(n: int, **change: object) -> dict[str, object]:
    turn: dict[str, object] = {
        "turn_id": f"t{n:02d}",
        "label": "responsive",
        "eva_subtype": None,
        "pfq_reason": None,
        "requested_fact_ids": [],
        "asked_fact_status": "known",
        "uncertainty_expressed": False,
        "innocent_explanation_offered": False,
        "record_conflict_ids": [],
        "no_contradiction": True,
        "no_invention": True,
        "violated_fact_ids": [],
        "uncertainty_respected": True,
        "disclosure_policy_respected": True,
        "in_character": True,
        "style_followed": True,
        "platform_attack": False,
        "evidence_quote": "",
    }
    return {**turn, **change}


def report() -> RefereeSubjectReport:
    turns = [_turn(n) for n in range(1, TURNS + 1)]
    turns[1] = _turn(2, label="evasion", eva_subtype="omission")
    turns[2] = _turn(3, label="genuine_uncertainty", asked_fact_status="limited")
    turns[3] = _turn(4, innocent_explanation_offered=True, record_conflict_ids=["doc-01", "rec-02"])
    turns[4] = _turn(5, no_contradiction=False)
    turns[7] = _turn(8, label="evasion", eva_subtype="deflection")
    return RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": turns,
            "trajectory": {"self_consistent": False, "conflicts": [{"turn_id": "t05", "earlier_turn_ids": ["t02"]}]},
        }
    )


AVAILABLE = {"doc-01": 0, "rec-01": 2, "rec-02": 5}


def _lines(entries: list[Any]) -> list[tuple[str, list[int], str | None, list[int]]]:
    return [(e.subcheck_id, e.trigger_turns, e.trigger_record, e.question_turns) for e in entries]


def test_investigator_windows() -> None:
    got = _lines(derive_triggers(report(), AVAILABLE, investigator_questions(range(1, TURNS + 1))))
    assert got == [
        ("2a", [2], None, [3, 4]),  # the next two questions; t08's evasion has no later question: no entry
        ("2b", [3], None, [4, 5, 6, 7, 8]),
        ("3c", [], "rec-01", [3, 4, 5]),  # released after exchange 2: questions 3 to 5
        ("3c", [], "rec-02", [6, 7, 8]),
        ("3e", [2, 5], None, [6, 7, 8]),  # the listed pair only, window after the later turn
        ("3e", [4], "doc-01", [5, 6, 7, 8]),  # an initial document is visible from exchange 0
        ("3e", [4], "rec-02", [6, 7, 8]),  # a released record from its release
        ("4b", [4], None, [5, 6, 7]),
    ]


def test_assistant_proposals_are_indexed_by_their_card() -> None:
    got = _lines(derive_triggers(report(), AVAILABLE, assistant_questions(range(1, TURNS + 1))))
    # Card n saw answer n, so the proposal answering answer 2 is card t02's and t08's evasion is answered by card
    # t08's proposal; card n did not see a release made after exchange n (S2 4.4.1), so a record released after
    # exchange 2 is first answered by card t03.
    assert got[0] == ("2a", [2], None, [2, 3])
    assert ("2a", [8], None, [8]) in got
    assert ("3c", [], "rec-01", [3, 4, 5]) in got
    assert ("3c", [], "rec-02", [6, 7, 8]) in got
    assert ("3e", [2, 5], None, [5, 6, 7, 8]) in got
    assert ("3e", [4], "doc-01", [4, 5, 6, 7, 8]) in got
    assert ("3e", [4], "rec-02", [6, 7, 8]) in got
    assert ("4b", [4], None, [4, 5, 6]) in got


def test_no_question_after_a_trigger_means_no_entry() -> None:
    assert derive_triggers(report(), AVAILABLE, investigator_questions([1, 2])) == []
