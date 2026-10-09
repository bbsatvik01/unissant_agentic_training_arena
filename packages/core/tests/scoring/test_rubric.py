"""EVL-7 rubric (S3 2): the worked examples 2.10.2-2.10.4 and fixtures FX-R01 to FX-R09 with recorded referee
verdicts (zero model calls); AC-S3-2.1 to 2.11."""

from __future__ import annotations

import ast
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest

from arena_core.contracts.adapter import adapt_subject_report, contradiction_triggers
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import SubcheckVerdict
from arena_core.scoring import rubric
from arena_core.scoring.exact import RubricError, dimension_score
from arena_core.scoring.rubric import (
    LINEAGE,
    Closure,
    Question,
    Triggers,
    assistant_questions,
    closure_checks,
    closure_code_checks,
    closure_score,
    definition_sha256,
    investigator_questions,
    question_checks,
    rubric_sha256,
    score_rubric,
    triggers_from,
)

from .builders import cites, finding, fv, judgment, records, report, sub, subs, trial

# ---------------------------------------------------------------- 2.10.2: a strong session (95)

STRONG_ANSWERS = {
    1: "It was a busy shift.",
    2: "The freezer alarm was going off, so I went in to reset it.",
    3: "I badged in around 9:40, went to the panel, pressed reset, checked the freezer temperature and left.",
    4: "Nobody asked me. I heard it beeping from the corridor around 9:35.",
    5: "Maybe it was the Lab C panel. It's on the shared wall, and they sound the same from the corridor.",
    6: "Inside Lab B, on the left as you walk in, next to the freezer.",
}


def strong() -> tuple[list[Question], Triggers, list[SubcheckVerdict], Closure]:
    sources = dict.fromkeys(range(1, 7), "investigator")
    followups = [
        fv(1, "probing"),
        fv(2, "probing"),
        fv(3, "open"),
        fv(4, "compound", well_framed=False),
        fv(5, "probing"),
        fv(6, "open"),
    ]
    labels = adapt_subject_report(
        report(
            [
                judgment(1, label="evasion"),
                judgment(2),
                judgment(3),
                judgment(4, record_conflict_ids=["rec-02"]),
                judgment(5, innocent_explanation_offered=True),
                judgment(6),
            ]
        ),
        frozenset(),
    )
    released = {"rec-02": 4}  # requested by the investigator, released before t05
    rep = report([judgment(4, record_conflict_ids=["rec-02"])])
    trig = triggers_from(labels, released, contradiction_triggers(rep, released))
    sc = subs(c2a="pass", c2b="na", c3a="pass", c3b="pass", c3c="pass", c3d="pass", c3e="pass")
    sc += subs(c4a="pass", c4b="pass", c4c="pass", c4d="pass", c5c="pass", c5e="pass")
    rows = trial(STRONG_ANSWERS, rec02_after=4)
    closure = Closure(
        finding(
            cited_turns=[4, 5, 6],
            cited_records=["rec-02"],
            corroboration_needed=[
                "Lab C panel log 21:00-22:30",
                "work-order system for 2026-03-14",
                "whether the Lab B panel records local resets",
            ],
        ),
        rows.turns,
        rows.records,
        6,
        False,
        cites(t04=True, t05=True, t06=True, rec_02=True),
    )
    return investigator_questions(sources, followups), trig, sc, closure


def results(r: rubric.RubricResult) -> dict[str, bool | None]:
    return {k: v.result for k, v in r.checks.items()}


def test_2_10_2_strong_session_scores_95_check_by_check() -> None:
    r = score_rubric(*strong())
    got = results(r)
    assert got == {
        **dict.fromkeys(("1a", "1b", "1d", "2a", "2c", "2d", "3a", "3b", "3c", "3d", "3e"), True),
        **dict.fromkeys(("4a", "4b", "4c", "4d", "5a", "5b", "5c", "5d", "5e"), True),
        "1c": False,
        "2b": None,
    }
    assert r.checks["1c"].turns == (4,)
    assert (dict(r.dimensions), r.total) == ({"D1": 3, "D2": 4, "D3": 4, "D4": 4, "D5": 4}, 95)


# ---------------------------------------------------------------- 2.10.3: a weak session (25)

WEAK_ANSWERS = {
    1: "Yes, around 9:40.",
    2: "I wasn't hiding anything. I was tired after a double shift.",
    3: "No one was with me.",
    4: "I had a reason.",
    5: "No. I went in because I heard the alarm beeping.",
}


