"""Ranking and the isolation gate (S3 5.5, 9): AC-S3-5.3, 9.1, 9.2; FX-RK1, FX-RK2, FX-I01, FX-I02, FX-Z02."""

from __future__ import annotations

from fractions import Fraction

import pytest

from arena_core.scoring.ranking import (
    IG_ITEMS,
    NOT_RANKED,
    CandidateStats,
    FamilyCounts,
    Leaderboard,
    canary_audit,
    isolation_result,
    rank,
    rank_intervals,
)

PASS = isolation_result({k: (True, k.lower() * 4) for k in IG_ITEMS})


def cand(cid: str, **fields: int | Fraction | None) -> CandidateStats:
    """A candidate with 45 included trials of each role, 40 detected, no false positive, QQ 3/4, full coverage."""
    base: dict[str, int | Fraction | None] = {
        "fp": 0,
        "inc_t": 45,
        "exc_t": 0,
        "det": 40,
        "inc_d": 45,
        "exc_d": 0,
        "qq": Fraction(3, 4),
        "cov": Fraction(1),
    }
    base.update(fields)
    v = {k: base[k] for k in base}
    return CandidateStats(
        cid,
        int(v["fp"] or 0),
        int(v["inc_t"] or 0),
        int(v["exc_t"] or 0),
        int(v["det"] or 0),
        int(v["inc_d"] or 0),
        int(v["exc_d"] or 0),
        None if v["qq"] is None else Fraction(v["qq"]),
        Fraction(v["cov"] or 0),
    )


def ranks(board: Leaderboard) -> dict[str, int | None]:
    return {r.candidate.id: r.rank for r in board.rows}


def test_fx_i01_ac_s3_9_1_any_failing_ig_item_ranks_nothing() -> None:
    for item in IG_ITEMS:
        iso = isolation_result({k: (k != item, "e") for k in IG_ITEMS})
        board = rank([cand("A1"), cand("A2")], iso, qq_calibrated=True)
        assert (board.rows, board.status) == ([], NOT_RANKED)
        assert board.evidence == iso.evidence_hash
    assert not isolation_result(dict.fromkeys(IG_ITEMS[:-1], (True, "e"))).passed  # a missing item fails too


def test_fx_i02_ac_s3_9_2_one_canary_hit_fails_the_gate_for_every_candidate() -> None:
    ig6 = canary_audit({"A1": 1, "A2": 0, "A3": 0})
    assert ig6 is False
    iso = isolation_result({**dict.fromkeys(IG_ITEMS, (True, "e")), "IG-6": (ig6, "canary-report")})
    assert rank([cand("A1"), cand("A2"), cand("A3")], iso, qq_calibrated=True).rows == []
    assert canary_audit({"A1": 0, "A2": 0}) is True


def test_the_isolation_hash_binds_every_item() -> None:
    a = isolation_result(dict.fromkeys(IG_ITEMS, (True, "e")))
    b = isolation_result({**dict.fromkeys(IG_ITEMS, (True, "e")), "IG-3": (True, "other")})
    assert (a.passed, b.passed) == (True, True)
    assert a.evidence_hash != b.evidence_hash


def test_ac_s3_5_3_never_ranks_fpr_above_5_percent_or_insufficient_eligibility() -> None:
    board = rank(
        [cand("ok"), cand("fp", fp=3, inc_t=45), cand("none", inc_t=0, exc_t=45), cand("edge", fp=2, inc_t=40)],
        PASS,
        qq_calibrated=True,
    )
    got = {r.candidate.id: (r.rank, r.reason) for r in board.rows}
    assert (got["ok"][0], got["edge"][0]) == (1, 1)  # 2/40 = 5% exactly is eligible; equal keys share rank 1
    assert got["fp"] == (None, "ineligible: FPR above 5%")  # 3/45 = 6.7%
    assert got["none"] == (None, "insufficient: no included truthful trials")  # FX-Z02


def test_a_candidate_without_included_deceptive_trials_is_listed_unranked() -> None:
    board = rank([cand("A1"), cand("A2", det=0, inc_d=0, exc_d=45)], PASS, qq_calibrated=True)
    assert ranks(board) == {"A1": 1, "A2": None}
    assert board.rows[1].reason == "unranked: no included deceptive trials"


def test_fx_rk1_equal_recall_and_qq_share_a_rank() -> None:
    board = rank([cand("A1"), cand("A2"), cand("A3", det=30)], PASS, qq_calibrated=True)
    assert ranks(board) == {"A1": 1, "A2": 1, "A3": 3}
    assert board.status == "definitive"


