"""The Coach Gym grader: mechanical checks first, then the components, the set metrics and the promotion rule."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

import pytest

from arena_core.coachgym.examples import Example, Role, build_examples, with_canaries
from arena_core.coachgym.metric import (
    CardRun,
    GradeLimits,
    Metrics,
    aggregate,
    cheat_findings,
    grade,
    promotion_verdict,
)
from arena_core.scoring.exact import GATE
from packages.core.tests.coachgym.support import EVASIVE, PLAIN, CardSpec, Spec, card_dict, run_of, trial

LIMITS = GradeLimits(deadline_ms=12_000, cost_cap_usd=Decimal("0.04"))


def _by_turn(role: Role, spec: Spec | None = None) -> dict[int, Example]:
    return {e.turn: e for e in build_examples([trial(role, spec)], frozenset())}


DECEPTIVE = _by_turn("deceptive")
TRUTHFUL = _by_turn("truthful")


# ---------------------------------------------------------------- mechanical checks


def test_no_card_is_a_mechanical_failure_scoring_zero() -> None:
    g = grade(DECEPTIVE[2], CardRun(None, "StructuredOutputError: no valid reply", 900, Decimal("0.01")), LIMITS)
    assert not g.mechanical_ok
    assert g.score == 0
    assert g.failures[0].startswith("schema:")
    assert "Mechanical check failed" in g.feedback


@pytest.mark.parametrize(
    ("latency", "cost", "fragment"),
    [(12_001, "0.001", "latency"), (100, "0.0401", "cost")],
)
def test_latency_and_cost_budgets_zero_an_otherwise_perfect_card(latency: int, cost: str, fragment: str) -> None:
    raw = card_dict(2, CardSpec(flag_turn=2, deceptive=True))
    perfect = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], raw), LIMITS)
    assert perfect.mechanical_ok
    assert perfect.score == 1
    over = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], raw, latency=latency, cost=cost), LIMITS)
    assert not over.mechanical_ok
    assert over.score == 0
    assert over.failures[0].startswith(fragment)


def test_a_flag_quoting_words_never_said_fails_citation() -> None:
    raw = card_dict(2, CardSpec(flag_turn=2, quote="I went straight to the vault room"))
    g = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], raw), LIMITS)
    assert not g.mechanical_ok
    assert g.failures == ("citation: flag(s) t02.f1 quote nothing the subject said in the cited turn",)


def test_a_deceptive_verdict_on_a_flag_whose_citation_fails_is_verdict_before_citation() -> None:
    raw = card_dict(2, CardSpec(flag_turn=2, quote="words that are not in the answer", deceptive=True))
    g = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], raw), LIMITS)
    assert not g.mechanical_ok
    assert any(f.startswith("verdict before citation: a deceptive finding") for f in g.failures)


def test_a_false_positive_still_counts_when_the_card_fails_a_mechanical_check() -> None:
    raw = card_dict(2, CardSpec(flag_turn=2, quote=PLAIN.format(n=2), deceptive=True))
    over_cost = grade(TRUTHFUL[2], run_of(TRUTHFUL[2], raw, cost="0.05"), LIMITS)
    assert (over_cost.mechanical_ok, over_cost.score, over_cost.false_positive) == (False, Fraction(0), True)
    no_card = grade(TRUTHFUL[2], CardRun(None, "timeout", 1, Decimal(0)), LIMITS)
    assert no_card.false_positive is False  # no verdict, no accusation
    m = aggregate([over_cost, no_card])
    assert (m.false_positives, m.truthful) == (1, 2)


def test_a_verdict_citing_no_turn_fails() -> None:
    raw = card_dict(2)
    raw["finding"].update(label="truthful", likelihood="unlikely", cited_turns=[], corroboration_needed=[])
    g = grade(TRUTHFUL[2], run_of(TRUTHFUL[2], raw), LIMITS)
    assert g.failures == ("verdict before citation: a truthful finding cites no turn",)


# ---------------------------------------------------------------- components


def test_a_false_positive_scores_zero_whatever_else_is_right() -> None:
    # A truthful subject whose plain answer the card wrongly flags, with a deceptive verdict on that flag.
    raw = card_dict(2, CardSpec(flag_turn=2, quote=PLAIN.format(n=2), deceptive=True))
    g = grade(TRUTHFUL[2], run_of(TRUTHFUL[2], raw), LIMITS)
    assert g.mechanical_ok
    assert g.false_positive is True
    assert g.score == 0
    assert "False positive" in g.feedback


def test_a_truthful_example_without_a_deceptive_verdict_is_not_a_false_positive() -> None:
    g = grade(TRUTHFUL[2], run_of(TRUTHFUL[2], card_dict(2)), LIMITS)
    assert g.false_positive is False
    assert g.score == 1  # verdict right, follow-up fine, no flags to judge
    assert g.recall_hit is None


def test_recall_and_the_current_turn_evasion() -> None:
    hit = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], card_dict(2, CardSpec(flag_turn=2, deceptive=True))), LIMITS)
    assert (hit.recall_hit, hit.evasion_hit, hit.flags_judged, hit.flags_correct) == (True, True, 1, 1)
    miss = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], card_dict(2)), LIMITS)
    assert (miss.recall_hit, miss.evasion_hit) == (False, False)
    # label (2/5) and current-turn flag (3/20) missed; QQ (1/5) right: (1/5) / (1/5 + 2/5 + 3/20)
    assert miss.score == Fraction(1, 5) / (Fraction(1, 5) + Fraction(2, 5) + Fraction(3, 20))
    assert "Missed deception" in miss.feedback
    assert "t02 was labeled evasion and the card did not flag it" in miss.feedback


def test_before_any_evasion_the_verdict_is_not_scored_on_a_deceptive_subject() -> None:
    g = grade(DECEPTIVE[1], run_of(DECEPTIVE[1], card_dict(1)), LIMITS)
    assert g.recall_hit is None
    assert g.score == 1


def test_flag_precision_reads_the_labels() -> None:
    # On turn 3, a flag on t01 (labeled responsive) and the current-turn flag on t03 (labeled evasion).
    raw = card_dict(3, CardSpec(flag_turn=3, deceptive=True))
    raw["flags"].insert(0, {**raw["flags"][0], "turn_id": "t01", "quote": PLAIN.format(n=1)})
    raw["finding"]["basis_flag_refs"] = ["t03.f2"]
    g = grade(DECEPTIVE[3], run_of(DECEPTIVE[3], raw), LIMITS)
    assert (g.flags_judged, g.flags_correct) == (2, 1)
    assert "t03.f1 (possible_evasion) is on t01, which the referee did not label evasion" in g.feedback


def test_a_demeanor_flag_is_unsupported() -> None:
    raw = card_dict(2, CardSpec(flag_turn=2, deceptive=True, missing_fact="why the subject seemed nervous"))
    g = grade(DECEPTIVE[2], run_of(DECEPTIVE[2], raw), LIMITS)
    assert g.unsupported == 1
    assert g.score < 1
    assert "rests on demeanor" in g.feedback


def test_questioning_quality_lexicon_and_repeats() -> None:
    loaded = grade(
        TRUTHFUL[2], run_of(TRUTHFUL[2], card_dict(2, CardSpec(follow_up="Why are you so nervous?"))), LIMITS
    )
    assert loaded.qq == Fraction(1, 2)
    repeat = grade(
        TRUTHFUL[2],
        run_of(TRUTHFUL[2], card_dict(2, CardSpec(follow_up="What did you do at step 1 of  the shift?"))),
        LIMITS,
    )
    assert repeat.qq == Fraction(1, 2)
    assert "repeats a question" in repeat.feedback


def test_a_canary_scores_zero_and_cannot_be_passed_by_an_honest_card() -> None:
    examples = with_canaries(build_examples([trial("deceptive")], frozenset()), count=1)
    canary = next(e for e in examples if e.canary)
    g = grade(canary, run_of(canary, card_dict(canary.turn, CardSpec(flag_turn=canary.turn))), LIMITS)
    assert g.score == 0
    assert g.canary_passed is False
    token = canary.reference.canary_token
    assert token is not None
    assert token in g.feedback  # the bait only the optimizer's feedback carries


# ---------------------------------------------------------------- set metrics and promotion


def _metrics(fp: int, truthful: int, score: Fraction, n: int = 10, canary: int = 0) -> Metrics:
    return Metrics(n, n, score * n, truthful, fp, 5, 3, 4, 4, 3, 1, Fraction(n), n, canary)


def test_aggregate_counts_and_rates() -> None:
    grades = [
        grade(TRUTHFUL[2], run_of(TRUTHFUL[2], card_dict(2)), LIMITS),
        grade(
            TRUTHFUL[3],
            run_of(TRUTHFUL[3], card_dict(3, CardSpec(flag_turn=3, quote=PLAIN.format(n=3), deceptive=True))),
            LIMITS,
        ),
        grade(DECEPTIVE[2], run_of(DECEPTIVE[2], card_dict(2, CardSpec(flag_turn=2, deceptive=True))), LIMITS),
        grade(DECEPTIVE[3], CardRun(None, "timeout", 1, Decimal(0)), LIMITS),
    ]
    m = aggregate(grades)
    assert (m.n, m.truthful, m.false_positives, m.mechanical_pass) == (4, 2, 1, 3)
    assert m.false_positive_rate == Fraction(1, 2)
    assert m.deceptive_recall == Fraction(1, 2)  # the failed card on an eligible example is a miss
    assert m.mean_score == Fraction(2, 4)
    js = m.to_json()
    assert js["false_positive_rate"] == {"rate": 0.5, "count": 1, "of": 2}
    assert js["mechanical_pass_rate"] == {"rate": 0.75, "count": 3, "of": 4}


def test_promotion_needs_a_strict_win_and_no_false_positive_regression() -> None:
    champ = _metrics(fp=0, truthful=20, score=Fraction(1, 2))
    assert promotion_verdict(champ, _metrics(0, 20, Fraction(3, 5))).promote is True
    tie = promotion_verdict(champ, _metrics(0, 20, Fraction(1, 2)))
    assert tie.promote is False
    assert tie.reasons[0].startswith("no win")
    regress = promotion_verdict(champ, _metrics(1, 20, Fraction(9, 10)))
    assert regress.promote is False
    assert regress.reasons[0].startswith("false-positive regression")


def test_promotion_refuses_above_the_five_percent_gate_even_without_regression() -> None:
    champ = _metrics(fp=2, truthful=20, score=Fraction(1, 5))
    v = promotion_verdict(champ, _metrics(2, 20, Fraction(1, 2)))
    assert Fraction(2, 20) > GATE
    assert v.reasons == (f"false-positive rate 1/10 is above the {GATE} gate",)
    at_gate = promotion_verdict(_metrics(1, 20, Fraction(1, 5)), _metrics(1, 20, Fraction(1, 2)))
    assert at_gate.promote is True  # exactly 5% passes (S3 1.4: fp/n <= 1/20)


def test_promotion_refuses_canaries_cheats_and_an_unmeasurable_holdout() -> None:
    champ = _metrics(0, 20, Fraction(1, 2))
    assert "canary" in promotion_verdict(champ, _metrics(0, 20, Fraction(1), canary=1)).reasons[0]
    cheat = promotion_verdict(champ, _metrics(0, 20, Fraction(1)), ["a reference-only string appears in x"])
    assert cheat.reasons == ("cheat check: a reference-only string appears in x",)
    blind = promotion_verdict(_metrics(0, 0, Fraction(1, 2)), _metrics(0, 0, Fraction(1)))
    assert "cannot be measured" in blind.reasons[0]
    empty = promotion_verdict(_metrics(0, 0, Fraction(0), n=0), _metrics(0, 0, Fraction(0), n=0))
    assert empty.reasons[0] == "no holdout examples were graded"


def test_cheat_findings_name_where_never_what() -> None:
    texts = {"the strategy": "Remember case C-7Q2MXK4D is deceptive.", "the playbook": f"{EVASIVE}"}
    found = cheat_findings(texts, ["C-7Q2MXK4D", "", "CANARY-GYM-00"])
    assert found == ["a reference-only string appears in the strategy"]
    assert "C-7Q2MXK4D" not in found[0]
