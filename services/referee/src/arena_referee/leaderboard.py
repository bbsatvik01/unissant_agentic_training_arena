"""Raw `arena_referee.db.TrialFacts` rows to `arena_core.referee.leaderboard.CandidateInput` (S3 4.3, 5.3-
5.6; WP-16). Pure: classifies each row with WP-15's own `inclusion()` and `block_invalid()` -- the same
functions, on the same raw facts, that `ledger.build_manifest` reads -- so a candidate's leaderboard input
agrees with the sealed manifest by construction, never by a second, possibly drifting, derivation.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from arena_core.referee.leaderboard import CandidateInput
from arena_core.scoring.inclusion import AsstInc, Exec, block_invalid, inclusion
from arena_core.scoring.metrics import TrialOutcome
from arena_referee.db import TrialFacts


def _block_invalid_map(facts: Sequence[TrialFacts]) -> dict[str, bool]:
    by_block: dict[str, list[Exec]] = {}
    for f in facts:
        if f.block_id is not None:
            by_block.setdefault(f.block_id, []).append(f.exec_state)
    return {block: block_invalid(states) for block, states in by_block.items()}


def candidate_inputs(facts: Sequence[TrialFacts]) -> list[CandidateInput]:
    """Groups by `assistant_id` (a `replay_corpus` row has none and is never an assistant's own trial).

    Known gap (not fixed this round): groups an assistant's `interactive` and `replay` track rows into one
    `CandidateInput` -- S3 5.2's metric table defines the I and R columns separately, and the bootstrap seed
    this candidate's rows feed hardcodes the `"I"` track literal regardless. Only a problem once a tournament
    actually runs a `replay` track for an assistant (today's dev fixtures are interactive-only); the fix is
    to key `by_candidate` on `(assistant_id, track)` and publish one row, and one bootstrap seed, per track.
    """
    invalid_blocks = _block_invalid_map(facts)
    by_candidate: dict[str, list[TrialFacts]] = {}
    for f in facts:
        if f.assistant_id is not None:
            by_candidate.setdefault(f.assistant_id, []).append(f)
    out: list[CandidateInput] = []
    for candidate_id, rows in by_candidate.items():
        trials: list[TrialOutcome] = []
        excluded_truthful_by_family: dict[str, int] = {}
        excluded_deceptive_by_family: dict[str, int] = {}
        reasons: list[tuple[str, str]] = []
        cost_rows: list[tuple[Decimal, bool]] = []
        for f in rows:
            block_bad = f.block_id is not None and invalid_blocks.get(f.block_id, False)
            asst, _subj, reason = inclusion(f.exec_state, f.verdict, block_bad)
            reasons.append((f.role, reason))
            cost_rows.append((f.settled_cost, asst in (AsstInc.INCLUDED, AsstInc.INCLUDED_AS_INSUFFICIENT)))
            if asst is AsstInc.INCLUDED:
                label = f.classification if f.classification in ("truthful", "deceptive") else "insufficient_evidence"
                trials.append(TrialOutcome(f.family_id, f.role, asst, label))
            elif asst is AsstInc.INCLUDED_AS_INSUFFICIENT:
                trials.append(TrialOutcome(f.family_id, f.role, asst, None))
            elif f.role == "truthful":
                excluded_truthful_by_family[f.family_id] = excluded_truthful_by_family.get(f.family_id, 0) + 1
            else:
                # A deceptive-role trial this candidate's manifest row excludes (F14 attrition, M21's
                # "complete family" test): dropped entirely would silently zero out `exc_d` and disable the
                # sensitivity bound it feeds, and would let a family with an excluded deceptive trial still
                # read as "complete" for M21's zero-event bound.
                excluded_deceptive_by_family[f.family_id] = excluded_deceptive_by_family.get(f.family_id, 0) + 1
        out.append(
            CandidateInput(
                candidate_id=candidate_id,
                display_name=candidate_id,
                trials=trials,
                excluded_truthful_by_family=excluded_truthful_by_family,
                excluded_deceptive_by_family=excluded_deceptive_by_family,
                reasons=reasons,
                own_cost_rows=cost_rows,
                own_planned=len(rows),
            )
        )
    return out
