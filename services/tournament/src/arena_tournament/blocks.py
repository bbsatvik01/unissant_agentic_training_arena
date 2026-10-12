"""Block scheduling (S5 5.3; direction 7.2).

Interactive planned trials are grouped by the roster's own `block_no` (`roster.build_roster`), each in
position order (the recorded seed). The runner processes one block's trials in that order, then makes the
one block-boundary scoring call (`arena_tournament.referee_client`) before moving to the next block.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from itertools import groupby
from typing import Any


def group_interactive_by_block(
    planned_trials: Sequence[Mapping[str, Any]],
) -> list[tuple[int, list[Mapping[str, Any]]]]:
    """Interactive rows of `arena.v_planned_trials` (`ArenaDb.planned_trials`), position order, grouped by
    block number; every interactive row has one (S4 `arena.add_planned_trials`: "one family per block"), and
    blocks come out in position order too (the roster builds every interactive row of a block contiguously)."""
    interactive = sorted(
        (row for row in planned_trials if row["track"] == "interactive"), key=lambda row: int(row["position"])
    )
    return [(int(block_no), list(rows)) for block_no, rows in groupby(interactive, key=lambda row: row["block_no"])]
