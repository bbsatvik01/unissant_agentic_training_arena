"""The published fairness audit (S3 8; FA-1 to FA-6), on fixtures whose expected figures are computed by hand here,
independently of the code: counts and points per stratum, the family-level bound for small strata, FA-3's counts,
the Holm step-down, and the negative controls the audit must catch (AC-S3-8.1, 8.2, 8.4)."""

from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

import pytest

from arena_core.referee import fairness_audit as fa
from arena_core.referee.fairness_audit import (
    FairTrial,
    LabelTrial,
    fairness_audit,
    negative_controls,
    with_fairness,
)

MANIFEST = "m" * 64
B_SMALL = 999
ALPHA = 0.05
HALF = 9
NC_FLAGS = 18  # FX-F01: 6 pairs x 3 hesitation-citing flags on each hesitant member


def _trial(family: str, role: str, style: str, output: str | None) -> FairTrial:
    return FairTrial(
        candidate_id="A1",
        track="I",
        family_id=family,
        variant_id=f"{family}-{role}",
        role=role,
        style={"verbosity": style},
        output=output,
        subject_id="S1",
    )


def test_fa1_small_strata_publish_counts_point_and_the_family_bound() -> None:
    # terse: F1 false positive, F2 and F3 correct -> 1/3; expansive: F4..F6 correct -> 0/3; three families each,
    # under the five needed for a bootstrap, so each stratum carries the exact family-level bound (AC-S3-8.4).
    trials = [
        _trial("F1", "truthful", "terse", "deceptive"),
        _trial("F2", "truthful", "terse", "truthful"),
        _trial("F3", "truthful", "terse", "truthful"),
        _trial("F4", "truthful", "expansive", "truthful"),
        _trial("F5", "truthful", "expansive", "truthful"),
        _trial("F6", "truthful", "expansive", "insufficient_evidence"),
    ]
    audit = fairness_audit(trials, [], MANIFEST, b=B_SMALL)
    rows = {r["style"]: r for r in audit["style_fpr"]}
    assert set(rows) == {"verbosity=terse", "verbosity=expansive"}
    terse, expansive = rows["verbosity=terse"], rows["verbosity=expansive"]
    assert (terse["num"], terse["den"], terse["families"]) == (1, 3, 3)
    assert Fraction(terse["point"]["num"], terse["point"]["den"]) == Fraction(1, 3)
    assert (expansive["num"], expansive["den"]) == (0, 3)
    assert terse["interval"] is None
    assert (terse["bound"]["families"], terse["bound"]["failed"]) == (3, 1)
    assert expansive["bound"]["failed"] == 0


def test_fa1_bound_counts_only_families_whose_truthful_cells_are_all_included() -> None:
    trials = [
        _trial("F1", "truthful", "terse", "truthful"),
        _trial("F2", "truthful", "terse", "truthful"),
        replace(_trial("F2", "truthful", "terse", None), variant_id="F2-truthful-repeat"),  # excluded: F2 incomplete
    ]
    [row] = fairness_audit(trials, [], MANIFEST, b=B_SMALL)["style_fpr"]
    # both families have an included trial; only F1 is complete
    assert (row["families"], row["bound"]["families"]) == (2, 1)


def test_fa2_flag_rates_are_unique_flags_per_subject_turn_by_style_and_role() -> None:
    trials = [
        replace(_trial("F1", "truthful", "terse", "truthful"), unique_flags=2, subject_turns=10),
        replace(_trial("F1", "deceptive", "terse", "deceptive"), unique_flags=6, subject_turns=12),
        replace(_trial("F2", "truthful", "terse", "truthful"), unique_flags=1, subject_turns=10),
        replace(
            _trial("F3", "truthful", "expansive", "truthful"), unique_flags=None, subject_turns=10
        ),  # unscored: absent
    ]
    rows = {(r["style"], r["role"]): r for r in fairness_audit(trials, [], MANIFEST, b=B_SMALL)["flag_rates"]}
    assert set(rows) == {("verbosity=terse", "truthful"), ("verbosity=terse", "deceptive")}
    assert (rows["verbosity=terse", "truthful"]["num"], rows["verbosity=terse", "truthful"]["den"]) == (3, 20)
    assert (rows["verbosity=terse", "deceptive"]["num"], rows["verbosity=terse", "deceptive"]["den"]) == (6, 12)


def test_fa3_counts_demeanor_flags_and_findings_and_marks_a_violation() -> None:
    trials = [
        replace(
            _trial("F1", "truthful", "terse", "deceptive"), emitted_flags=4, demeanor_flags=1, finding_demeanor=True
        ),
        replace(_trial("F2", "truthful", "terse", "truthful"), emitted_flags=6, demeanor_flags=0),
        replace(_trial("F3", "truthful", "terse", None), emitted_flags=9, demeanor_flags=9),  # excluded: not counted
    ]
    [row] = fairness_audit(trials, [], MANIFEST, b=B_SMALL)["demeanor"]
    assert (row["flags"], row["findings"], row["emitted_flags"]) == (1, 1, 10)
    assert Fraction(row["per_100_flags"]["num"], row["per_100_flags"]["den"]) == Fraction(10)
    assert row["violation"] is True
    clean = [replace(_trial("F2", "truthful", "terse", "truthful"), emitted_flags=6, demeanor_flags=0)]
    assert fairness_audit(clean, [], MANIFEST, b=B_SMALL)["demeanor"][0]["violation"] is False