def weak() -> tuple[list[Question], Triggers, list[SubcheckVerdict], Closure]:
    sources = dict.fromkeys(range(1, 6), "investigator")
    followups = [
        fv(1, "closed", builds_on_previous=False),
        fv(2, "suggestive", not_leading=False, no_loaded_wording=False, builds_on_previous=False),
        fv(3, "compound", well_framed=False, builds_on_previous=False),
        fv(4, "leading", not_leading=False, builds_on_previous=True),
        fv(5, "leading", not_leading=False, builds_on_previous=False),
    ]
    rep = report(
        [
            judgment(1),
            judgment(2),
            judgment(3, label="poorly_framed_question"),
            judgment(4),
            judgment(5, innocent_explanation_offered=True, record_conflict_ids=["rec-02"]),
        ]
    )
    released = {"rec-02": 3}
    trig = triggers_from(adapt_subject_report(rep, frozenset()), released, contradiction_triggers(rep, released))
    sc = subs(c2a="na", c2b="na", c3a="fail", c3b="pass", c3c="pass", c3d="fail", c3e="na")
    sc += subs(c4a="fail", c4b="na", c4c="fail", c4d="fail", c5c="pass", c5e="na")
    rows = trial(WEAK_ANSWERS, rec02_after=3)
    closure = Closure(
        finding(
            label="deceptive",
            likelihood="almost_certain",
            confidence="high",
            cited_turns=[2, 5],
            cited_records=["rec-02"],
            corroboration_needed=[],
            rationale="Subject was nervous on camera (t02) and claims an alarm the log does not show (t05 vs rec-02).",
        ),
        rows.turns,
        rows.records,
        5,
        True,  # the lexicon marks demeanor_in_rationale ("nervous")
        cites(t02=False, t05=True, rec_02=True),
    )
    return investigator_questions(sources, followups), trig, sc, closure


def test_2_10_3_weak_session_scores_25_check_by_check() -> None:
    r = score_rubric(*weak())
    assert results(r) == {
        "1a": False,
        "1b": False,
        "1c": False,
        "1d": False,
        "2a": None,
        "2b": None,
        "2c": True,
        "2d": False,
        "3a": False,
        "3b": True,
        "3c": True,
        "3d": False,
        "3e": None,  # t05 conflicts with rec-02, but no question follows the last answer (AC-S3-2.9)
        "4a": False,
        "4b": None,
        "4c": False,
        "4d": False,
        "5a": True,
        "5b": False,
        "5c": False,  # the lexicon decides even though the referee said pass
        "5d": False,
        "5e": None,
    }
    assert r.checks["1a"].turns == (2, 4, 5)
    assert r.checks["1c"].turns == (3,)
    assert (dict(r.dimensions), r.total) == ({"D1": 0, "D2": 2, "D3": 2, "D4": 0, "D5": 1}, 25)


def test_2_10_3_closure_has_s_equal_one() -> None:
    _, _, _, closure = weak()
    code, s = closure_code_checks(closure)
    assert (code, s) == ({"5a": True, "5b": False, "5d": False}, 1)


# ---------------------------------------------------------------- 2.10.4: an assistant trial (QQ 87.5)

ASST_ANSWERS = {
    1: "It was a busy shift.",
    2: "The freezer alarm was going off, so I went in to reset it.",
    3: "I heard it beeping from the corridor.",
    4: "No. I went in because of the alarm.",
    5: "Maybe it was the Lab C panel; it's on the shared wall.",
}
ASST_SOURCES = {
    1: "harness_fixed",
    2: "assistant_relay",
    3: "assistant_relay",
    4: "assistant_relay",
    5: "assistant_relay",
}


