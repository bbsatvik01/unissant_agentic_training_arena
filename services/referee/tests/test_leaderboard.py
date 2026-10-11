"""`arena_referee.leaderboard.candidate_inputs` (S3 4.3, 5.3): groups raw trial facts by assistant candidate
and classifies each with WP-15's own `inclusion()`/`block_invalid()` -- parity with the sealed manifest by
construction."""

from __future__ import annotations

import dataclasses
from decimal import Decimal

from arena_core.scoring.inclusion import Exec
from arena_referee.db import TrialFacts
from arena_referee.leaderboard import candidate_inputs

TWO = 2
FULL_BLOCK = 18

BASE = TrialFacts(
    planned_trial_id="p1",
    track="interactive",
    assistant_id="A1",
    family_id="F01",
    role="truthful",
    block_id="B1",
    exec_state=Exec.COMPLETED,
    verdict="valid",
    classification="truthful",
    settled_cost=Decimal("0.01"),
)


def test_a_replay_corpus_row_has_no_assistant_and_is_excluded_from_every_candidate() -> None:
    facts = [dataclasses.replace(BASE, assistant_id=None, track="replay_corpus")]
    assert candidate_inputs(facts) == []


def test_completed_valid_trials_are_included_with_their_committed_label() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", role="truthful", classification="truthful"),
        dataclasses.replace(BASE, planned_trial_id="p2", role="deceptive", classification="deceptive"),
    ]
    [candidate] = candidate_inputs(facts)
    assert candidate.candidate_id == "A1"
    assert len(candidate.trials) == TWO
    assert candidate.own_planned == TWO
    assert candidate.excluded_truthful_by_family == {}


def test_subject_invalid_excludes_the_assistant_and_counts_against_the_truthful_family() -> None:
    facts = [dataclasses.replace(BASE, role="truthful", verdict="subject_invalid")]
    [candidate] = candidate_inputs(facts)
    assert candidate.trials == []
    assert candidate.excluded_truthful_by_family == {"F01": 1}
    assert candidate.reasons == ["subject_invalid"]


def test_assistant_failed_with_a_valid_verdict_is_included_as_insufficient() -> None:
    facts = [dataclasses.replace(BASE, exec_state=Exec.ASSISTANT_FAILED, classification=None)]
    [candidate] = candidate_inputs(facts)
    [trial] = candidate.trials
    assert trial.committed_label is None  # output_of() reads the synthetic insufficient_evidence from asst_inc


def test_one_infra_failure_invalidates_the_whole_block_for_every_row_in_it() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", exec_state=Exec.INFRA_FAILED),
        *[dataclasses.replace(BASE, planned_trial_id=f"p{i}") for i in range(2, FULL_BLOCK + 1)],
    ]
    candidate = candidate_inputs(facts)[0]
    assert candidate.trials == []  # every row in the invalidated block is excluded
    assert set(candidate.reasons) == {"block_invalid_infra"}


def test_cost_rows_carry_every_own_call_whether_or_not_the_trial_is_included() -> None:
    # block_id=None: an isolated pair, so the 5%-infra-failure block rule never ropes the completed trial in too.
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", block_id=None, settled_cost=Decimal("0.05")),
        dataclasses.replace(
            BASE, planned_trial_id="p2", block_id=None, exec_state=Exec.INFRA_FAILED, settled_cost=Decimal("0.02")
        ),
    ]
    candidate = candidate_inputs(facts)[0]
    assert sorted(candidate.own_cost_rows) == sorted([(Decimal("0.05"), True), (Decimal("0.02"), False)])


def test_rows_group_by_their_own_assistant_candidate() -> None:
    facts = [
        dataclasses.replace(BASE, planned_trial_id="p1", assistant_id="A1"),
        dataclasses.replace(BASE, planned_trial_id="p2", assistant_id="A2"),
    ]
    by_id = {c.candidate_id: c for c in candidate_inputs(facts)}
    assert set(by_id) == {"A1", "A2"}
