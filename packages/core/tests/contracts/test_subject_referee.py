"""SubjectTurn subject.v1 (S2 6.8), ref_subj.v5 (S2 7.2, S3 3.8) and ref_asst.v2 (S2 7.3, X-06)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.contracts.referee import (
    RefAsstContext,
    RefereeAssistantReport,
    RefereeSubjectReport,
    RefSubjContext,
    apply_quote_check,
)
from arena_core.contracts.review import (
    CaseFile,
    FlagSubmission,
    Gate,
    LabelSubmission,
    LabelVerdict,
    LedgerFact,
    RubricSubmission,
    UncertaintyEntry,
)
from arena_core.contracts.subject import SubjectContext, SubjectTurn

from .cards import judgment
from .conftest import REPO_ROOT


def _subject(**tag: object) -> dict[str, Any]:
    base = {"disclosed": ["f:01"], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []}
    return {"utterance": "I went in to reset the freezer alarm.", "tag": {**base, **tag}}


SUBJECT_CTX = SubjectContext(
    fact_ids=frozenset({"f:01", "f:02"}),
    uncertainty_ids=frozenset({"u:01"}),
    closed_gate_ids=frozenset({"g:01"}),
    allowed_behaviors=frozenset({"responsive", "omission"}),
)


def test_v1_utterance_characters_bytes_and_words() -> None:
    SubjectTurn.model_validate({**_subject(), "utterance": "word " * 120})
    with pytest.raises(ValidationError, match="120 words"):
        SubjectTurn.model_validate({**_subject(), "utterance": "w " * 121})
    with pytest.raises(ValidationError, match="900 characters"):
        SubjectTurn.model_validate({**_subject(), "utterance": "x" * 901})
    SubjectTurn.model_validate({**_subject(), "utterance": "\u20ac" * 300})  # 1,800 wire bytes (D-019): the cap
    with pytest.raises(ValidationError, match="1800 bytes as sent"):
        SubjectTurn.model_validate({**_subject(), "utterance": "\u20ac" * 301})
    with pytest.raises(ValidationError):
        SubjectTurn.model_validate({**_subject(), "utterance": ""})


def test_v3_disclosed_and_withheld_are_disjoint_and_ids_unique() -> None:
    with pytest.raises(ValidationError, match="V3"):
        SubjectTurn.model_validate(_subject(withheld=["f:01"]))
    with pytest.raises(ValidationError):
        SubjectTurn.model_validate(_subject(disclosed=["f:01", "f:01"]))
    with pytest.raises(ValidationError):
        SubjectTurn.model_validate(_subject(disclosed=["F01"]))


def test_v2_and_v4_need_the_packet() -> None:
    SubjectTurn.model_validate(_subject(uncertainty_used=["u:01"], gates_opened=["g:01"]), context=SUBJECT_CTX)
    for tag, message in (
        ({"disclosed": ["f:09"]}, "disclosed"),
        ({"withheld": ["f:09"]}, "withheld"),
        ({"uncertainty_used": ["u:02"]}, "uncertainty_used"),
        ({"gates_opened": ["g:02"]}, "CLOSED"),
        ({"behavior": "deflection"}, "V4"),
    ):
        with pytest.raises(ValidationError, match=message):
            SubjectTurn.model_validate(_subject(**tag), context=SUBJECT_CTX)
    with pytest.raises(TypeError, match="SubjectContext"):
        SubjectTurn.model_validate(_subject(), context=object())


def _report(turns: list[dict[str, Any]], conflicts: list[dict[str, Any]] | None = None, **kw: object) -> dict[str, Any]:
    conflicts = conflicts or []
    trajectory = {"self_consistent": not conflicts, "conflicts": conflicts, **kw}
    return {"schema_version": "ref_subj.v5", "turns": turns, "trajectory": trajectory}


def test_ac_s3_3_4_subtype_and_reason_go_with_their_label_and_labels_are_words() -> None:
    RefereeSubjectReport.model_validate(_report([judgment("t01", label="evasion", eva_subtype="stall")]))
    with pytest.raises(ValidationError, match="eva_subtype"):
        RefereeSubjectReport.model_validate(_report([judgment("t01", label="evasion")]))
    with pytest.raises(ValidationError, match="pfq_reason"):
        RefereeSubjectReport.model_validate(_report([judgment("t01", label="poorly_framed_question")]))
    with pytest.raises(ValidationError, match="eva_subtype"):
        RefereeSubjectReport.model_validate(_report([judgment("t01", eva_subtype="stall")]))
    with pytest.raises(ValidationError, match="pfq_reason"):
        RefereeSubjectReport.model_validate(_report([judgment("t01", pfq_reason="jargon")]))
    with pytest.raises(ValidationError):
        RefereeSubjectReport.model_validate(_report([judgment("t01", label="EVA")]))


def test_violated_facts_only_with_an_f1_failure() -> None:
    with pytest.raises(ValidationError, match="violated_fact_ids"):
        RefereeSubjectReport.model_validate(_report([judgment("t01", violated_fact_ids=["f:02"])]))
    RefereeSubjectReport.model_validate(_report([judgment("t01", no_invention=False, violated_fact_ids=["f:02"])]))


def test_trajectory_rules() -> None:
    turns = [judgment(f"t0{n}") for n in range(1, 4)]
    with pytest.raises(ValidationError, match="self_consistent"):
        RefereeSubjectReport.model_validate(
            _report(turns, self_consistent=True, conflicts=[{"turn_id": "t03", "earlier_turn_ids": ["t01"]}])
        )
    with pytest.raises(ValidationError, match="does not precede"):
        RefereeSubjectReport.model_validate(_report(turns, [{"turn_id": "t02", "earlier_turn_ids": ["t03"]}]))
    with pytest.raises(ValidationError, match="each later turn once"):
        RefereeSubjectReport.model_validate(
            _report(
                turns,
                [{"turn_id": "t03", "earlier_turn_ids": ["t01"]}, {"turn_id": "t03", "earlier_turn_ids": ["t02"]}],
            )
        )
    with pytest.raises(ValidationError, match="in order"):
        RefereeSubjectReport.model_validate(_report([turns[1], turns[0]]))


def test_ref_subj_trial_checks() -> None:
    ctx = RefSubjContext(("t01", "t02"), frozenset({"f:01", "f:02"}), frozenset({"doc-01", "rec-02"}))
    good = [judgment("t01", requested_fact_ids=["f:01"], record_conflict_ids=["doc-01"]), judgment("t02")]
    RefereeSubjectReport.model_validate(_report(good), context=ctx)
    with pytest.raises(ValidationError, match="must be exactly"):
        RefereeSubjectReport.model_validate(_report(good[:1]), context=ctx)
    with pytest.raises(ValidationError, match="requested_fact_ids: f:09"):
        RefereeSubjectReport.model_validate(
            _report([judgment("t01", requested_fact_ids=["f:09"]), good[1]]), context=ctx
        )
    bad = judgment("t01", no_contradiction=False, violated_fact_ids=["f:09"])
    with pytest.raises(ValidationError, match="violated_fact_ids: f:09"):
        RefereeSubjectReport.model_validate(_report([bad, good[1]]), context=ctx)
    with pytest.raises(ValidationError, match="record_conflict_ids: rec-03"):
        RefereeSubjectReport.model_validate(
            _report([judgment("t01", record_conflict_ids=["rec-03"]), good[1]]), context=ctx
        )
    with pytest.raises(ValidationError, match="not a subject turn"):
        RefereeSubjectReport.model_validate(
            _report(good, [{"turn_id": "t03", "earlier_turn_ids": ["t01"]}]), context=ctx
        )
    with pytest.raises(TypeError, match="RefSubjContext"):
        RefereeSubjectReport.model_validate(_report(good), context=ctx.subject_turn_ids)


def test_a_non_matching_evidence_quote_is_blanked_and_marked() -> None:
    report = RefereeSubjectReport.model_validate(
        _report(
            [
                judgment("t01", label="evasion", eva_subtype="deflection", evidence_quote="a busy shift"),
                judgment("t02", evidence_quote="something never said here"),
                judgment("t03"),
            ]
        )
    )
    answers = {"t01": "It was a busy shift.", "t02": "I went in to reset it.", "t03": "Yes."}
    checked, invalid = apply_quote_check(report, answers)
    assert invalid == {"t02"}
    assert [t.evidence_quote for t in checked.turns] == ["a busy shift", "", ""]
    assert [t.label for t in checked.turns] == [t.label for t in report.turns]


def _asst(**overrides: object) -> dict[str, Any]:
    out: dict[str, Any] = {
        "schema_version": "ref_asst.v2",
        "flags": [
            {
                "flag_ref": "t01.f1",
                "quote_relevant": True,
                "claim_holds": True,
                "content_based": True,
                "no_outside_facts": True,
            }
        ],
        "followups": [
            {
                "turn_id": "t01",
                "question_type": "probing",
                "not_leading": True,
                "well_framed": True,
                "no_loaded_wording": True,
                "on_objective": True,
                "builds_on_previous": True,
            }
        ],
        "citations": [{"cite": "t02", "supports_basis": True}, {"cite": "doc-01", "supports_basis": False}],
        "subchecks": [{"id": "1b", "result": "pass", "turn_ids": []}, {"id": "5e", "result": "na", "turn_ids": []}],
    }
    out.update(overrides)
    return out


ASST_CTX = RefAsstContext(
    flag_refs=frozenset({"t01.f1"}),
    followup_turn_ids=frozenset({"t01"}),
    citation_ids=frozenset({"t02", "doc-01"}),
    rubric_subcheck_ids=frozenset({"1a", "1b", "1c", "1d", "2c", "2d", "5e"}),
    transcript_turn_ids=frozenset({"t01", "t02"}),
)


def test_ref_asst_answers_each_submitted_item_exactly_once() -> None:
    RefereeAssistantReport.model_validate(_asst(), context=ASST_CTX)
    with pytest.raises(ValidationError, match="answered per question"):
        RefereeAssistantReport.model_validate(
            _asst(subchecks=[*_asst()["subchecks"], {"id": "1a", "result": "pass", "turn_ids": []}])
        )
    with pytest.raises(ValidationError, match=r"flags: missing \['t01\.f1'\]"):
        RefereeAssistantReport.model_validate(_asst(flags=[]), context=ASST_CTX)
    with pytest.raises(ValidationError, match="listed twice"):
        RefereeAssistantReport.model_validate(
            _asst(citations=[*_asst()["citations"], {"cite": "t02", "supports_basis": True}]), context=ASST_CTX
        )
    extra = [*_asst()["followups"], {**_asst()["followups"][0], "turn_id": "t02"}]
    with pytest.raises(ValidationError, match="were not submitted"):
        RefereeAssistantReport.model_validate(_asst(followups=extra), context=ASST_CTX)
    with pytest.raises(ValidationError, match=r"subchecks: missing \['5e'\]"):
        RefereeAssistantReport.model_validate(_asst(subchecks=_asst()["subchecks"][:1]), context=ASST_CTX)
    with pytest.raises(ValidationError):
        RefereeAssistantReport.model_validate(_asst(citations=[{"cite": "doc-05", "supports_basis": True}]))
    late = [{"id": "1b", "result": "fail", "turn_ids": ["t12"]}, {"id": "5e", "result": "na", "turn_ids": []}]
    with pytest.raises(ValidationError, match=r"subchecks\[0\]\.turn_ids: t12"):
        RefereeAssistantReport.model_validate(_asst(subchecks=late), context=ASST_CTX)
    with pytest.raises(TypeError, match="RefAsstContext"):
        RefereeAssistantReport.model_validate(_asst(), context=ASST_CTX.flag_refs)


# ---------------------------------------------------------------- rater submissions share the proxy's checks (S3 7.3)


def test_a_rubric_rating_is_checked_like_the_proxys() -> None:
    body = {k: v for k, v in _asst().items() if k in {"followups", "citations", "subchecks"}}
    RubricSubmission.model_validate({"task": "T-RUB", **body}, context=ASST_CTX)
    once = [{"id": "1a", "result": "pass", "turn_ids": []}]
    with pytest.raises(ValidationError, match="answered per question"):
        RubricSubmission.model_validate({"task": "T-RUB", **body, "subchecks": once})
    with pytest.raises(ValidationError, match="listed twice"):
        RubricSubmission.model_validate({"task": "T-RUB", **body, "followups": body["followups"] * 2})
    with pytest.raises(ValidationError, match=r"subchecks: missing \['5e'\]"):
        RubricSubmission.model_validate({"task": "T-RUB", **body, "subchecks": body["subchecks"][:1]}, context=ASST_CTX)


def test_flag_and_label_ratings_judge_each_item_once() -> None:
    verdict = _asst()["flags"][0]
    FlagSubmission.model_validate({"task": "T-FLAG", "flags": [verdict]}, context=ASST_CTX)
    with pytest.raises(ValidationError, match="listed twice"):
        FlagSubmission.model_validate({"task": "T-FLAG", "flags": [verdict, verdict]})
    with pytest.raises(ValidationError, match="missing"):
        FlagSubmission.model_validate({"task": "T-FLAG", "flags": []}, context=ASST_CTX)
    turn = {k: v for k, v in judgment("t01").items() if k in LabelVerdict.model_fields}
    second = {**turn, "turn_id": "t02"}
    LabelSubmission.model_validate({"task": "T-LAB", "turns": [turn, second]}, context=SUBJ_CTX)
    with pytest.raises(ValidationError, match="in order"):
        LabelSubmission.model_validate({"task": "T-LAB", "turns": [second, turn]})
    with pytest.raises(ValidationError, match="must be exactly"):
        LabelSubmission.model_validate({"task": "T-LAB", "turns": [turn]}, context=SUBJ_CTX)
    with pytest.raises(TypeError, match="RefSubjContext"):
        LabelSubmission.model_validate({"task": "T-LAB", "turns": [turn]}, context=ASST_CTX)


SUBJ_CTX = RefSubjContext(("t01", "t02"), frozenset({"f:01"}), frozenset({"doc-01"}))


@pytest.mark.parametrize("family", [f"F0{n}" for n in range(1, 10)])
def test_review_items_carry_every_dev_case_as_s1_holds_it(family: str) -> None:
    variants = json.loads((REPO_ROOT / "cases" / "dev" / f"{family}.json").read_text(encoding="utf-8"))["variants"]
    for variant in variants.values():
        CaseFile.from_public_packet(variant["public_packet"])
        private = variant["private_packet"]
        for fact in private["facts"]:
            LedgerFact.model_validate(fact)
        for entry in private["uncertainty"]:
            UncertaintyEntry.model_validate(entry)
        for gate in private["gates"]:
            Gate.model_validate(gate)