def assistant(
    sources: dict[int, str] = ASST_SOURCES, labels_override: dict[int, str] | None = None
) -> tuple[list[Question], Triggers, list[SubcheckVerdict], Closure]:
    followups = [
        fv(1, "probing"),
        fv(2, "forced_choice"),
        fv(3, "leading", not_leading=False, builds_on_previous=False),
        fv(4, "probing"),
        fv(5, "open"),
    ]
    turns = [
        judgment(1, label="evasion"),
        judgment(2),
        judgment(3, record_conflict_ids=["rec-02"]),
        judgment(4),
        judgment(5, innocent_explanation_offered=True),
    ]
    for t, lab in (labels_override or {}).items():
        turns[t - 1] = judgment(t, label=lab)
    rep = report(turns)
    released = {"rec-02": 3}  # card t03 requested it; released before t04 (S2 8.4)
    trig = triggers_from(adapt_subject_report(rep, frozenset()), released, contradiction_triggers(rep, released))
    sc = subs(c2a="pass", c2b="na", c3a="pass", c3b="pass", c3c="pass", c3d="pass", c3e="pass")
    sc += subs(c4a="pass", c4b="pass", c4c="pass", c4d="fail", c5c="pass", c5e="pass")
    rows = trial(ASST_ANSWERS, rec02_after=3)
    closure = Closure(
        finding(cited_turns=[3], cited_records=["rec-02"]),
        rows.turns,
        rows.records,
        5,
        False,
        cites(t03=True, rec_02=True),
    )
    qs = assistant_questions(range(1, 6), frozenset(range(1, 6)), sources, followups)
    return qs, trig, sc, closure


def test_2_10_4_assistant_trial_scores_qq_14_of_16() -> None:
    r = score_rubric(*assistant())
    got = results(r)
    assert {k: got[k] for k in ("1a", "1b", "1c", "1d")} == {"1a": False, "1b": True, "1c": True, "1d": True}
    assert {k: got[k] for k in ("2a", "2b", "2c", "2d")} == {"2a": True, "2b": None, "2c": True, "2d": True}
    assert {k: got[k] for k in ("3a", "3b", "3c", "3d", "3e")} == dict.fromkeys(("3a", "3b", "3c", "3d", "3e"), True)
    assert {k: got[k] for k in ("4a", "4b", "4c", "4d")} == {"4a": True, "4b": True, "4c": True, "4d": False}
    assert [r.dimensions[d] for d in ("D1", "D2", "D3", "D4")] == [3, 4, 4, 3]
    assert (r.qq, float(r.qq or 0) * 100) == (Fraction(14, 16), 87.5)


def test_assistant_questions_record_what_each_proposal_saw_and_whether_it_was_relayed() -> None:
    qs, *_ = assistant()
    assert [(q.turn_no, q.answers_seen, q.releases_seen, q.answered_turn) for q in qs] == [
        (1, 1, 0, 2),
        (2, 2, 1, 3),
        (3, 3, 2, 4),
        (4, 4, 3, 5),
        (5, 5, 4, None),  # P5 was never relayed
    ]


# ---------------------------------------------------------------- AC-S3-2.1 mapping table


@pytest.mark.parametrize(
    ("applicable", "row"),
    [(2, [0, 2, 4]), (3, [0, 1, 3, 4]), (4, [0, 1, 2, 3, 4]), (5, [0, 1, 2, 2, 3, 4])],
)
def test_ac_s3_2_1_dimension_score_reproduces_the_mapping_table(applicable: int, row: list[int]) -> None:
    for passed, expected in enumerate(row):
        verdicts: dict[str, bool | None] = {f"c{i}": i < passed for i in range(applicable)}
        verdicts["na"] = None
        assert dimension_score(verdicts) == expected


def test_a_dimension_with_fewer_than_two_applicable_checks_is_refused() -> None:
    with pytest.raises(RubricError):
        dimension_score({"a": True, "b": None})


# ---------------------------------------------------------------- FX-R01, FX-R02, FX-R05


def test_fx_r01_every_applicable_check_failing_scores_0() -> None:
    followups = [
        fv(
            t,
            "closed",
            not_leading=False,
            well_framed=False,
            no_loaded_wording=False,
            on_objective=False,
            builds_on_previous=False,
        )
        for t in (1, 2, 3)
    ]
    qs = investigator_questions(dict.fromkeys((1, 2, 3), "investigator"), followups)
    rep = report([judgment(1, label="evasion"), judgment(2), judgment(3)])
    trig = triggers_from(adapt_subject_report(rep, frozenset()), {}, [])
    sc = subs(c2a="fail", c3a="fail", c3b="fail", c3d="na", c4a="fail", c4c="fail", c4d="fail")
    rows = trial({1: "a", 2: "b", 3: "c"}, rec02_after=None)
    r = score_rubric(qs, trig, sc, Closure(None, rows.turns, rows.records, 3, False, ()))
    assert all(v.result in (False, None) for v in r.checks.values())
    assert (r.total, dict(r.dimensions)) == (0, dict.fromkeys(("D1", "D2", "D3", "D4", "D5"), 0))


