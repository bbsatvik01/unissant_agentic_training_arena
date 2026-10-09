"""The S2-to-S3 scorer adapter (S3 1.3.1-1.3.2; C-04, C-05, SG2-02) on S3's worked example and its fixtures."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

import pytest

from arena_core.contracts.adapter import (
    NO_QUOTE_GIVEN,
    NO_QUOTE_MATCH,
    AdapterError,
    Card,
    Flag,
    adapt_card,
    adapt_subject_report,
    contradiction_triggers,
    flag_key,
    inconsistent_turn_ids,
    verdicts_by_key,
)
from arena_core.contracts.citations import Cite, Record, Turn, content_text, flag_citations_ok
from arena_core.contracts.referee import FlagVerdict, RefereeAssistantReport, RefereeSubjectReport

from .cards import flag, judgment, stored_card

# ---------------------------------------------------------------- S3 5.3 reference scorer (consumer of the adapter)
# Verbatim from S3 5.3 so the adapter is proven against the code that will read it; WP-15's scorer library owns
# the production copy.

STRICT = frozenset({"possible_evasion"})


Key = tuple[str, int, str]
Trial = tuple[Mapping[int, Turn], Mapping[str, Record]]


def emitted_flags(cards: list[Card]) -> list[tuple[int, int, Flag]]:
    return [(c.turn_no, i, f) for c in sorted(cards, key=lambda c: c.turn_no) if c.valid for i, f in enumerate(c.flags)]


def flag_status(
    f: Flag,
    card_turn: int,
    turns: Mapping[int, Turn],
    records: Mapping[str, Record],
    verdicts: Mapping[Key, FlagVerdict],
) -> tuple[bool, str]:
    if not flag_citations_ok(f.kind, list(f.citations), turns, records, card_turn):
        return False, "citation"
    v = verdicts[flag_key(f)]
    if f.demeanor_based or not v.content_based:
        return False, "demeanor"
    if not (v.quote_relevant and v.claim_holds and v.no_outside_facts):
        return False, "claim"
    return True, "supported"


def evasion_counts(
    cards: list[Card],
    labels: Mapping[int, str],
    trial: Trial,
    verdicts: Mapping[Key, FlagVerdict],
    kinds: frozenset[str] = STRICT,
) -> tuple[int, int, int, list[str]]:
    """S3 5.3 `evasion_counts`; the trial's turns and records travel as one pair, and the per-flag outcomes are
    returned beside the counts so a test can name which flag was the true positive."""
    turns, records = trial
    events = {t for t, lab in labels.items() if lab == "evasion"}
    matched: set[int] = set()
    tp = fp = 0
    outcome: list[str] = []
    for turn, _, f in emitted_flags(cards):
        if f.kind not in kinds:
            continue
        ok, _ = flag_status(f, turn, turns, records, verdicts)
        if ok and f.turn_no in events and f.turn_no not in matched:
            matched.add(f.turn_no)
            tp += 1
            outcome.append(f"{f.flag_ref}:TP")
        else:
            fp += 1
            outcome.append(f"{f.flag_ref}:FP")
    return tp, tp + fp, len(events), outcome


# ---------------------------------------------------------------- the S3 2.10.4 assistant trial

A = {
    1: "It was a busy shift.",
    2: "The freezer alarm was going off, so I went in to reset it.",
    3: "I heard it beeping from the corridor.",
    4: "No. I went in because of the alarm.",
    5: "Maybe it was the Lab C panel; it's on the shared wall.",
}
REC02 = {
    "body": "Lab B panel alarm log for the evening of the entry.",
    "table": {"columns": ["Time", "Panel", "Event"], "rows": [["21:00-22:30", "Lab B", "no alarm events 21:00-22:30"]]},
}
TURNS = {n: Turn(a) for n, a in A.items()}
RECORDS = {"rec-02": Record(content_text(REC02), released_after=3)}
LABELS = {1: "evasion", 2: "responsive", 3: "responsive", 4: "responsive", 5: "responsive"}


def _trial_cards() -> list[dict[str, Any]]:
    t01 = stored_card(1, [flag("possible_evasion", "t01", A[1], missing_fact="the task that required entry")])
    t04 = stored_card(
        4,
        [
            flag(
                "evidence_conflict",
                "t03",
                "I heard it beeping from the corridor.",
                conflict_record_id="rec-02",
                conflict_record_quote="no alarm events 21:00-22:30",
            ),
            flag("possible_evasion", "t01", A[1], missing_fact="the task that required entry"),
            flag(
                "possible_evasion",
                "t01",
                "a busy shift",
                missing_fact="why the subject sounded nervous about the entry",
            ),
        ],
        demeanor=(3,),
    )
    return [t01, stored_card(2, []), stored_card(3, []), t04, stored_card(5, [])]


def _verdicts(refs: list[str]) -> RefereeAssistantReport:
    """J3 saw each citation-checked flag once (the duplicate t04.f2 is not sent); every verdict holds."""
    return RefereeAssistantReport(
        schema_version="ref_asst.v2",
        flags=[
            FlagVerdict(flag_ref=r, quote_relevant=True, claim_holds=True, content_based=True, no_outside_facts=True)
            for r in refs
        ],
        followups=[],
        citations=[],
        subchecks=[],
    )


def test_s3_2_10_4_one_true_positive_a_duplicate_and_a_demeanor_false_positive() -> None:
    cards = [adapt_card(c) for c in _trial_cards()]
    verdicts = verdicts_by_key(cards, _verdicts(["t01.f1", "t04.f1", "t04.f3"]))
    tp, flags, events, outcome = evasion_counts(cards, LABELS, (TURNS, RECORDS), verdicts)
    assert (tp, flags, events) == (1, 3, 1)  # precision 1/3, recall 1/1 (S3 2.10.4)
    assert outcome == ["t01.f1:TP", "t04.f2:FP", "t04.f3:FP"]
    t04 = cards[3]
    assert flag_status(t04.flags[2], 4, TURNS, RECORDS, verdicts) == (False, "demeanor")
    assert flag_status(t04.flags[1], 4, TURNS, RECORDS, verdicts) == (True, "supported")  # the duplicate's own
    assert flag_status(t04.flags[0], 4, TURNS, RECORDS, verdicts) == (True, "supported")  # conflict, not evasion


def test_the_duplicate_takes_the_verdict_of_its_first_occurrence() -> None:
    cards = [adapt_card(c) for c in _trial_cards()]
    report = _verdicts(["t01.f1", "t04.f1", "t04.f3"])
    verdicts = verdicts_by_key(cards, report)
    assert flag_key(cards[0].flags[0]) == flag_key(cards[3].flags[1])
    assert verdicts[flag_key(cards[3].flags[1])] is report.flags[0]
    assert set(verdicts) == {flag_key(f) for c in cards for f in c.flags}


def test_the_first_occurrence_wins_even_when_a_duplicate_was_judged_too() -> None:
    cards = [adapt_card(c) for c in _trial_cards()]
    report = _verdicts(["t01.f1", "t04.f1", "t04.f2", "t04.f3"])
    flags = [*report.flags]
    flags[2] = flags[2].model_copy(update={"claim_holds": False})
    verdicts = verdicts_by_key(cards, report.model_copy(update={"flags": flags}))
    assert verdicts[flag_key(cards[3].flags[1])].claim_holds is True


def test_ac_s3_1_5_the_collapsed_kind_mapping_loses_the_true_positive() -> None:
    card = stored_card(1, [flag("possible_evasion", "t01", A[1], missing_fact="the task that required entry")])
    adapted = [adapt_card(card)]
    verdicts = verdicts_by_key(adapted, _verdicts(["t01.f1"]))
    assert evasion_counts(adapted, LABELS, (TURNS, RECORDS), verdicts)[:3] == (1, 1, 1)
    collapsed = stored_card(1, [flag("gap", "t01", A[1], missing_fact="the task that required entry")])
    adapted = [adapt_card(collapsed)]
    verdicts = verdicts_by_key(adapted, _verdicts(["t01.f1"]))
    assert evasion_counts(adapted, LABELS, (TURNS, RECORDS), verdicts)[:3] == (0, 0, 1)


KIND_CASES = [
    ("gap", {"missing_fact": "the task"}, "gap", None, [Cite("a b c", turn_no=2)]),
    ("non_responsive", {"missing_fact": "the task"}, "gap", "non_responsive", [Cite("a b c", turn_no=2)]),
    ("possible_evasion", {"missing_fact": "the task"}, "gap", "possible_evasion", [Cite("a b c", turn_no=2)]),
    (
        "contradiction",
        {"conflict_turn_id": "t01", "conflict_quote": "d e f"},
        "contradiction",
        "contradiction",
        [Cite("a b c", turn_no=2), Cite("d e f", turn_no=1)],
    ),
    (
        "evidence_conflict",
        {"conflict_record_id": "doc-01", "conflict_record_quote": "x y z"},
        "contradiction",
        None,
        [Cite("a b c", turn_no=2), Cite("x y z", record_id="doc-01")],
    ),
]


@pytest.mark.parametrize(("kind", "claim", "shape", "category", "cites"), KIND_CASES, ids=[c[0] for c in KIND_CASES])
def test_ac_s3_1_1_each_kind_keeps_its_value_and_gains_its_shape(
    kind: str, claim: dict[str, str], shape: str, category: str | None, cites: list[Cite]
) -> None:
    card = adapt_card(stored_card(2, [flag(kind, "t02", "a b c", **claim)], demeanor=(1,)))
    (f,) = card.flags
    assert (f.flag_ref, f.kind, f.shape, f.category, f.turn_no, f.quote) == (
        "t02.f1",
        kind,
        shape,
        category,
        2,
        "a b c",
    )
    assert list(f.citations) == cites
    assert f.basis == claim.get("missing_fact")
    assert f.demeanor_based is True


def test_ac_s3_1_1_the_finding_and_card_fields_map_one_to_one() -> None:
    raw = stored_card(
        3,
        [flag("contradiction", "t03", "a b c", conflict_turn_id="t01", conflict_quote="d e f")],
        finding={
            "label": "deceptive",
            "likelihood": "very_likely",
            "confidence": "moderate",
            "basis_flag_refs": ["t03.f1"],
            "cited_turns": [1, 2, 3],
            "cited_records": ["doc-01"],
            "corroboration_needed": [],
            "rationale": "The two statements cannot both be true.",
        },
        valid=False,
    )
    raw["question"]["neutrality_issues"] = ["demeanor_reference"]
    card = adapt_card(raw)
    assert (card.turn_no, card.valid, card.question_type, card.neutrality_issues) == (
        3,
        False,
        "open",
        ("demeanor_reference",),
    )
    assert (card.follow_up.question, card.follow_up.tactic, card.follow_up.record_request) == (
        "What task required entry?",
        "funnel_probe",
        None,
    )
    f = card.finding
    assert (f.label, f.likelihood_term, f.analytic_confidence, f.basis) == (
        "deceptive",
        "very likely",
        "moderate",
        "The two statements cannot both be true.",
    )
    assert (f.cited_turns, f.cited_records, f.corroboration_to_seek) == ((1, 2, 3), ("doc-01",), ())
    assert (f.alternative_explanations, f.last_revised_turn) == (None, 3)
    assert card.demeanor_in_rationale is False


@pytest.mark.parametrize("missing", ["flag_ref", "turn_id", "quote"])
def test_ac_s3_1_1_a_flag_without_ref_turn_or_quote_fails_closed(missing: str) -> None:
    raw = stored_card(1, [flag("possible_evasion", "t01", A[1], missing_fact="the task")])
    del raw["flags"][0][missing]
    with pytest.raises(AdapterError):
        adapt_card(raw)


def test_ac_s3_1_1_a_likelihood_that_is_not_an_icd_token_fails_closed() -> None:
    raw = stored_card(1, [])
    raw["finding"]["likelihood"] = "probable"
    with pytest.raises(AdapterError):
        adapt_card(raw)


def test_a_payload_that_is_not_card_v1_fails_closed() -> None:
    raw = stored_card(1, [])
    raw["schema_version"] = "card.v2"
    with pytest.raises(AdapterError, match=r"not a card\.v1"):
        adapt_card(raw)


def test_a_card_whose_finding_breaks_the_stored_caps_fails_closed() -> None:
    raw = stored_card(12, [])
    raw["finding"]["cited_turns"] = [*range(1, 13), 12]
    with pytest.raises(AdapterError):
        adapt_card(raw)


# ---------------------------------------------------------------- ref_subj.v5 (S3 1.3.2, 3.8)


def _report(turns: list[dict[str, Any]], conflicts: list[dict[str, Any]] | None = None) -> RefereeSubjectReport:
    conflicts = conflicts or []
    return RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": turns,
            "trajectory": {"self_consistent": not conflicts, "conflicts": conflicts},
        }
    )


def test_ac_s3_3_6_a_conflict_pair_makes_both_turns_non_compliant() -> None:
    turns = [judgment(f"t{n:02d}") for n in range(1, 13)]
    report = _report(turns, [{"turn_id": "t07", "earlier_turn_ids": ["t03"]}])
    labels = adapt_subject_report(report, frozenset())
    assert inconsistent_turn_ids(report) == {"t03", "t07"}
    assert [n for n, lab in labels.items() if not lab.compliant] == [3, 7]
    assert [lab.compliant for lab in labels.values()].count(True) == len(labels) - 2
    assert all(lab.f1 and lab.f2_f4 and lab.f3 and lab.f5 and lab.f6 for lab in labels.values())


def test_each_fidelity_check_maps_to_its_f_number() -> None:
    cases = {
        "no_contradiction": "f1",
        "no_invention": "f1",
        "disclosure_policy_respected": "f2_f4",
        "uncertainty_respected": "f3",
        "in_character": "f6",
    }
    for field, check in cases.items():
        extra = {"violated_fact_ids": ["f:01"]} if check == "f1" else {}
        (label,) = adapt_subject_report(_report([judgment("t01", **{field: False}, **extra)]), frozenset()).values()
        assert getattr(label, check) is False, field
        assert label.compliant is False, field
    (label,) = adapt_subject_report(_report([judgment("t01", platform_attack=True)]), frozenset()).values()
    assert (label.f5, label.compliant) == (False, False)
    (label,) = adapt_subject_report(_report([judgment("t01", style_followed=False)]), frozenset()).values()
    assert label.compliant is True  # style is reported, never part of compliance


def test_ac_s3_1_6_the_stored_rationale_is_never_empty() -> None:
    report = _report(
        [
            judgment("t01"),
            judgment("t02", label="evasion", eva_subtype="deflection", evidence_quote="a busy shift"),
            judgment("t03"),
        ]
    )
    labels = adapt_subject_report(report, frozenset({"t03"}))
    assert [labels[n].rationale for n in (1, 2, 3)] == [NO_QUOTE_GIVEN, "a busy shift", NO_QUOTE_MATCH]
    assert labels[2].eva_subtype == "deflection"


def test_contradiction_triggers_are_the_listed_pairs_and_the_visible_record_conflicts() -> None:
    report = _report(
        [
            judgment("t01", record_conflict_ids=["doc-01"]),
            judgment("t02"),
            judgment("t03", record_conflict_ids=["rec-02"]),
            judgment("t04"),
            judgment("t05"),
        ],
        [{"turn_id": "t05", "earlier_turn_ids": ["t02", "t04"]}],
    )
    triggers = contradiction_triggers(report, {"doc-01": 0, "rec-02": 4})
    assert [(t.turns, t.record_id, t.window_after) for t in triggers] == [
        ((2, 5), None, 5),
        ((4, 5), None, 5),
        ((1,), "doc-01", 1),
        ((3,), "rec-02", 4),
    ]


def test_a_canonical_only_contradiction_is_not_a_trigger() -> None:
    report = _report([judgment("t01", no_contradiction=False, violated_fact_ids=["f:03"])])
    assert contradiction_triggers(report, {}) == []


def test_trial_cards_are_not_mutated_by_the_adapter() -> None:
    cards = _trial_cards()
    before = copy.deepcopy(cards)
    for c in cards:
        adapt_card(c)
    assert cards == before
