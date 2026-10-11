"""Assistant leaderboard body assembly (S3 5.5-5.6): FX-I01 through the body builder, a normal ranking, an
ineligible candidate, and the binding fields every row carries."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from fractions import Fraction

from arena_core.contracts.adapter import SubjectLabel
from arena_core.referee.leaderboard import (
    NOT_COMPUTED,
    Binding,
    CandidateInput,
    SubjectCandidateInput,
    SubjectTrialInput,
    TrialScore,
    _family_counts,
    build_assistant_leaderboard,
    build_subject_leaderboard,
)
from arena_core.scoring.exact import seed_for
from arena_core.scoring.flags import EvasionCounts, SupportCounts
from arena_core.scoring.inclusion import AsstInc, Exec, SubjInc
from arena_core.scoring.kpi import LatencyRow
from arena_core.scoring.metrics import TrialOutcome
from arena_core.scoring.ranking import IG_ITEMS, isolation_result, rank_intervals

BOOTSTRAP_B = 10_000
DETECTED = 8
MIXED_CANDIDATE_INCLUDED = 9
TWO_S1_TRUTHFUL = 2
HALF = 0.5
CLOSURE_D5 = 3

PASSING_ISOLATION = isolation_result({item: (True, f"{item}-hash") for item in IG_ITEMS})
FAILING_ISOLATION = isolation_result({item: (item != "IG-2", f"{item}-hash") for item in IG_ITEMS})

BINDING = Binding(
    manifest_sha256="m" * 64,
    manifest_version=1,
    scorer_git_sha="0" * 40,
    rubric_sha256="r" * 64,
    r1_prompt_sha256="p1" * 32,
    r2_prompt_sha256="p2" * 32,
    label_set_sha256="l" * 64,
    bootstrap_b=BOOTSTRAP_B,
)


def trials(*, family: str, role: str, output: str, n: int, subject: str = "") -> list[TrialOutcome]:
    inc = AsstInc.INCLUDED_AS_INSUFFICIENT if output == "insufficient_evidence" else AsstInc.INCLUDED
    label = None if output == "insufficient_evidence" else output
    return [TrialOutcome(family, role, inc, label, subject) for _ in range(n)]


def good_candidate(candidate_id: str) -> CandidateInput:
    # 10 truthful (all cleared, no false positives: eligible), 10 deceptive (8 detected -> recall 0.8).
    t = trials(family="F01", role="truthful", output="truthful", n=10)
    d = trials(family="F01", role="deceptive", output="deceptive", n=8) + trials(
        family="F01", role="deceptive", output="truthful", n=2
    )
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={},
        reasons=[("truthful", "included")] * 10 + [("deceptive", "included")] * 10,
        own_cost_rows=[(Decimal("0.01"), True)] * 20,
        own_planned=20,
    )


def ineligible_candidate(candidate_id: str) -> CandidateInput:
    # 10 truthful with 3 false positives: FPR 30% > 5%, ineligible.
    t = trials(family="F01", role="truthful", output="deceptive", n=3) + trials(
        family="F01", role="truthful", output="truthful", n=7
    )
    d = trials(family="F01", role="deceptive", output="deceptive", n=5)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={},
        reasons=[("truthful", "included")] * 10 + [("deceptive", "included")] * 5,
        own_cost_rows=[(Decimal("0.01"), True)] * 15,
        own_planned=15,
    )


def ineligible_candidate_with_a_foreign_family(candidate_id: str) -> CandidateInput:
    # Ineligible (30% FPR), and its own family "F99" is one no eligible candidate has any trial in.
    t = trials(family="F99", role="truthful", output="deceptive", n=3) + trials(
        family="F99", role="truthful", output="truthful", n=7
    )
    d = trials(family="F99", role="deceptive", output="deceptive", n=5)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={},
        reasons=[("truthful", "included")] * 10 + [("deceptive", "included")] * 5,
        own_cost_rows=[(Decimal("0.01"), True)] * 15,
        own_planned=15,
    )


def excluded_deceptive_family_candidate(candidate_id: str) -> CandidateInput:
    # F01: 5 deceptive trials, all detected (complete, not failed). F02: one included deceptive trial that
    # missed, plus one EXCLUDED deceptive trial -- Codex finding #13: M21's "complete family" test must drop
    # F02 entirely (an excluded trial anywhere in a family means that family is never complete), never let
    # its included miss count as evidence either way.
    t = trials(family="F01", role="truthful", output="truthful", n=5)
    d_f01 = trials(family="F01", role="deceptive", output="deceptive", n=5)
    d_f02_miss = trials(family="F02", role="deceptive", output="truthful", n=1)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d_f01 + d_f02_miss,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={"F02": 1},
        reasons=[("truthful", "included")] * 5 + [("deceptive", "included")] * 6 + [("deceptive", "infra_failed")],
        own_cost_rows=[(Decimal("0.01"), True)] * 11,
        own_planned=12,
    )


def mixed_outcomes_candidate(candidate_id: str) -> CandidateInput:
    # Codex finding #15: a role-skewed mix built specifically to make M03's point, M04's synthetic-
    # insufficient sub-counts, and M23's per-role breakdown all read something other than zero or "same as
    # overall" -- 1 truthful false positive (PPV < 1), 1 insufficient trial on EACH role, 1 excluded trial
    # on EACH role with a DIFFERENT reason, so overall and per-role execution rates provably differ.
    t_normal = trials(family="F01", role="truthful", output="truthful", n=3)
    t_fp = trials(family="F01", role="truthful", output="deceptive", n=1)
    t_insuff = trials(family="F01", role="truthful", output="insufficient_evidence", n=1)
    d_detected = trials(family="F01", role="deceptive", output="deceptive", n=2)
    d_miss = trials(family="F01", role="deceptive", output="truthful", n=1)
    d_insuff = trials(family="F01", role="deceptive", output="insufficient_evidence", n=1)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t_normal + t_fp + t_insuff + d_detected + d_miss + d_insuff,
        excluded_truthful_by_family={"F01": 1},
        excluded_deceptive_by_family={"F01": 1},
        reasons=(
            [("truthful", "included")] * 5
            + [("truthful", "subject_invalid")]
            + [("deceptive", "included")] * 4
            + [("deceptive", "infra_failed")]
        ),
        own_cost_rows=[(Decimal("0.01"), True)] * 9,
        own_planned=11,
    )


def truthful_only_family_candidate(candidate_id: str) -> CandidateInput:
    # No deceptive trial anywhere -- M21 must publish "undefined: no complete families", never score this
    # family as a zero-event success (Codex finding #8: `role_clusters`' own cluster list covers every
    # family touched by ANY role, so a truthful-only family's (det=0, inc_d=0) cluster must never be read
    # as "0 misses out of 0" and counted complete).
    t = trials(family="F01", role="truthful", output="truthful", n=1)
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={},
        reasons=[("truthful", "included")],
        own_cost_rows=[(Decimal("0.01"), True)],
        own_planned=1,
    )


def two_subjects_candidate(candidate_id: str) -> CandidateInput:
    # Codex finding #11 (M05's required per-subject breakdown): two distinct subjects' own trials must
    # never collapse into one bucket.
    t1 = trials(family="F01", role="truthful", output="truthful", n=2, subject="S1")
    d1 = trials(family="F01", role="deceptive", output="deceptive", n=1, subject="S1")
    t2 = trials(family="F01", role="truthful", output="deceptive", n=1, subject="S2")
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t1 + d1 + t2,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={},
        reasons=[("truthful", "included")] * 3 + [("deceptive", "included")],
        own_cost_rows=[(Decimal("0.01"), True)] * 4,
        own_planned=4,
    )


def tied_but_attrition_sensitive_candidate(candidate_id: str) -> CandidateInput:
    # Same recall and tied rank as good_candidate (8/10 included -> 0.8), but one further deceptive trial
    # was excluded rather than included (F14): `exc_d` must carry that exclusion, or the attrition
    # sensitivity it feeds can never see it (Codex finding #11 -- a hardcoded exc_d=0 hides it).
    t = trials(family="F01", role="truthful", output="truthful", n=10)
    d = trials(family="F01", role="deceptive", output="deceptive", n=8) + trials(
        family="F01", role="deceptive", output="truthful", n=2
    )
    return CandidateInput(
        candidate_id=candidate_id,
        display_name=candidate_id,
        trials=t + d,
        excluded_truthful_by_family={},
        excluded_deceptive_by_family={"F01": 1},
        reasons=[("truthful", "included")] * 10 + [("deceptive", "included")] * 10 + [("deceptive", "infra_failed")],
        own_cost_rows=[(Decimal("0.01"), True)] * 20,
        own_planned=21,
    )


def test_fx_i01_isolation_fail_yields_not_ranked_with_no_rows() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=FAILING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    assert body["status"] == "not ranked: isolation gate failed"
    assert body["rows"] == []
    assert body["board"] == "assistant"


def test_an_eligible_candidate_is_ranked_with_m01_and_m02() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    assert row["rank"] == 1
    assert row["eligibility"]["eligible"] is True
    m01 = row["metrics"]["M01_deceptive_recall"]["point"]
    assert Fraction(m01["num"], m01["den"]) == Fraction(8, 10)
    assert row["metrics"]["M02_false_positive_rate"]["point"]["value"] == 0.0
    assert row["metrics"]["M05_count_matrix"]["deceptive"]["deceptive"] == DETECTED
    assert Decimal(row["metrics"]["M22_cost"]["total"]) == Decimal("0.20")


def test_m03_publishes_a_point_estimate_alongside_the_interval() -> None:
    # Codex finding #15: M03 (PPV) must name a point estimate, the same way M01/M02 do -- det=2, fp=1 ->
    # PPV = 2/3, never 1 (which a candidate with zero false positives, like good_candidate, cannot show).
    body = build_assistant_leaderboard(
        candidates=[mixed_outcomes_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    m03 = row["metrics"]["M03_ppv"]["point"]
    assert Fraction(m03["num"], m03["den"]) == Fraction(2, 3)


def test_m04_publishes_the_synthetic_insufficient_sub_count_per_role() -> None:
    # Codex finding #15: M04 must name how many of each role's included trials were the synthetic
    # "insufficient_evidence" outcome (`assistant_failed`), not just the unresolved-rate interval.
    body = build_assistant_leaderboard(
        candidates=[mixed_outcomes_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    m04 = row["metrics"]["M04_unresolved_rate"]
    assert m04["truthful"]["synthetic_insufficient"] == 1
    assert m04["deceptive"]["synthetic_insufficient"] == 1


def test_m23_publishes_a_per_role_breakdown_alongside_the_overall_rate() -> None:
    # Codex finding #15: M23's overall rate can hide a role-specific execution pattern -- this candidate's
    # truthful rows are never "infra_failed" and its deceptive rows are never "subject_invalid".
    body = build_assistant_leaderboard(
        candidates=[mixed_outcomes_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    m23 = row["metrics"]["M23_execution_rates"]
    assert m23["overall"]["included"]["count"] == MIXED_CANDIDATE_INCLUDED
    assert m23["by_role"]["truthful"]["subject_invalid"]["count"] == 1
    assert "subject_invalid" not in m23["by_role"]["deceptive"]
    assert m23["by_role"]["deceptive"]["infra_failed"]["count"] == 1
    assert "infra_failed" not in m23["by_role"]["truthful"]


def test_an_ineligible_candidate_is_listed_never_ranked() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1"), ineligible_candidate("A2")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    by_id = {row["candidate_id"]: row for row in body["rows"]}
    assert by_id["A1"]["rank"] == 1
    assert by_id["A2"]["rank"] is None
    assert by_id["A2"]["eligibility"]["eligible"] is False


def test_m01_rank_interval_bootstrap_pool_excludes_ineligible_candidates() -> None:
    # Codex finding #12: `rank_intervals`'s own docstring says its family pool is "every family with any
    # included trial for any ELIGIBLE candidate" and that it never re-decides eligibility -- an ineligible
    # candidate's own family ("F99", no eligible candidate has a trial in it) must never widen that pool.
    # The published interval for the one eligible candidate must equal a bootstrap run against that
    # candidate alone -- any extra family in the pool would shift it.
    eligible = good_candidate("A1")
    foreign = ineligible_candidate_with_a_foreign_family("A2")
    body = build_assistant_leaderboard(
        candidates=[eligible, foreign], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    expected = rank_intervals(
        {eligible.candidate_id: _family_counts(eligible.trials)},
        seed=seed_for(BINDING.manifest_sha256, "rank_interval", "all", "I"),
        b=BOOTSTRAP_B,
    )[eligible.candidate_id]
    row = next(r for r in body["rows"] if r["candidate_id"] == "A1")
    assert row["rank_interval"]["lo"] == expected.lo
    assert row["rank_interval"]["hi"] == expected.hi


def test_every_row_carries_the_binding_fields_and_the_not_computed_list() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    assert body["binding"]["manifest_sha256"] == BINDING.manifest_sha256
    assert body["binding"]["bootstrap_b"] == BOOTSTRAP_B
    assert set(body["not_computed"]) == set(NOT_COMPUTED)


def test_f14_an_excluded_deceptive_trial_makes_a_tied_rank_provisional() -> None:
    # Codex finding #11: `exc_d` must come from the candidate's own excluded-deceptive count, not a
    # hardcoded 0 -- a tie at the same rank where one side has an excluded deceptive trial is exactly the
    # case F14's attrition sensitivity exists to flag as provisional (the tie could split the other way).
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1"), tied_but_attrition_sensitive_candidate("A2")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    by_id = {row["candidate_id"]: row for row in body["rows"]}
    assert by_id["A1"]["rank"] == by_id["A2"]["rank"]
    assert body["status"] == "provisional"


def test_m21_a_family_with_an_excluded_deceptive_trial_is_never_complete() -> None:
    # Codex finding #13: F02's one excluded deceptive trial must drop F02 from the zero-event bound
    # entirely; only F01 (complete, all detected) counts, giving the zero-event bound over n=1, not the
    # family-failure bound a wrongly-counted F02 miss would give over n=2.
    body = build_assistant_leaderboard(
        candidates=[excluded_deceptive_family_candidate("A1")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    [row] = body["rows"]
    bound = row["metrics"]["M21_zero_event_bound"]
    assert bound["families"] == 1
    assert bound["failed"] == 0
    # Codex finding #9: M01's own required family lower bound is the complement of M21's bound here (S3
    # 5.1's "symmetric lower bound for an all-detected recall"), not merely absent.
    m01_lower = row["metrics"]["M01_deceptive_recall"]["family_lower_bound"]
    assert m01_lower["bound"] == 1 - bound["bound"]
    assert m01_lower["families"] == 1
    assert bound["kind"] == "one-sided 95% zero-event bound (equal sizes)"


def test_m21_a_family_with_no_deceptive_trials_is_never_counted_complete() -> None:
    # Codex finding #8: a truthful-only family must never read as a complete, zero-miss deceptive family.
    body = build_assistant_leaderboard(
        candidates=[truthful_only_family_candidate("A1")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    [row] = body["rows"]
    bound = row["metrics"]["M21_zero_event_bound"]
    assert bound["families"] == 0
    assert bound["bound"] is None
    assert bound["kind"] == "undefined: no complete families"
    assert row["metrics"]["M01_deceptive_recall"]["family_lower_bound"] is None


def test_m05_publishes_a_per_subject_count_matrix_breakdown() -> None:
    # Codex finding #11: M05's required per-subject breakdown (S3 5.2) must keep each subject separate.
    body = build_assistant_leaderboard(
        candidates=[two_subjects_candidate("A1")], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    [row] = body["rows"]
    by_subject = row["metrics"]["M05_count_matrix"]["by_subject"]
    assert by_subject["S1"]["truthful"]["truthful"] == TWO_S1_TRUTHFUL
    assert by_subject["S1"]["deceptive"]["deceptive"] == 1
    assert by_subject["S2"]["truthful"]["deceptive"] == 1


def test_the_body_is_json_serializable() -> None:
    body = build_assistant_leaderboard(
        candidates=[good_candidate("A1"), ineligible_candidate("A2")],
        isolation=PASSING_ISOLATION,
        qq_calibrated=True,
        binding=BINDING,
    )
    json.dumps(body)  # raises on anything non-serializable (Fraction, Decimal left unconverted, etc.)


def _scored(c: CandidateInput, qq: Fraction | None, *, closure: int | None = None) -> CandidateInput:
    """`c` with every included trial scored at the same QQ, one supported strict flag per deceptive trial that
    matched an evasion event, and closure `closure` on each trial."""
    scored = [
        TrialScore(
            family_id=t.family_id,
            qq=qq,
            closure=closure,
            strict=EvasionCounts(tp=1, flags=1, events=1) if t.role == "deceptive" else EvasionCounts(0, 0, 0),
            broad=EvasionCounts(tp=1, flags=2, events=1) if t.role == "deceptive" else EvasionCounts(0, 0, 0),
            support=SupportCounts(
                unique=2, unsupported={"citation": 1, "demeanor": 0, "claim": 0}, emitted=2, demeanor_based=0
            ),
        )
        for t in c.trials
    ]
    return replace(c, scored=scored)


def test_equal_recall_candidates_are_ordered_by_their_real_questioning_quality() -> None:
    # Codex r3 #3: QQ was always None, so equal recall always tied. Same recall (8/10), different QQ.
    low, high = _scored(good_candidate("A1"), Fraction(1, 2)), _scored(good_candidate("A2"), Fraction(3, 4))
    body = build_assistant_leaderboard(
        candidates=[low, high], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    by_id = {row["candidate_id"]: row for row in body["rows"]}
    assert (by_id["A2"]["rank"], by_id["A1"]["rank"]) == (1, 2)
    m09 = by_id["A2"]["metrics"]["M09_questioning_quality"]
    assert Fraction(m09["point"]["num"], m09["point"]["den"]) == Fraction(3, 4)
    assert m09["coverage"]["value"] == 1.0
    assert m09["calibrated"] is True
    assert m09["provisional"] is False
    assert body["status"] == "definitive"
    # The bootstrap carries QQ too: A2 ranks first in every resample (recall is identical by construction).
    assert by_id["A2"]["rank_interval"]["share_first"] == {"num": 1, "den": 1}
    assert by_id["A1"]["rank_interval"]["share_first"]["num"] == 0
    assert by_id["A1"]["rank_interval"]["lo"] == by_id["A1"]["rank_interval"]["hi"] == by_id["A1"]["rank"]
    # Uncalibrated QQ deciding a rank keeps the board provisional (S3 5.5).
    uncalibrated = build_assistant_leaderboard(
        candidates=[low, high], isolation=PASSING_ISOLATION, qq_calibrated=False, binding=BINDING
    )
    assert uncalibrated["status"] == "provisional"


def test_low_qq_coverage_is_published_and_makes_a_qq_decided_board_provisional() -> None:
    half = _scored(good_candidate("A1"), Fraction(1, 2))
    half = replace(half, scored=[replace(s, qq=None) if i % 2 else s for i, s in enumerate(half.scored)])
    other = _scored(good_candidate("A2"), Fraction(3, 4))
    body = build_assistant_leaderboard(
        candidates=[half, other], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )
    row = next(r for r in body["rows"] if r["candidate_id"] == "A1")
    assert row["metrics"]["M09_questioning_quality"]["coverage"]["value"] == HALF
    assert row["metrics"]["M09_questioning_quality"]["provisional"] is True
    assert body["status"] == "provisional"


def test_m06_m07_m08_m10_and_m16_are_computed_from_the_trial_scores_and_latency() -> None:
    commit = datetime(2026, 10, 1, tzinfo=UTC)
    latency = [
        LatencyRow("t1", 1, "harness", "delivered", commit, None, commit + timedelta(seconds=1)),
        LatencyRow("t1", 2, "harness", "timeout", commit, None, None),
        LatencyRow("t2", 1, "practice_client", "delivered", commit, commit, commit),  # not a harness turn
    ]
    c = replace(_scored(good_candidate("A1"), Fraction(1, 2), closure=CLOSURE_D5), latency=latency)
    [row] = build_assistant_leaderboard(
        candidates=[c], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )["rows"]
    m = row["metrics"]
    assert m["M06_evasion_precision"]["strict"]["point"]["value"] == 1.0
    assert m["M06_evasion_precision"]["broad"]["point"]["value"] == HALF
    assert m["M07_evasion_recall"]["strict"]["point"]["value"] == 1.0
    assert m["M08_unsupported_flag_rate"]["point"]["value"] == HALF
    assert m["M08_unsupported_flag_rate"]["reasons"] == {"citation": 20, "demeanor": 0, "claim": 0}
    assert m["M10_closure_support"]["point"]["value"] == CLOSURE_D5
    assert m["M16_coaching_latency"]["share_within_3s"]["value"] == HALF
    assert m["M16_coaching_latency"]["measured"] == len(latency) - 1
    assert not {"M06", "M07", "M08", "M09", "M10", "M16"} & {k[:3] for k in NOT_COMPUTED}


def test_an_unscored_trial_leaves_the_flag_metrics_undefined_rather_than_zero() -> None:
    c = replace(good_candidate("A1"), scored=[TrialScore(family_id=t.family_id) for t in good_candidate("A1").trials])
    [row] = build_assistant_leaderboard(
        candidates=[c], isolation=PASSING_ISOLATION, qq_calibrated=True, binding=BINDING
    )["rows"]
    assert row["metrics"]["M06_evasion_precision"]["strict"]["point"] is None
    assert row["metrics"]["M09_questioning_quality"]["point"] is None
    assert row["metrics"]["M09_questioning_quality"]["coverage"]["value"] == 0.0


# ---------------------------------------------------------------- subject board (M12-M15)


def _label(n: int, *, compliant: bool = True, asked: str = "known", uncertain: bool = False) -> SubjectLabel:
    return SubjectLabel(
        turn_no=n,
        label="responsive",
        eva_subtype=None,
        pfq_reason=None,
        asked_fact_status=asked,
        uncertainty_expressed=uncertain,
        innocent_explanation_offered=False,
        asked_fact_ids=(),
        violated_fact_ids=(),
        record_conflict_ids=(),
        f1=compliant,
        f2_f4=True,
        f3=True,
        f5=True,
        f6=True,
        style_followed=True,
        compliant=compliant,
        rationale="r",
    )


def _subject_trial(role: str, output: str | None, *, compliant: bool = True) -> SubjectTrialInput:
    labels = {1: _label(1, compliant=compliant), 2: _label(2, asked="unknown", uncertain=True)}
    return SubjectTrialInput(
        family_id="F01",
        role=role,
        track="interactive",
        assistant_id="A1",
        exec_state=Exec.COMPLETED,
        subj_inc=SubjInc.COUNTED,
        verdict="valid",
        output=output,
        labels=labels,
    )


def test_the_subject_board_publishes_m12_to_m15_ordered_by_fidelity_and_unranked() -> None:
    faithful = SubjectCandidateInput(
        candidate_id="S1",
        display_name="S1",
        trials=[
            _subject_trial("deceptive", "truthful"),  # misleading clearance: a success
            _subject_trial("deceptive", "deceptive"),  # detected
            _subject_trial("truthful", "truthful"),  # correct recognition
        ],
    )
    sloppy = SubjectCandidateInput(
        candidate_id="S2",
        display_name="S2",
        trials=[
            _subject_trial("deceptive", "truthful", compliant=False),  # noncompliant_undetected
            replace(_subject_trial("truthful", None), subj_inc=SubjInc.AGAINST_SUBJECT, verdict="subject_invalid"),
            replace(
                _subject_trial("deceptive", None),
                exec_state=Exec.SUBJECT_QUARANTINED,
                subj_inc=SubjInc.AGAINST_SUBJECT,
                verdict=None,
                labels=None,
            ),
        ],
    )
    body = build_subject_leaderboard(candidates=[sloppy, faithful], isolation=PASSING_ISOLATION, binding=BINDING)
    assert body["board"] == "subject"
    assert body["status"] == "unranked"
    assert [r["candidate_id"] for r in body["rows"]] == ["S1", "S2"]  # by M12 point, highest first
    s1, s2 = body["rows"]
    assert s1["rank"] is None
    m12 = s1["metrics"]["M12_subject_fidelity"]
    assert m12["primary"]["point"]["value"] == 1.0
    # S2: 1 non-compliant of 2 + 2 compliant of 2 + 1 quarantined artifact (non-compliant): 3 of 5.
    assert Fraction(**_nd(s2["metrics"]["M12_subject_fidelity"]["primary"]["point"])) == Fraction(3, 5)
    assert s2["metrics"]["M12_subject_fidelity"]["valid_session"]["point"]["value"] == HALF
    assert Fraction(**_nd(s2["metrics"]["M13_invalid_session_rate"]["point"])) == Fraction(2, 3)
    assert s1["metrics"]["M14_deceptive_success"]["outcomes"]["success_misleading"] == 1
    assert s1["metrics"]["M14_deceptive_success"]["outcomes"]["detected"] == 1
    assert s2["metrics"]["M14_deceptive_success"]["outcomes"]["noncompliant_undetected"] == 1
    assert s2["metrics"]["M14_deceptive_success"]["outcomes"]["invalid"] == 1
    assert s1["metrics"]["M14_deceptive_success"]["by_assistant"]["A1"]["success_misleading"] == 1
    credit = s1["metrics"]["M15_truthful_credit"]
    assert credit["factual_consistency"]["point"]["value"] == 1.0
    assert credit["appropriate_uncertainty"]["point"]["value"] == 1.0
    assert credit["correct_recognition"]["point"]["value"] == 1.0
    assert body["binding"]["manifest_sha256"] == BINDING.manifest_sha256
    json.dumps(body)


def _nd(point: dict[str, int]) -> dict[str, int]:
    return {"numerator": point["num"], "denominator": point["den"]}