def test_fx_r02_every_applicable_check_passing_scores_100() -> None:
    qs, trig, sc, closure = strong()
    qs[3] = Question(4, 3, 3, 4, fv(4, "open"))  # the strong session without its compound question
    r = score_rubric(qs, trig, sc, closure)
    assert (r.total,) == (100,)
    assert all(v.result in (True, None) for v in r.checks.values())


def test_fx_r05_ac_s3_2_5_a_two_question_sequence_is_unscorable() -> None:
    qs, trig, sc, closure = strong()
    r = score_rubric(qs[:2], trig, sc, closure)
    assert (r.scorable, r.unscorable_reason, r.total, r.qq, dict(r.dimensions)) == (
        False,
        "fewer than 3 questions",
        None,
        None,
        {},
    )


# ---------------------------------------------------------------- PFQ routing (FX-R06, FX-R09; AC-S3-2.4, 2.11)


def test_fx_r06_ac_s3_2_4_a_pfq_label_fails_1c_although_every_well_framed_check_passed() -> None:
    qs, _, sc, closure = strong()
    qs[3] = Question(4, 3, 3, 4, fv(4, "open"))
    rep = report([judgment(1, label="evasion"), judgment(2, label="poorly_framed_question")])
    trig = triggers_from(adapt_subject_report(rep, frozenset()), {"rec-02": 4}, [])
    assert all(q.verdict is not None and q.verdict.well_framed for q in qs)
    r = score_rubric(qs, trig, sc, closure)
    assert (r.checks["1c"].result, r.checks["1c"].turns) == (False, (2,))


@pytest.mark.parametrize(("source", "fails"), [("assistant_relay", True), ("harness_fallback", False)])
def test_fx_r09_ac_s3_2_11_pfq_fails_the_assistant_only_when_its_proposal_was_relayed(source: str, fails: bool) -> None:
    """Turn 4's question "What happened next?" is P3 relayed in one trial and the harness fallback in the other;
    its answer is labeled PFQ in both. Origin is read from the recorded source, never from wording (SG2-09)."""
    sources = {**ASST_SOURCES, 4: source}
    qs, trig, sc, closure = assistant(sources, labels_override={4: "poorly_framed_question"})
    qs[2] = Question(3, 3, 2, qs[2].answered_turn, fv(3, "open"))
    r = score_rubric(qs, trig, sc, closure)
    assert r.checks["1c"].result is (not fails)


def test_ac_s3_3_3_a_pfq_on_a_relayed_proposal_fails_1c() -> None:
    qs, trig, sc, closure = assistant(labels_override={3: "poorly_framed_question"})
    assert score_rubric(qs, trig, sc, closure).checks["1c"] == rubric.CheckResult(False, (2,))


# ---------------------------------------------------------------- per-question checks (AC-S3-2.8)


def test_ac_s3_2_8_2d_at_exactly_half_passes_and_below_half_fails() -> None:
    _, trig, sc, _ = strong()
    base = [Question(t, t - 1, t - 1, t, fv(t, "open")) for t in range(1, 6)]
    half = [
        base[0],
        *(
            Question(
                q.turn_no,
                q.answers_seen,
                q.releases_seen,
                q.answered_turn,
                fv(q.turn_no, "open", builds_on_previous=q.turn_no in (2, 3)),
            )
            for q in base[1:]
        ),
    ]
    assert question_checks(half, trig, sc)["2d"].result is True  # 2 of 4
    below = [
        *half[:2],
        *(
            Question(
                q.turn_no,
                q.answers_seen,
                q.releases_seen,
                q.answered_turn,
                fv(q.turn_no, "open", builds_on_previous=False),
            )
            for q in half[2:]
        ),
    ]
    assert question_checks(below, trig, sc)["2d"].result is False  # 1 of 4


def test_ac_s3_2_8_1b_at_exactly_60_percent_passes() -> None:
    qs, trig, sc, _ = assistant()
    assert question_checks(qs, trig, sc)["1b"].result is True  # 3 of 5 (S3 2.10.4)
    qs[0] = Question(1, 1, 0, 2, fv(1, "closed"))
    assert question_checks(qs, trig, sc)["1b"].result is False  # 2 of 5


