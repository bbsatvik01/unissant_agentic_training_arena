"""S2 4.1-4.8 coaching outputs and the stored finding (AT-FIND-1..5; C-04, C-27, D5, SG2-24, SG4-05)."""

from __future__ import annotations

import itertools
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.contracts.coaching import (
    CoachingCard,
    DeepUpdate,
    FinalFinding,
    Flag,
    StoredCard,
    StoredDeepUpdate,
    TournamentWireCard,
    TrainingWireCard,
)
from arena_core.contracts.findings import (
    ALLOWED_LIKELIHOOD,
    CitationContext,
    Finding,
    InvestigatorFinding,
    StoredFinding,
    last_revised_turn,
    store_finding,
)

from .cards import SHA, finding, flag, model_card, stored_card

LIKELIHOODS = (
    "almost_no_chance",
    "very_unlikely",
    "unlikely",
    "roughly_even_chance",
    "likely",
    "very_likely",
    "almost_certain",
)
CANDIDATE = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"


def _ctx(
    turn: int,
    records: set[str] | None = None,
    requestable: frozenset[str] = frozenset(),
    flag_refs: frozenset[str] = frozenset(),
) -> CitationContext:
    return CitationContext(
        current_turn=turn,
        answered_turns=frozenset(range(1, turn + 1)),
        citable_records=frozenset(records or {"doc-01"}),
        requestable=requestable,
        flag_refs=flag_refs,
    )


# ---------------------------------------------------------------- Finding (S2 4.2, 4.3)


@pytest.mark.parametrize(("label", "likelihood"), list(itertools.product(ALLOWED_LIKELIHOOD, LIKELIHOODS)))
def test_the_label_allows_exactly_its_s2_likelihoods(label: str, likelihood: str) -> None:
    allowed = {
        "deceptive": {"likely", "very_likely", "almost_certain"},
        "truthful": {"unlikely", "very_unlikely", "almost_no_chance"},
        "insufficient_evidence": set(LIKELIHOODS),
    }[label]
    raw = finding(label=label, likelihood=likelihood, basis_flag_refs=["t01.f1"], corroboration_needed=["the log"])
    for model in (Finding, InvestigatorFinding):
        body = {**raw, "basis_flag_refs": []} if model is InvestigatorFinding else raw
        if likelihood in allowed:
            model.model_validate(body)
        else:
            with pytest.raises(ValidationError, match="likelihood"):
                model.model_validate(body)


def test_a_deceptive_assistant_finding_needs_a_basis_flag_but_an_investigator_finding_does_not() -> None:
    raw = finding(label="deceptive", likelihood="likely", corroboration_needed=[])
    with pytest.raises(ValidationError, match="basis_flag_refs"):
        Finding.model_validate(raw)
    InvestigatorFinding.model_validate(raw)


@pytest.mark.parametrize("entries", [[], ["a1", "b22"], ["one", "two", "six", "ten"]])
def test_insufficient_evidence_needs_one_to_three_corroboration_entries(entries: list[str]) -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate(finding(corroboration_needed=entries))