def _flagging(hesitant_flags: int) -> list[FairTrial]:
    """Six content-matched families in two renderings; the coach flags only the hesitant member (FX-F01) or flags
    both at the same rate (FX-F02)."""
    out = []
    for i in range(6):
        for style, flags in (("plain", 3), ("hesitant", hesitant_flags)):
            out.append(
                replace(
                    _trial(f"F{i}", "truthful", style, "truthful"),
                    variant_id=f"F{i}-{style}",
                    unique_flags=flags,
                    subject_turns=12,
                )
            )
    return out


def test_fa5b_detects_a_style_driven_coach_and_holm_adjusts_every_fa5_test() -> None:
    audit = fairness_audit(_flagging(12), [], MANIFEST, b=B_SMALL)
    tests = {t["test"]: t for t in audit["tests"]}
    assert tests["FA-5b:verbosity:truthful"]["p_value"] < ALPHA
    # Holm, by hand: the defined p-values sorted ascending, multiplier m - i, running maximum, capped at 1.
    defined = sorted((t["p_value"], name) for name, t in tests.items() if t["p_value"] is not None)
    running = 0.0
    for i, (p, name) in enumerate(defined):
        running = max(running, min(1.0, (len(defined) - i) * p))
        assert tests[name]["p_holm"] == pytest.approx(running)
    assert tests["FA-5b:verbosity:truthful"]["significant_after_holm"] is True
    for name, t in tests.items():
        if t["p_value"] is None:  # undefined tests (nothing varies) are published as such, outside Holm's m
            assert t["p_holm"] is None
            assert name in ("FA-5a:verbosity", "FA-5c", "FA-5d")


def test_fa5b_is_not_significant_for_a_content_based_coach() -> None:
    tests = {t["test"]: t for t in fairness_audit(_flagging(3), [], MANIFEST, b=B_SMALL)["tests"]}
    assert tests["FA-5b:verbosity:truthful"]["p_value"] == 1.0
    assert tests["FA-5b:verbosity:truthful"]["significant_after_holm"] is False


def test_fa5b_tests_each_role_so_opposite_effects_never_cancel() -> None:
    # truthful: plain 6/12 flags per turn, hesitant 0/12; deceptive the reverse. Pooled over roles every variant pair
    # sums to the same rate (range 0, p = 1); per role the observed range 1/2 is reached only by the 2 of the
    # C(12, 6) = 924 style assignments that split the 12 units exactly as observed: p <= (1 + B * 2/924)/(1 + B).
    trials = []
    for i in range(6):
        for role, rates in (("truthful", (6, 0)), ("deceptive", (0, 6))):
            for style, flags in zip(("plain", "hesitant"), rates, strict=True):
                trials.append(
                    replace(
                        _trial(f"F{i}", role, style, role),
                        variant_id=f"F{i}-{role}-{style}",
                        unique_flags=flags,
                        subject_turns=12,
                    )
                )
    tests = {t["test"]: t for t in fairness_audit(trials, [], MANIFEST, b=B_SMALL)["tests"]}
    assert tests["FA-5b:verbosity:truthful"]["p_value"] < ALPHA
    assert tests["FA-5b:verbosity:deceptive"]["p_value"] < ALPHA
    assert (tests["FA-5b:verbosity:truthful"]["n"], tests["FA-5b:verbosity:truthful"]["units"]) == (144, 12)


def test_fa5c_order_effect_over_block_positions() -> None:
    # FX-F03's arrangement: correct at positions 1..9, wrong at 10..18 in one block.
    trials = [
        replace(
            _trial(f"F{p}", "truthful", "terse", "truthful" if p <= HALF else "deceptive"), block_id="B1", position=p
        )
        for p in range(1, 19)
    ]
    tests = {t["test"]: t for t in fairness_audit(trials, [], MANIFEST, b=B_SMALL)["tests"]}
    assert tests["FA-5c"]["p_value"] < ALPHA


def test_fa4_label_rates_by_style_among_truthful_turns() -> None:
    labels = [
        LabelTrial(
            candidate_id="A1",
            track="I",
            family_id="F1",
            style={"verbosity": "terse"},
            turns=[("evasion", "stall", False), ("responsive", None, True)],
        ),
        LabelTrial(
            candidate_id="A1",
            track="I",
            family_id="F2",
            style={"verbosity": "terse"},
            turns=[("evasion", "omission", True), ("responsive", None, True)],
        ),
    ]
    rows = {r["measure"]: r for r in fairness_audit([], labels, MANIFEST, b=B_SMALL)["label_audit"]}
    assert (rows["evasion"]["num"], rows["evasion"]["den"]) == (2, 4)
    assert (rows["stall"]["num"], rows["stall"]["den"]) == (1, 4)
    assert (rows["compliant"]["num"], rows["compliant"]["den"]) == (3, 4)