def test_a_turn_with_no_valid_card_fails_every_per_question_form_test() -> None:
    _, trig, sc, _ = assistant()
    followups = [fv(t, "open") for t in (1, 3, 4, 5)]
    qs = assistant_questions(range(1, 6), frozenset({1, 3, 4, 5}), ASST_SOURCES, followups)
    assert qs[1].verdict is None
    checks = question_checks(qs, trig, sc)
    for c in ("1a", "1c", "1d", "2c"):
        assert checks[c] == rubric.CheckResult(False, (2,))
    assert checks["1b"].result is True  # 4 of 5 typed open
    assert checks["2d"].result is True  # 3 of 4 after the first build


def test_a_valid_card_without_per_question_checks_is_refused() -> None:
    with pytest.raises(RubricError, match="card 2"):
        assistant_questions([1, 2], frozenset({1, 2}), {}, [fv(1, "open")])
    with pytest.raises(RubricError, match="turn 2"):
        investigator_questions({1: "investigator", 2: "investigator"}, [fv(1, "open")])


def test_an_applicable_check_answered_na_or_missing_is_refused() -> None:
    qs, trig, sc, closure = strong()
    with pytest.raises(RubricError, match="2a applies"):
        score_rubric(qs, trig, [s for s in sc if s.id != "2a"] + [sub("2a", "na")], closure)
    with pytest.raises(RubricError, match="3a applies"):
        score_rubric(qs, trig, [s for s in sc if s.id != "3a"], closure)
    with pytest.raises(RubricError, match="3d"):
        score_rubric(qs, trig, [s for s in sc if s.id != "3d"], closure)


def test_code_decides_applicability_even_when_the_referee_answers() -> None:
    qs, trig, sc, closure = weak()
    sc = [s for s in sc if s.id not in ("2a", "4b")] + [sub("2a", "fail"), sub("4b", "fail")]
    r = score_rubric(qs, trig, sc, closure)
    assert (r.checks["2a"].result, r.checks["4b"].result) == (None, None)


def test_investigator_questions_skip_harness_turns() -> None:
    qs = investigator_questions({1: "harness_fixed", 2: "investigator"}, [fv(2, "open")])
    assert [(q.turn_no, q.answers_seen, q.answered_turn) for q in qs] == [(2, 1, 2)]


# ---------------------------------------------------------------- 3e triggers (AC-S3-2.9, 2.10, 2.11)


def _three_questions(n: int) -> list[Question]:
    return [Question(t, t - 1, t - 1, t, fv(t, "open")) for t in range(1, n + 1)]


def test_ac_s3_2_9_a_record_trigger_needs_both_the_turn_and_the_release_before_the_last_question() -> None:
    rep = report([judgment(1), judgment(2, record_conflict_ids=["rec-02"]), judgment(3), judgment(4)])
    for released_after, applies in ((2, True), (3, True), (4, False)):
        released = {"rec-02": released_after}
        trig = triggers_from(adapt_subject_report(rep, frozenset()), released, contradiction_triggers(rep, released))
        sc = [*subs(c3a="pass", c3b="pass", c3c="pass", c3d="na", c3e="fail"), *subs(c4a="pass", c4c="pass")]
        got = question_checks(_three_questions(4), trig, [*sc, sub("4d", "pass")])["3e"].result
        assert got is (False if applies else None), released_after


def test_ac_s3_2_9_an_assistant_proposal_sees_a_record_only_from_the_next_card() -> None:
    rep = report([judgment(1, record_conflict_ids=["rec-02"]), judgment(2), judgment(3)])
    released = {"rec-02": 3}  # requested on card 3, released after it
    trig = triggers_from(adapt_subject_report(rep, frozenset()), released, contradiction_triggers(rep, released))
    qs = assistant_questions([1, 2, 3], frozenset({1, 2, 3}), {}, [fv(t, "open") for t in (1, 2, 3)])
    sc = [*subs(c3a="pass", c3b="pass", c3c="pass", c3d="na", c3e="pass"), *subs(c4a="pass", c4c="pass", c4d="pass")]
    checks = question_checks(qs, trig, sc)
    assert (checks["3c"].result, checks["3e"].result) == (None, None)  # P3 was written before the release