def test_fx_rk2_qq_breaks_a_recall_tie_and_uncalibrated_qq_makes_it_provisional() -> None:
    cands = [cand("A1", qq=Fraction(10, 16)), cand("A2", qq=Fraction(14, 16))]
    board = rank(cands, PASS, qq_calibrated=False)
    assert ranks(board) == {"A2": 1, "A1": 2}
    assert board.status == "provisional"
    assert rank(cands, PASS, qq_calibrated=True).status == "definitive"
    low = [cand("A1", qq=Fraction(10, 16)), cand("A2", qq=Fraction(14, 16), cov=Fraction(8, 10))]
    assert rank(low, PASS, qq_calibrated=True).status == "provisional"  # QQ coverage below 90%


def test_recall_is_compared_exactly_before_qq() -> None:
    a = cand("A1", det=2, inc_d=3, qq=Fraction(0))
    b = cand("A2", det=20, inc_d=30, qq=Fraction(1))  # the same recall 2/3, exactly
    c = cand("A3", det=21, inc_d=30, qq=None)
    board = rank([a, b, c], PASS, qq_calibrated=True)
    assert ranks(board) == {"A3": 1, "A2": 2, "A1": 3}


def test_attrition_makes_the_board_provisional() -> None:
    board = rank([cand("A1", fp=2, inc_t=45, exc_t=5), cand("A2")], PASS, qq_calibrated=True)
    assert board.status == "provisional"  # 7/50 worst case crosses 5%
    deceptive = rank([cand("A1", det=30, inc_d=30, exc_d=90), cand("A2", det=110, inc_d=120)], PASS, True)
    assert deceptive.status == "provisional"  # FX-A03 on the board
    assert deceptive.sensitivity is not None
    assert deceptive.sensitivity.low_coverage == ("A1",)


# ---------------------------------------------------------------- rank intervals (5.5)


def test_rank_intervals_are_reproducible_and_count_resamples_without_deceptive_trials() -> None:
    per_family = {
        "A1": {f"F{i}": FamilyCounts(3, 3, Fraction(3, 2), 2) for i in range(10)},
        "A2": {f"F{i}": FamilyCounts(1, 3, Fraction(1, 2), 2) for i in range(10)},
        "A3": {"F0": FamilyCounts(1, 1, Fraction(0), 0)},
    }
    got = rank_intervals(per_family, seed=11, b=2000)
    assert got == rank_intervals(per_family, seed=11, b=2000)
    assert (got["A1"].lo, got["A1"].hi, got["A1"].share_first) == (1, 1, Fraction(1))
    assert (got["A2"].lo, got["A2"].hi) == (2, 3)
    assert got["A3"].no_deceptive_resamples > 0
    assert got["A1"].no_deceptive_resamples == 0
    assert rank_intervals({}, seed=1) == {}


@pytest.mark.parametrize("b", [400, 1000])
def test_rank_interval_tied_candidates_share_first(b: int) -> None:
    per_family = {c: {f"F{i}": FamilyCounts(2, 3, Fraction(1), 1) for i in range(6)} for c in ("A1", "A2")}
    got = rank_intervals(per_family, seed=3, b=b)
    assert got["A1"].share_first == got["A2"].share_first == 1


def test_attrition_sensitivity_follows_the_published_order_not_the_input_order() -> None:
    """A 45/45 with QQ 1/2; B 44/44 with one excluded deceptive trial and QQ 1. B ranks first on QQ; imputing
    B's excluded trial as a miss puts A first, so the board is provisional whatever order the rows arrive in."""
    a = cand("A", det=45, inc_d=45, qq=Fraction(1, 2))
    b = cand("B", det=44, inc_d=44, exc_d=1, qq=Fraction(1))
    boards = [rank(c, PASS, qq_calibrated=True) for c in ([a, b], [b, a])]
    assert [ranks(x) for x in boards] == [{"B": 1, "A": 2}, {"B": 1, "A": 2}]
    assert [x.status for x in boards] == ["provisional", "provisional"]
    sens = [x.sensitivity for x in boards]
    assert sens[0] == sens[1]
    assert sens[0] is not None
    assert (sens[0].order, sens[0].provisional, sens[0].low_coverage) == (("B", "A"), True, ())


def test_a_reversal_through_qq_at_equal_imputed_recall_is_provisional() -> None:
    a = cand("A", det=40, inc_d=45, qq=Fraction(1, 2))
    b = cand("B", det=39, inc_d=44, exc_d=1, qq=Fraction(1))  # best case 40/45 ties A's recall; QQ puts B first
    board = rank([a, b], PASS, qq_calibrated=True)
    assert (ranks(board), board.status) == ({"A": 1, "B": 2}, "provisional")


def test_a_shared_rank_that_attrition_could_split_is_provisional() -> None:
    board = rank([cand("A1"), cand("A2", det=40, inc_d=45, exc_d=1)], PASS, qq_calibrated=True)
    assert (ranks(board), board.status) == ({"A1": 1, "A2": 1}, "provisional")
    assert board.sensitivity is not None
    assert (board.sensitivity.order, board.sensitivity.provisional) == (("A1", "A2"), True)
