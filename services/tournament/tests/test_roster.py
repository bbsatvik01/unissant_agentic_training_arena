"""`roster.build_roster` (S5 5.3; direction 7.2): BKO-2 order, block shape, the seeded shuffle and the
lineup/negative-control guards."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from arena_tournament.roster import (
    FamilySpec,
    PlannedRow,
    RosterError,
    build_roster,
    check_lineup,
    check_no_negative_controls,
)

A1, A2, A3 = uuid4(), uuid4(), uuid4()
S1, S2, S3 = uuid4(), uuid4(), uuid4()
ASSISTANTS = (A1, A2, A3)
SUBJECTS = (S1, S2, S3)
VARIANTS_PER_FAMILY = 2
BLOCK_TRIALS = VARIANTS_PER_FAMILY * len(ASSISTANTS) * len(SUBJECTS)  # direction 7.2: nine pairings x two variants
TRIALS_PER_CANDIDATE_IN_A_BLOCK = BLOCK_TRIALS // len(ASSISTANTS)  # every candidate appears equally often


def family(code: str) -> FamilySpec:
    return FamilySpec(family_code=code, truthful_variant_id=uuid4(), deceptive_variant_id=uuid4())


def test_one_family_produces_two_corpus_two_replay_groups_and_one_eighteen_trial_block() -> None:
    rows = build_roster([family("F01")], ASSISTANTS, SUBJECTS, seed=1)
    by_track = {t: [r for r in rows if r.track == t] for t in ("replay_corpus", "replay", "interactive")}
    assert len(by_track["replay_corpus"]) == VARIANTS_PER_FAMILY
    assert len(by_track["replay"]) == VARIANTS_PER_FAMILY * len(ASSISTANTS)  # every assistant scores each corpus
    assert len(by_track["interactive"]) == BLOCK_TRIALS  # 18: direction 7.2


def test_corpus_runs_before_replay_before_interactive_in_position_order() -> None:
    """BKO-2: the job's execution order is the roster's own position order."""
    rows = build_roster([family("F01"), family("F02")], ASSISTANTS, SUBJECTS, seed=1)
    tracks_in_position_order = [r.track for r in sorted(rows, key=lambda r: r.position)]
    first_replay = tracks_in_position_order.index("replay")
    first_interactive = tracks_in_position_order.index("interactive")
    assert set(tracks_in_position_order[:first_replay]) == {"replay_corpus"}
    assert set(tracks_in_position_order[first_replay:first_interactive]) == {"replay"}
    assert set(tracks_in_position_order[first_interactive:]) == {"interactive"}


def test_positions_are_unique_and_contiguous_from_one() -> None:
    rows = build_roster([family("F01"), family("F02")], ASSISTANTS, SUBJECTS, seed=7)
    positions = sorted(r.position for r in rows)
    assert positions == list(range(1, len(rows) + 1))


def test_replay_rows_reference_their_own_variants_corpus_row() -> None:
    rows = build_roster([family("F01")], ASSISTANTS, SUBJECTS, seed=1)
    corpus_by_variant = {r.variant_id: r.position for r in rows if r.track == "replay_corpus"}
    for row in rows:
        if row.track == "replay":
            assert row.source_position == corpus_by_variant[row.variant_id]


def test_corpus_subjects_rotate_by_case_index() -> None:
    """cost_model.py corpus_calls: "subjects rotate by case index"; two families give 4 corpus rows, so with
    3 subjects the 4th wraps back to the 1st."""
    rows = build_roster([family("F01"), family("F02")], ASSISTANTS, SUBJECTS, seed=1)
    corpus = sorted((r for r in rows if r.track == "replay_corpus"), key=lambda r: r.position)
    assert [r.subject_candidate_id for r in corpus] == [S1, S2, S3, S1]


def test_block_numbers_are_one_based_and_sequential_per_family() -> None:
    rows = build_roster([family("F01"), family("F02"), family("F03")], ASSISTANTS, SUBJECTS, seed=1)
    interactive = [r for r in rows if r.track == "interactive"]
    assert {r.block_no for r in interactive} == {1, 2, 3}
    assert {r.block_no for r in rows if r.track != "interactive"} == {None}


def test_a_blocks_interactive_rows_are_a_full_balanced_cartesian_product() -> None:
    """Every assistant and every subject appears equally often in a block (direction 7.2's "nine pairings"),
    by construction, not by a separate balance check."""
    rows = build_roster([family("F01")], ASSISTANTS, SUBJECTS, seed=3)
    interactive = [r for r in rows if r.track == "interactive"]
    pairs = {(r.variant_id, r.assistant_candidate_id, r.subject_candidate_id) for r in interactive}
    assert len(pairs) == len(interactive) == BLOCK_TRIALS
    for assistant in ASSISTANTS:
        count = sum(1 for r in interactive if r.assistant_candidate_id == assistant)
        assert count == TRIALS_PER_CANDIDATE_IN_A_BLOCK
    for subject in SUBJECTS:
        count = sum(1 for r in interactive if r.subject_candidate_id == subject)
        assert count == TRIALS_PER_CANDIDATE_IN_A_BLOCK


def test_the_seed_makes_the_blocks_order_reproducible_and_different_seeds_usually_differ() -> None:
    families = [family("F01"), family("F02")]
    rows_a = build_roster(families, ASSISTANTS, SUBJECTS, seed=42)
    rows_b = build_roster(families, ASSISTANTS, SUBJECTS, seed=42)
    rows_c = build_roster(families, ASSISTANTS, SUBJECTS, seed=43)
    assert _pairing_order(rows_a) == _pairing_order(rows_b)
    assert _pairing_order(rows_a) != _pairing_order(rows_c)


def _pairing_order(rows: list[PlannedRow]) -> list[tuple[UUID | None, UUID | None]]:
    return [(r.assistant_candidate_id, r.subject_candidate_id) for r in rows if r.track == "interactive"]


def test_no_families_is_refused() -> None:
    with pytest.raises(RosterError, match="case family"):
        build_roster([], ASSISTANTS, SUBJECTS, seed=1)


def test_an_empty_or_duplicated_lineup_is_refused() -> None:
    with pytest.raises(RosterError, match="at least one"):
        check_lineup((), SUBJECTS)
    with pytest.raises(RosterError, match="repeat"):
        check_lineup((A1, A1), SUBJECTS)


def test_negative_controls_are_refused_before_any_row_is_built() -> None:
    kinds = {A1: "assistant", S1: "subject", uuid4(): "negative_control"}
    bad = next(c for c in kinds if kinds[c] == "negative_control")
    with pytest.raises(RosterError, match="only assistant and subject"):
        check_no_negative_controls(kinds, [A1, S1, bad])


def test_planned_row_as_json_matches_add_planned_trials_shape() -> None:
    rows = build_roster([family("F01")], ASSISTANTS, SUBJECTS, seed=1)
    corpus_row = next(r for r in rows if r.track == "replay_corpus")
    payload = corpus_row.as_json()
    assert payload["assistant_candidate_id"] is None
    assert payload["subject_candidate_id"] == str(corpus_row.subject_candidate_id)
    assert isinstance(payload["variant_id"], str)
    assert UUID(payload["variant_id"]) == corpus_row.variant_id
    assert payload["repeat"] == 1
