"""C-37 one variant per family and the KPI-1 test sets (X-08, SG4-10) as `GET /api/cases` assigns them."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

from arena_api.routes.cases import assigned, draw
from arena_api.routes.me import _study

A, B = UUID(int=1), UUID(int=2)


def _case(family: str, *, kpi1: bool = False) -> dict[str, Any]:
    return {"variant_id": uuid4(), "family_code": family, "public_packet": {}, "kpi1_set": kpi1}


def _study_row(ended: tuple[int, int, int], pre: list[UUID], post: list[UUID], tested: list[UUID]) -> dict[str, Any]:
    pre_ended, practice, post_ended = ended
    return {
        "code": "P1",
        "counterbalance": "AB",
        "pre_ended": pre_ended,
        "practice_ended": practice,
        "post_ended": post_ended,
        "pre": pre,
        "post": post,
        "tested": tested,
    }


def test_one_variant_per_practice_family_and_never_a_case_set_family() -> None:
    cases = [_case("F01"), _case("F01"), _case("F02"), _case("F06", kpi1=True)]
    picked = draw(cases, A, "seed")
    assert sorted(c["family_code"] for c in picked) == ["F01", "F02"]
    assert draw(cases, A, "seed") == picked


def test_two_users_can_draw_different_variants_of_one_family() -> None:
    cases = [_case("F01"), _case("F01")]
    drawn = {draw(cases, UUID(int=n), "seed")[0]["variant_id"] for n in range(16)}
    assert len(drawn) == len(cases)


def test_a_participant_sees_the_untested_pre_test_variants_first() -> None:
    pre1, pre2 = _case("F06", kpi1=True), _case("F08", kpi1=True)
    cases = [_case("F01"), pre1, pre2]
    study = _study_row((1, 0, 0), [pre1["variant_id"], pre2["variant_id"]], [], [pre1["variant_id"]])
    assert assigned(cases, study, A, "seed") == [pre2]


def test_after_the_pre_tests_practice_then_the_post_tests() -> None:
    post = _case("F07", kpi1=True)
    cases = [_case("F01"), post]
    practicing = _study_row((2, 1, 0), [UUID(int=9), UUID(int=8)], [post["variant_id"]], [])
    assert [c["family_code"] for c in assigned(cases, practicing, A, "seed")] == ["F01"]
    posting = _study_row((2, 3, 0), [UUID(int=9), UUID(int=8)], [post["variant_id"]], [])
    assert assigned(cases, posting, A, "seed") == [post]


def test_study_status_names_the_next_phase() -> None:
    assert _study(None) is None
    two = [A, B]
    phases = []
    for row in (
        _study_row((0, 0, 0), two, two, []),
        _study_row((2, 1, 0), two, two, two),
        _study_row((2, 3, 1), two, two, two),
        _study_row((2, 3, 2), two, two, two),
    ):
        status = _study(row)
        assert status is not None
        phases.append(status["next_phase"])
    assert phases == ["pre", "practice", "post", "done"]
