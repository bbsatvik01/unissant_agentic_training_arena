"""Unit admission's call-list builders (S5 4.5, S4 8.5): every call kind the unit actually makes, at its
ceiling limits, so the estimate is conservative by construction (`rates.unit_high_cost` itself is parity
tested elsewhere, `tools/tests/test_check_cost_parity.py`)."""

from __future__ import annotations

from decimal import Decimal

from arena_core.agents.manifests import CandidateManifest, committed_manifest
from arena_core.spend.limits import LIMITS, CallType
from arena_tournament import admission

REFEREE_OUTPUT_TOKENS = LIMITS[CallType.REFEREE].output_tokens

A1 = committed_manifest("A1")  # two_stage: true (has a deep-update policy)
A2 = committed_manifest("A2")  # two_stage: false (no deep-update policy)
S1 = committed_manifest("S1")


def test_subject_calls_are_one_per_exchange() -> None:
    calls = admission.corpus_trial_calls(S1)
    subject_calls = [c for c in calls if c.model == S1.limits["subject"].model_id]
    assert len(subject_calls) == admission.EXCHANGES


def test_an_assistant_with_a_deep_policy_gets_more_calls_than_one_without() -> None:
    with_deep = admission.interactive_trial_calls(A1, S1)
    without_deep = admission.interactive_trial_calls(A2, S1)
    assert len(with_deep) > len(without_deep)


def _expected_deep_count(manifest: CandidateManifest) -> int:
    policy = manifest.coaching_policy
    if policy is None or policy.deep_update is None:
        return 0
    every = policy.deep_update.every_n_exchanges
    return -(-admission.EXCHANGES // every)


def test_a_replay_trials_calls_are_exactly_exchanges_plus_deep_plus_final_plus_one_referee() -> None:
    for assistant in (A1, A2):
        calls = admission.replay_trial_calls(assistant)
        want = admission.EXCHANGES + _expected_deep_count(assistant) + 1 + 1  # card*N + deep + final + referee
        assert len(calls) == want


def test_interactive_trial_calls_include_two_referee_calls() -> None:
    """R1 and R2 both score an interactive trial (C-42)."""
    r1_and_r2 = 2
    calls = admission.interactive_trial_calls(A1, S1)
    referee_calls = [c for c in calls if c.tokens_out == REFEREE_OUTPUT_TOKENS]
    assert len(referee_calls) == r1_and_r2


def test_corpus_trial_calls_include_exactly_one_referee_call() -> None:
    """Only R1 runs on a corpus transcript (no assistant, S2 8.6)."""
    calls = admission.corpus_trial_calls(S1)
    referee_calls = [c for c in calls if c.tokens_out == REFEREE_OUTPUT_TOKENS]
    assert len(referee_calls) == 1


def test_replay_trial_calls_include_exactly_one_referee_call() -> None:
    """Only R2 runs on a replay trial (R1 is read back from the source, S5 5.3)."""
    calls = admission.replay_trial_calls(A1)
    referee_calls = [c for c in calls if c.tokens_out == REFEREE_OUTPUT_TOKENS]
    assert len(referee_calls) == 1


def test_block_calls_is_twice_the_sum_of_its_pairings() -> None:
    """One block is both variants x every (assistant, subject) pairing (direction 7.2)."""
    pairings = [(A1, S1), (A2, S1)]
    one_variant = sum(len(admission.interactive_trial_calls(a, s)) for a, s in pairings)
    assert len(admission.block_calls(pairings)) == 2 * one_variant


def test_unit_cost_is_positive_and_grows_with_more_calls() -> None:
    small = admission.unit_cost(admission.corpus_trial_calls(S1))
    big = admission.unit_cost(admission.interactive_trial_calls(A1, S1))
    assert small > Decimal(0)
    assert big > small