def test_ac_s3_2_11_an_initial_document_conflict_is_a_trigger_a_hidden_fact_conflict_is_not() -> None:
    sc = [*subs(c3a="pass", c3b="pass", c3c="na", c3d="na", c3e="fail"), *subs(c4a="pass", c4c="pass", c4d="pass")]
    doc = report([judgment(1), judgment(2, record_conflict_ids=["doc-01"]), judgment(3), judgment(4)])
    trig = triggers_from(adapt_subject_report(doc, frozenset()), {}, contradiction_triggers(doc, {"doc-01": 0}))
    assert question_checks(_three_questions(4), trig, sc)["3e"].result is False
    hidden = report(
        [judgment(1), judgment(2, no_contradiction=False, violated_fact_ids=["f:09"]), judgment(3), judgment(4)]
    )
    labels = adapt_subject_report(hidden, frozenset())
    trig = triggers_from(labels, {}, contradiction_triggers(hidden, {}))
    assert question_checks(_three_questions(4), trig, sc)["3e"].result is None
    assert labels[2].f1 is False  # still a fidelity failure


def test_ac_s3_2_10_two_disjoint_listed_pairs_are_exactly_the_triggers() -> None:
    rep = report([judgment(t) for t in range(1, 10)], conflicts=[(5, [2]), (8, [4])])
    pairs = {c.turns for c in contradiction_triggers(rep, {})}
    assert pairs == {(2, 5), (4, 8)}
    trig = triggers_from(adapt_subject_report(rep, frozenset()), {}, contradiction_triggers(rep, {}))
    sc = [*subs(c3a="pass", c3b="pass", c3c="na", c3d="na", c3e="pass"), *subs(c4a="pass", c4c="pass", c4d="pass")]
    assert question_checks(_three_questions(9), trig, sc)["3e"].result is True
    assert question_checks(_three_questions(5), trig, sc)["3e"].result is None  # t05's conflict: no later question


# ---------------------------------------------------------------- closure (FX-R07, FX-R08; AC-S3-2.10 closure)


def _closure(f: StoredFinding | None, supports: dict[str, bool], demeanor: bool = False) -> Closure:
    rows = trial(ASST_ANSWERS, rec02_after=3)
    return Closure(f, rows.turns, rows.records, 5, demeanor, cites(**supports))


def test_fx_r07_deceptive_almost_certain_with_one_supported_citation_fails_5d() -> None:
    f = finding(
        label="deceptive",
        likelihood="almost_certain",
        confidence="moderate",
        cited_turns=[3],
        cited_records=["rec-02"],
        corroboration_needed=[],
    )
    code, s = closure_code_checks(_closure(f, {"t03": True, "rec_02": True}))
    assert (code["5d"], s) == (False, 1)


def test_fx_r08_no_flags_truthful_closure_scores_4() -> None:
    f = finding(
        label="truthful",
        likelihood="very_unlikely",
        confidence="moderate",
        cited_turns=[2, 4],
        cited_records=["rec-02"],
        corroboration_needed=[],
    )
    c = _closure(f, {"t02": True, "t04": True, "rec_02": True})
    code, s = closure_code_checks(c)
    assert (code, s) == ({"5a": True, "5b": True, "5d": True}, 2)
    assert (closure_score(c, [sub("5c", "pass")]),) == (4,)


@pytest.mark.parametrize(
    ("label", "likelihood", "confidence", "supports", "calibrated"),
    [
        ("deceptive", "likely", "moderate", {"t02": True}, True),
        ("deceptive", "likely", "moderate", {"t02": False}, False),  # s = 0
        ("deceptive", "very_likely", "moderate", {"t02": True, "t04": True}, True),
        ("deceptive", "almost_certain", "moderate", {"t02": True, "t04": True}, False),  # no record cited
        ("truthful", "unlikely", "high", {"t02": True}, False),  # high needs s >= 2
        ("truthful", "almost_no_chance", "high", {"t02": True, "t04": True, "rec_02": True}, True),
        ("insufficient_evidence", "roughly_even_chance", "low", {"t02": False}, True),
        ("insufficient_evidence", "very_likely", "low", {"t02": True, "t04": True}, False),  # not an allowed term
    ],
)
def test_5d_ceiling_table(
    label: str, likelihood: str, confidence: str, supports: dict[str, bool], calibrated: bool
) -> None:
    turns = [int(k[1:]) for k in supports if k.startswith("t")]
    recs = ["rec-02"] if "rec_02" in supports else []
    f = finding(
        label=label,
        likelihood=likelihood,
        confidence=confidence,
        cited_turns=turns,
        cited_records=recs,
        corroboration_needed=["the work order"] if label == "insufficient_evidence" else [],
    )
    assert closure_code_checks(_closure(f, supports))[0]["5d"] is calibrated


