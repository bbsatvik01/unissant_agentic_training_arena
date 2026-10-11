"""Calibration statistics (S3 7): AC-S3-7.1..7.4; FX-C01 to FX-C03."""

from __future__ import annotations

from fractions import Fraction

from arena_core.scoring.calibration import (
    KAPPA_THRESHOLD,
    AgreementResult,
    CalibrationReport,
    TurnStratum,
    agreement,
    gwet_ac,
    sample_strata,
    weighted_kappa,
)

LABELS_0_4 = (0, 1, 2, 3, 4)
TARGET_PER_STRATUM = 5

# FX-C01 (S3 7.4): exact rationals, QWK 203/227, AC2 12/13 (pa = 47/48, pe = 35/48).
FX_C01_PROXY = [4, 3, 3, 2, 1, 0, 4, 2, 3, 1, 2, 4]
FX_C01_CONSENSUS = [4, 3, 2, 2, 1, 1, 4, 3, 3, 0, 2, 4]


def test_ac_s3_7_1_fx_c01_reproduces_the_pinned_qwk_and_ac2() -> None:
    qwk = weighted_kappa(FX_C01_PROXY, FX_C01_CONSENSUS, LABELS_0_4, weights="quadratic")
    ac2 = gwet_ac(FX_C01_PROXY, FX_C01_CONSENSUS, LABELS_0_4, weights="quadratic")
    assert qwk == Fraction(203, 227)
    assert ac2 == Fraction(12, 13)


def test_fx_c02_no_spread_is_uninformative_not_a_pass() -> None:
    # QWK is undefined (no expected disagreement to explain); Gwet's AC2 is defined (it does not suffer the
    # kappa paradox) but the combined status is still never "met" while either coefficient is missing.
    constant = [4] * 20
    result = agreement(constant, constant, LABELS_0_4, weights="quadratic")
    assert result.kappa is None
    assert result.status == "not met: uninformative sample"
    assert result.met is False


def test_ac_s3_7_2_fx_c02_is_not_a_pass_even_though_agreement_looks_perfect() -> None:
    # A proxy and consensus that agree on every item but never vary give no expected disagreement to explain:
    # the kappa paradox (FX-C03) is exactly this failure mode skewed toward one category.
    constant = [2] * 20
    assert weighted_kappa(constant, constant, LABELS_0_4, weights="quadratic") is None


def test_fx_c03_kappa_paradox_near_perfect_agreement_can_still_read_low() -> None:
    # 18 items both rated 4, then (3, 4) and (4, 3): QWK near -0.05 while AC2 stays near 0.92-1.0, exactly the
    # paradox S3 7.2 cites for why sampling is stratified by design, not by proxy output.
    proxy = [4] * 18 + [3, 4]
    consensus = [4] * 18 + [4, 3]
    qwk = weighted_kappa(proxy, consensus, LABELS_0_4, weights="quadratic")
    ac2 = gwet_ac(proxy, consensus, LABELS_0_4, weights="quadratic")
    assert qwk is not None
    assert qwk < 0
    assert ac2 is not None
    assert ac2 > Fraction(9, 10)
    result = AgreementResult(qwk, ac2, KAPPA_THRESHOLD, Fraction(7, 10))
    assert result.met is False
    assert result.status == "not met: calibration not met"


def test_identity_weights_give_cohens_kappa_and_ac1() -> None:
    proxy = ["evasion", "responsive", "evasion", "evasion", "responsive"]
    consensus = ["evasion", "responsive", "responsive", "evasion", "responsive"]
    labels = ("evasion", "responsive", "poorly_framed_question", "legitimate_non_disclosure", "genuine_uncertainty")
    kappa = weighted_kappa(proxy, consensus, labels, weights="identity")
    ac1 = gwet_ac(proxy, consensus, labels, weights="identity")
    assert kappa is not None
    assert 0 < kappa < 1
    assert ac1 is not None
    assert 0 < ac1 < 1


def test_ac_s3_7_3_the_report_is_never_met_while_one_item_misses_a_threshold() -> None:
    good = AgreementResult(Fraction(9, 10), Fraction(9, 10), KAPPA_THRESHOLD, Fraction(7, 10))
    bad = AgreementResult(Fraction(1, 10), Fraction(9, 10), KAPPA_THRESHOLD, Fraction(7, 10))
    report = CalibrationReport({"D1": good, "D2": good, "D3": bad, "D4": good, "D5": good})
    assert report.met is False
    assert report.status == "provisional: calibration not met"
    assert report.failing() == ("D3",)

    all_good = CalibrationReport({"D1": good, "D2": good})
    assert all_good.met is True
    assert all_good.status == "met"


def test_an_empty_report_is_never_met() -> None:
    assert CalibrationReport({}).met is False


# ---------------------------------------------------------------- AC-S3-7.4: the sampler never reads R1/R2


def test_ac_s3_7_4_the_sampler_type_carries_no_r1_or_r2_output_field() -> None:
    fields = set(TurnStratum.__dataclass_fields__)
    forbidden = {"label", "r1_label", "r2_verdict", "compliant", "flag_support", "eva_subtype", "pfq_reason"}
    assert not (fields & forbidden)


def test_the_sampler_draws_per_stratum_with_a_noncompliant_floor() -> None:
    items = [
        TurnStratum(turn_ref=f"t{i}", tag_proposal=tag, quality_level="medium", role="deceptive", noncompliant=nc)
        for i, (tag, nc) in enumerate([("A", False)] * 10 + [("A", True)] * 4 + [("B", False)] * 10 + [("B", True)] * 4)
    ]
    picked = sample_strata(
        items, seed=42, target_per_stratum=TARGET_PER_STRATUM, min_noncompliant_fraction=Fraction(1, 5)
    )
    by_tag: dict[str, list[TurnStratum]] = {}
    for item in picked:
        by_tag.setdefault(item.tag_proposal or "", []).append(item)
    assert set(by_tag) == {"A", "B"}
    for tag_items in by_tag.values():
        assert len(tag_items) == TARGET_PER_STRATUM
        assert sum(i.noncompliant for i in tag_items) >= 1


def test_the_sampler_is_deterministic_for_a_fixed_seed() -> None:
    items = [
        TurnStratum(turn_ref=f"t{i}", tag_proposal="A", quality_level="weak", role="truthful", noncompliant=False)
        for i in range(20)
    ]
    first = [i.turn_ref for i in sample_strata(items, seed=7, target_per_stratum=5)]
    second = [i.turn_ref for i in sample_strata(items, seed=7, target_per_stratum=5)]
    assert first == second