def test_fa4_is_per_candidate_and_track() -> None:
    # A1's transcripts: every turn evasion; B2's: none. Pooled they would read as one anonymous 1/2.
    labels = [
        LabelTrial(candidate_id=c, track="I", family_id=f, style={"verbosity": "terse"}, turns=[(label, None, True)])
        for c, label in (("A1", "evasion"), ("B2", "responsive"))
        for f in ("F1", "F2")
    ]
    rows = {
        (r["candidate"], r["track"]): r
        for r in fairness_audit([], labels, MANIFEST, b=B_SMALL)["label_audit"]
        if r["measure"] == "evasion"
    }
    assert (rows["A1", "I"]["num"], rows["A1", "I"]["den"]) == (2, 2)
    assert (rows["B2", "I"]["num"], rows["B2", "I"]["den"]) == (0, 2)


def test_fa6_the_negative_controls_are_caught_and_the_positive_controls_cleared() -> None:
    nc = negative_controls(MANIFEST, B_SMALL)
    # FX-F01: 6 pairs, 3 hesitation-citing flags on each hesitant member -> 18 flags, every one a violation
    assert nc["negative"]["flags"] == nc["negative"]["flags_marked_demeanor"] == NC_FLAGS
    assert nc["negative"]["fa5b_p_value"] < ALPHA
    # FX-F02: the same content flags in both renderings: FA-3 zero, no style range at all (p = 1)
    assert nc["positive"]["flags_marked_demeanor"] == 0
    assert nc["positive"]["fa5b_p_value"] == 1.0
    assert nc["caught"] is True


def test_fa6_reports_a_miss_when_the_lexicon_would_not_mark_the_controls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fa, "demeanor_terms", lambda _text: [])
    assert negative_controls(MANIFEST, B_SMALL)["caught"] is False


def test_fa6_reports_a_miss_when_fa3_would_count_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    real = fa._demeanor

    def blind(c: str, track: str, trials: list[FairTrial]) -> dict[str, object]:
        return {**real(c, track, trials), "flags": 0}

    monkeypatch.setattr(fa, "_demeanor", blind)
    assert negative_controls(MANIFEST, B_SMALL)["caught"] is False


def test_fa6_reports_a_miss_when_the_lexicon_marks_content_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fa, "demeanor_terms", lambda _text: ["nervous"])
    assert negative_controls(MANIFEST, B_SMALL)["caught"] is False


def test_every_permutation_test_names_its_sample_size() -> None:
    # _flagging: 12 variants (6 families x 2 renderings), 12 subject turns each; one subject, no blocks
    tests = {t["test"]: t for t in fairness_audit(_flagging(12), [], MANIFEST, b=B_SMALL)["tests"]}
    assert (tests["FA-5b:verbosity:truthful"]["n"], tests["FA-5b:verbosity:truthful"]["units"]) == (144, 12)
    assert (tests["FA-5a:verbosity"]["n"], tests["FA-5a:verbosity"]["units"]) == (12, 12)
    assert (tests["FA-5c"]["n"], tests["FA-5c"]["units"]) == (0, 0)
    assert (tests["FA-5d"]["n"], tests["FA-5d"]["units"]) == (12, 12)


def test_a_degenerate_bootstrap_publishes_the_family_bound_instead() -> None:
    # six families, no false positive: the bootstrap is degenerate (0 to 0), so the bound replaces it (AC-S3-8.4)
    trials = [_trial(f"F{i}", "truthful", "terse", "truthful") for i in range(6)]
    [row] = fairness_audit(trials, [], MANIFEST, b=B_SMALL)["style_fpr"]
    assert row["interval"] is None
    assert (row["bound"]["families"], row["bound"]["failed"]) == (6, 0)


def test_with_fairness_puts_violations_on_the_rows_and_drops_m24_from_not_computed() -> None:
    trials = [
        replace(_trial("F1", "truthful", "terse", "deceptive"), emitted_flags=2, demeanor_flags=1),
        *_flagging(12),
    ]
    audit = fairness_audit(trials, [], MANIFEST, b=B_SMALL)
    body = {
        "not_computed": ["M24_fairness_audit"],
        "rows": [{"candidate_id": "A1", "fairness_violations": []}, {"candidate_id": "B2", "fairness_violations": []}],
    }
    out = with_fairness(body, audit)
    assert out["not_computed"] == []
    assert out["fairness"] == audit
    a1, b2 = out["rows"]
    analyses = [v["analysis"] for v in a1["fairness_violations"]]
    assert analyses[0] == "FA-3"
    assert a1["fairness_violations"][0]["flags"] == 1
    assert "FA-5b:verbosity:truthful" in analyses
    assert b2["fairness_violations"] == []


def test_the_audit_names_its_manifest_and_carries_the_power_disclosure() -> None:
    audit = fairness_audit([], [], MANIFEST, b=B_SMALL)
    assert audit["published"] is True
    assert audit["manifest_sha256"] == MANIFEST
    assert "not detected at this sample size" in audit["power_note"]
    assert audit["style_fpr"] == audit["flag_rates"] == audit["demeanor"] == audit["tests"] == []