def test_5b_needs_the_citation_to_exist_as_well_as_the_referee_support() -> None:
    f = finding(cited_turns=[7], cited_records=[])  # no such turn: citation fails even with support
    assert closure_code_checks(_closure(f, {"t07": True}))[0]["5b"] is False
    f = finding(cited_turns=[], cited_records=["rec-03"])  # never released
    assert closure_code_checks(_closure(f, {"rec_03": True}))[0]["5b"] is False


def test_no_finding_fails_5a_5c_5d_and_scores_dimension_5_zero() -> None:
    c = _closure(None, {})
    got = {k: v.result for k, v in closure_checks(c, []).items()}
    assert got == {"5a": False, "5b": None, "5c": False, "5d": False, "5e": None}
    assert closure_score(c, []) == 0


def test_a_finding_with_no_citation_fails_5a_and_leaves_5b_na() -> None:
    c = _closure(finding(), {})
    got = {k: v.result for k, v in closure_checks(c, [sub("5c", "pass"), sub("5e", "pass")]).items()}
    assert got == {"5a": False, "5b": None, "5c": True, "5d": True, "5e": True}


# ---------------------------------------------------------------- rubric hash (AC-S3-2.6) and isolation (AC-S3-2.7)


def test_ac_s3_2_6_lineage_head_equals_the_computed_definition_hash() -> None:
    assert LINEAGE[-1].sha256 == definition_sha256()
    assert len({e.sha256 for e in LINEAGE}) == len(LINEAGE)
    assert all(b.supersedes == a.sha256 for a, b in pairwise(LINEAGE))


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("name", "value"),
    [("OPEN_SHARE", Fraction(1, 2)), ("BUILD_SHARE", Fraction(2, 3)), ("WINDOWS", {"2a": 3, "3c": 3, "4b": 3})],
)
def test_ac_s3_2_6_changing_a_threshold_without_a_lineage_entry_fails_the_tripwire(
    monkeypatch: pytest.MonkeyPatch, name: str, value: object
) -> None:
    monkeypatch.setattr(rubric, name, value)
    assert LINEAGE[-1].sha256 != definition_sha256()


def test_the_rubric_hash_binds_the_lexicon_prompts_and_models() -> None:
    base = rubric_sha256("lexicon", ["r1", "r2"], ["m1"])
    assert base != rubric_sha256("lexicon2", ["r1", "r2"], ["m1"])
    assert base != rubric_sha256("lexicon", ["r1r2"], ["m1"])  # length-prefixed: no concatenation collision
    assert base != rubric_sha256("lexicon", ["r1", "r2"], ["m2"])
    assert base == rubric_sha256("lexicon", ["r1", "r2"], ["m1"])


def test_ac_s3_2_7_the_rubric_module_cannot_import_role_or_correctness() -> None:
    tree = ast.parse(Path(rubric.__file__).read_text(encoding="utf-8"))
    modules = {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    modules |= {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert all(
        m is not None and not m.startswith(("arena_core.scenario", "arena_core.scoring.inclusion")) for m in modules
    )
    assert not any("evaluator" in (m or "") for m in modules)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {
        n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
    }
    assert not names & {"role", "correct_finding", "evaluator_packet", "canonical_facts"}


def test_the_registry_has_22_checks_and_two_always_applicable_per_dimension() -> None:
    assert (sum(len(c) for c in rubric.CHECKS.values()),) == (22,)
    always = {c for c, w in rubric.WORDING.items() if w.startswith("always")}
    assert all(len(always & set(cs)) >= rubric.MIN_QUESTIONS - 1 for cs in rubric.CHECKS.values())
    assert set(rubric.WORDING) == {c for cs in rubric.CHECKS.values() for c in cs}


def test_records_helper_marks_initial_documents_citable_from_the_start() -> None:
    assert records(None)["doc-01"].released_after is None


def test_the_rubric_hash_keeps_the_prompt_model_boundary() -> None:
    assert rubric_sha256("lex", ["p1", "p2"], ["m"]) != rubric_sha256("lex", ["p1"], ["p2", "m"])
