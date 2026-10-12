"""`blocks.group_interactive_by_block` (S5 5.3; direction 7.2): groups the roster's interactive rows by
block number, in position order, dropping every corpus and replay row."""

from __future__ import annotations

from uuid import uuid4

from arena_tournament.blocks import group_interactive_by_block
from arena_tournament.roster import FamilySpec, build_roster

A1, A2, A3 = uuid4(), uuid4(), uuid4()
S1, S2, S3 = uuid4(), uuid4(), uuid4()
BLOCK_TRIALS = 18  # direction 7.2: nine pairings x two variants


def family(code: str) -> FamilySpec:
    return FamilySpec(family_code=code, truthful_variant_id=uuid4(), deceptive_variant_id=uuid4())


def test_groups_come_out_in_block_order_with_only_interactive_rows() -> None:
    rows = build_roster([family("F01"), family("F02")], (A1, A2, A3), (S1, S2, S3), seed=1)
    planned = [row.as_json() for row in rows]
    groups = group_interactive_by_block(planned)
    assert [block_no for block_no, _ in groups] == [1, 2]
    for _, group_rows in groups:
        assert len(group_rows) == BLOCK_TRIALS
        assert all(row["track"] == "interactive" for row in group_rows)


def test_a_groups_rows_are_in_position_order() -> None:
    rows = build_roster([family("F01")], (A1, A2, A3), (S1, S2, S3), seed=9)
    planned = [row.as_json() for row in rows]
    [(_, group_rows)] = group_interactive_by_block(planned)
    positions = [row["position"] for row in group_rows]
    assert positions == sorted(positions)


def test_no_interactive_rows_yields_no_groups() -> None:
    rows = build_roster([family("F01")], (A1, A2, A3), (S1, S2, S3), seed=1)
    corpus_and_replay = [row.as_json() for row in rows if row.track != "interactive"]
    assert group_interactive_by_block(corpus_and_replay) == []