def test_text_limits_are_characters_and_twice_that_in_bytes() -> None:
    Finding.model_validate(finding(rationale="x" * 600))
    with pytest.raises(ValidationError, match="at most 600 characters"):
        Finding.model_validate(finding(rationale="x" * 601))
    with pytest.raises(ValidationError, match="1200 UTF-8 bytes"):
        Finding.model_validate(finding(rationale="\u20ac" * 401))  # 401 characters, 1,203 bytes
    with pytest.raises(ValidationError):
        Finding.model_validate(finding(rationale=""))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("cited_turns", [2, 2]),
        ("cited_turns", [13]),
        ("cited_turns", [0]),
        ("cited_turns", list(range(1, 10))),
        ("cited_records", ["doc-05"]),
        ("cited_records", ["rec-07"]),
        ("cited_records", ["doc-01", "doc-01"]),
        ("basis_flag_refs", ["t07.f4"]),
        ("basis_flag_refs", ["t13.f1"]),
        ("corroboration_needed", ["ab"]),
    ],
)
def test_shape_rules_of_the_model_finding(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate(finding(**{field: value}))


def test_a_string_turn_number_is_not_coerced() -> None:
    with pytest.raises(ValidationError):
        Finding.model_validate(finding(cited_turns=["3"]))


def test_at_find_3_a_truthful_closure_with_no_flags_validates() -> None:
    raw = finding(
        label="truthful",
        likelihood="very_unlikely",
        cited_turns=[2, 4],
        cited_records=["rec-02"],
        corroboration_needed=[],
    )
    card = CoachingCard.model_validate(model_card(5, [], finding=raw), context=_ctx(5, {"doc-01", "rec-02"}))
    assert card.finding.basis_flag_refs == []


def test_at_find_1_stored_citations_add_the_basis_flags_turns_and_records() -> None:
    own = Finding.model_validate(
        finding(
            label="deceptive",
            likelihood="likely",
            basis_flag_refs=["t05.f1", "t07.f1"],
            cited_turns=[2],
            cited_records=["doc-01"],
            corroboration_needed=[],
        )
    )
    contradiction = Flag.model_validate(
        flag("contradiction", "t03", "a b c", conflict_turn_id="t05", conflict_quote="d e f")
    )
    conflict = Flag.model_validate(
        flag("evidence_conflict", "t07", "a b c", conflict_record_id="rec-02", conflict_record_quote="x y z")
    )
    stored = store_finding(own, [contradiction, conflict], last_revised_turn=7)
    assert stored.cited_turns == [2, 3, 5, 7]
    assert (stored.cited_records, stored.last_revised_turn) == (["doc-01", "rec-02"], 7)


def test_at_find_5_maximal_disjoint_citations_fit_the_stored_finding() -> None:
    records = ["doc-01", "doc-02", "doc-03", "doc-04", "rec-01", "rec-02"]
    own = Finding.model_validate(
        finding(
            label="deceptive",
            likelihood="likely",
            basis_flag_refs=["t09.f1", "t10.f1", "t11.f1", "t12.f1"],
            cited_turns=list(range(1, 9)),
            cited_records=records,
            corroboration_needed=[],
        )
    )
    basis = [
        Flag.model_validate(
            flag("evidence_conflict", f"t{n:02d}", "a b c", conflict_record_id=r, conflict_record_quote="x y z")
        )
        for n, r in zip(range(9, 13), ["rec-03", "rec-04", "rec-05", "rec-06"], strict=True)
    ]
    stored = store_finding(own, basis, last_revised_turn=12)
    assert (stored.cited_turns, len(stored.cited_records)) == (list(range(1, 13)), 10)
    assert StoredFinding.model_validate(stored.model_dump()) == stored
    with pytest.raises(ValidationError):
        Finding.model_validate({**own.model_dump(), "cited_turns": list(range(1, 13))})


def test_last_revised_turn_moves_only_when_label_or_likelihood_changes() -> None:
    first = Finding.model_validate(finding())
    prev = store_finding(first, [], last_revised_turn=2)
    changed = Finding.model_validate(finding(label="truthful", likelihood="unlikely", corroboration_needed=[]))
    unset = InvestigatorFinding.model_validate({**finding()}).stored()
    assert [
        last_revised_turn(None, first, 2),
        last_revised_turn(prev, Finding.model_validate(finding(rationale="New words.")), 5),
        last_revised_turn(prev, Finding.model_validate(finding(likelihood="likely")), 5),
        last_revised_turn(prev, changed, 6),
        last_revised_turn(unset, first, 4),
    ] == [2, 2, 5, 6, 4]


# ---------------------------------------------------------------- card.v1 (S2 4.1, 4.3)


@pytest.mark.parametrize(
    ("kind", "claim"),
    [
        ("gap", {}),
        ("possible_evasion", {"missing_fact": None}),
        ("non_responsive", {"missing_fact": "x y z", "conflict_turn_id": "t01"}),
        ("contradiction", {"conflict_turn_id": "t01"}),
        ("contradiction", {"conflict_turn_id": "t01", "conflict_quote": "a b c", "missing_fact": "x y z"}),
        ("evidence_conflict", {"conflict_record_id": "rec-01"}),
        (
            "evidence_conflict",
            {"conflict_record_quote": "a b c", "conflict_record_id": "rec-01", "conflict_quote": "q"},
        ),
    ],
)
def test_a_flag_carries_exactly_the_claim_fields_of_its_kind(kind: str, claim: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Flag.model_validate(flag(kind, "t01", "a b c", **claim))


def test_card_rules_that_need_only_the_card() -> None:
    gap = flag("gap", "t03", "a b c", missing_fact="the task")
    CoachingCard.model_validate(model_card(3, [gap]))
    with pytest.raises(ValidationError, match=r"flags\[0\]\.turn_id"):
        CoachingCard.model_validate(model_card(2, [gap]))
    conflict = flag("contradiction", "t02", "a b c", conflict_turn_id="t04", conflict_quote="d e f")
    with pytest.raises(ValidationError, match="conflict_turn_id"):
        CoachingCard.model_validate(model_card(3, [conflict]))
    with pytest.raises(ValidationError, match=r"finding\.cited_turns"):
        CoachingCard.model_validate(model_card(3, [], finding=finding(cited_turns=[4])))
    deceptive = finding(label="deceptive", likelihood="likely", corroboration_needed=[], basis_flag_refs=["t03.f2"])
    with pytest.raises(ValidationError, match="basis_flag_refs"):
        CoachingCard.model_validate(model_card(3, [gap], finding=deceptive))  # the card has one flag
    CoachingCard.model_validate(model_card(3, [gap], finding={**deceptive, "basis_flag_refs": ["t03.f1"]}))
    with pytest.raises(ValidationError, match="basis_flag_refs"):
        CoachingCard.model_validate(model_card(3, [gap], finding={**deceptive, "basis_flag_refs": ["t04.f1"]}))
    with pytest.raises(ValidationError):
        CoachingCard.model_validate(model_card(3, [gap, gap, gap, gap]))


def test_at_find_4_trial_rules_name_the_field_path() -> None:
    ctx = _ctx(3, {"doc-01", "rec-01"}, requestable=frozenset({"rec-02"}), flag_refs=frozenset({"t01.f1"}))
    raw = model_card(3, [], finding=finding(cited_turns=[2], cited_records=["doc-01"]))
    CoachingCard.model_validate(raw, context=ctx)
    unanswered = CitationContext(3, frozenset({1, 3}), frozenset({"doc-01"}))
    with pytest.raises(ValidationError, match=r"finding\.cited_turns\[0\]: turn 2"):
        CoachingCard.model_validate(raw, context=unanswered)
    with pytest.raises(ValidationError, match=r"finding\.cited_records\[0\]: rec-02"):
        CoachingCard.model_validate(model_card(3, [], finding=finding(cited_records=["rec-02"])), context=ctx)
    with pytest.raises(ValidationError):
        CoachingCard.model_validate(model_card(3, [], finding=finding(cited_records=["doc-05"])), context=ctx)
    conflict = flag("evidence_conflict", "t03", "a b c", conflict_record_id="rec-03", conflict_record_quote="x y z")
    with pytest.raises(ValidationError, match=r"flags\[0\]\.conflict_record_id"):
        CoachingCard.model_validate(model_card(3, [conflict]), context=ctx)
    follow = model_card(3, [])
    follow["follow_up"]["record_request"] = "rec-04"
    with pytest.raises(ValidationError, match=r"follow_up\.record_request"):
        CoachingCard.model_validate(follow, context=ctx)
    follow["follow_up"]["record_request"] = "rec-02"
    CoachingCard.model_validate(follow, context=ctx)
    basis = finding(label="deceptive", likelihood="likely", corroboration_needed=[], basis_flag_refs=["t02.f1"])
    with pytest.raises(ValidationError, match=r"finding\.basis_flag_refs\[0\]: t02\.f1"):
        CoachingCard.model_validate(model_card(3, [], finding=basis), context=ctx)
    CoachingCard.model_validate(model_card(3, [], finding={**basis, "basis_flag_refs": ["t01.f1"]}), context=ctx)


def test_a_context_of_the_wrong_type_is_a_programming_error() -> None:
    with pytest.raises(TypeError, match="CitationContext"):
        CoachingCard.model_validate(model_card(1, []), context={"turn": 1})


# ---------------------------------------------------------------- stored and wire cards (SG4-05)


def test_the_stored_card_checks_its_code_filled_fields() -> None:
    gap = flag("gap", "t02", "a b c", missing_fact="the task")
    StoredCard.model_validate(stored_card(2, [gap]))
    bad_ref = stored_card(2, [gap])
    bad_ref["flags"][0]["flag_ref"] = "t02.f2"
    bad_ref["validation"]["flags"] = {"t02.f2": bad_ref["validation"]["flags"]["t02.f1"]}
    with pytest.raises(ValidationError, match="flag_ref"):
        StoredCard.model_validate(bad_ref)
    bad_map = stored_card(2, [gap])
    bad_map["validation"]["flags"] = {}
    with pytest.raises(ValidationError, match=r"validation\.flags"):
        StoredCard.model_validate(bad_map)
    with pytest.raises(ValidationError, match="turn_no"):
        StoredCard.model_validate({**stored_card(2, [gap]), "turn_no": 3})
    unrevised = stored_card(2, [gap])
    unrevised["finding"]["last_revised_turn"] = None
    with pytest.raises(ValidationError, match="last_revised_turn"):
        StoredCard.model_validate(unrevised)
    alternatives = stored_card(2, [gap])
    alternatives["finding"]["alternative_explanations"] = ["The alarm was elsewhere."]
    with pytest.raises(ValidationError, match="alternative_explanations"):
        StoredCard.model_validate(alternatives)


def test_the_training_card_drops_and_refuses_candidate_identifiers() -> None:
    stored = StoredCard.model_validate(stored_card(1, []))
    training = stored.training_wire()
    assert "candidate_sha256" not in training.model_dump()
    assert training.model_dump() == {k: v for k, v in stored.model_dump().items() if k != "candidate_sha256"}
    with pytest.raises(ValidationError):
        TrainingWireCard.model_validate({**training.model_dump(), "candidate_sha256": SHA})
    with pytest.raises(ValidationError):
        TrainingWireCard.model_validate({**training.model_dump(), "candidate_id": CANDIDATE})
    tournament = stored.tournament_wire(CANDIDATE)
    assert (tournament.candidate_sha256, tournament.candidate_id) == (SHA, CANDIDATE)
    with pytest.raises(ValidationError):
        TournamentWireCard.model_validate(training.model_dump())


# ---------------------------------------------------------------- deep.v1 and final.v1 (S2 4.6, 4.7)


def _deep(**overrides: object) -> dict[str, Any]:
    out: dict[str, Any] = {
        "schema_version": "deep.v1",
        "as_of_turn": "t06",
        "finding": finding(cited_turns=[2]),
        "evidence_coverage": [{"record_id": "rec-02", "status": "raised_not_tested", "turn_ids": ["t05"]}],
        "open_gaps": [{"missing_fact": "the task that required entry", "first_seen_turn": "t01"}],
        "disclosure_plan": {"record_id": "rec-03", "step": "evidence_topic"},
    }
    out.update(overrides)
    return out


def test_deep_update_rules() -> None:
    ctx = _ctx(6, {"doc-01", "rec-02"}, requestable=frozenset({"rec-03"}))
    DeepUpdate.model_validate(_deep(), context=ctx)
    with pytest.raises(ValidationError, match="every released record"):
        DeepUpdate.model_validate(_deep(evidence_coverage=[]), context=ctx)
    stray = [*_deep()["evidence_coverage"], {"record_id": "rec-05", "status": "not_yet_raised", "turn_ids": []}]
    with pytest.raises(ValidationError, match="neither released nor requestable"):
        DeepUpdate.model_validate(_deep(evidence_coverage=stray), context=ctx)
    with pytest.raises(ValidationError, match="disclosure_plan"):
        DeepUpdate.model_validate(_deep(disclosure_plan={"record_id": "rec-06", "step": "hold"}), context=ctx)
    twice = [*_deep()["evidence_coverage"], *_deep()["evidence_coverage"]]
    with pytest.raises(ValidationError, match="at most once"):
        DeepUpdate.model_validate(_deep(evidence_coverage=twice))
    late = [{"record_id": "rec-02", "status": "raised_not_tested", "turn_ids": ["t07"]}]
    with pytest.raises(ValidationError, match="turn_ids"):
        DeepUpdate.model_validate(_deep(evidence_coverage=late))
    with pytest.raises(ValidationError, match="first_seen_turn"):
        DeepUpdate.model_validate(_deep(open_gaps=[{"missing_fact": "the task", "first_seen_turn": "t08"}]))
    with pytest.raises(ValidationError, match=r"finding\.cited_turns"):
        DeepUpdate.model_validate(_deep(finding=finding(cited_turns=[7])))
    with pytest.raises(ValidationError, match=r"finding\.cited_records"):
        DeepUpdate.model_validate(_deep(finding=finding(cited_records=["rec-04"])), context=ctx)


def test_the_stored_deep_update_carries_the_revised_turn() -> None:
    stored = _deep(finding={**finding(), "alternative_explanations": None, "last_revised_turn": 6})
    StoredDeepUpdate.model_validate(stored)
    with pytest.raises(ValidationError, match="last_revised_turn"):
        StoredDeepUpdate.model_validate({**stored, "finding": {**stored["finding"], "last_revised_turn": None}})
    alt = {**stored["finding"], "alternative_explanations": ["The alarm was elsewhere."]}
    with pytest.raises(ValidationError, match="alternative_explanations"):
        StoredDeepUpdate.model_validate({**stored, "finding": alt})


def test_final_finding_rules() -> None:
    raw = {"schema_version": "final.v1", "finding": finding(cited_turns=[4]), "alternative_explanations": ["Lab C."]}
    FinalFinding.model_validate(raw, context=_ctx(4))
    with pytest.raises(ValidationError, match=r"finding\.cited_turns\[0\]"):
        FinalFinding.model_validate(raw, context=_ctx(3))
    with pytest.raises(ValidationError):
        FinalFinding.model_validate({**raw, "alternative_explanations": ["ab"]})
    with pytest.raises(ValidationError):
        FinalFinding.model_validate({**raw, "alternative_explanations": ["one1", "two2", "six6", "ten10"]})


def test_the_investigator_finding_is_stored_as_entered() -> None:
    body = {**finding(cited_turns=[1, 3], cited_records=["doc-01"]), "alternative_explanations": ["The alarm."]}
    stored = InvestigatorFinding.model_validate(body).stored()
    assert stored.last_revised_turn is None
    assert stored.cited_turns == [1, 3]
    with pytest.raises(ValidationError):
        InvestigatorFinding.model_validate({**body, "basis_flag_refs": ["t01.f1"]})
    with pytest.raises(ValidationError):
        InvestigatorFinding.model_validate({**body, "last_revised_turn": 3})
