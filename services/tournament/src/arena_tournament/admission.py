"""Unit admission against the spend guard (S5 4.5, S4 8.5): a block, a corpus transcript or a replay trial
is admitted only if `ops.admit_unit` finds 1.5 x its high cost free; it holds nothing (each call inside the
unit still reserves its own worst case).

`arena_core.spend.rates.unit_high_cost` is the one place the cost-model arithmetic lives, parity-tested
against `docs/research/synthesis/cost_model.py` by `tools/check_cost_parity.py` for an arbitrary call list; this
module only builds that call list for one roster unit, from the unit's own candidate manifests. The token
counts are each call kind's ceiling limit (`ops.call_limits`, the same figures `ops.reserve_model_call`
reserves per attempt), not the cost model's research-time "typical" lineup tokens, so a unit's estimated high
cost is never below what its calls could actually reserve -- a deliberately conservative stand-in, not a
restatement of the research lineup's own numbers (D-022: simple over exact).

A1's deep update is counted once per `every_n_exchanges` exchanges, ignoring the extra releases may trigger
(S2 4.4.1): admission's 1.5x headroom exists for exactly this kind of slack, and an undercount here never
weakens the per-call reservation that actually guards spend.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from arena_core.agents.manifests import CandidateManifest
from arena_core.spend.limits import LIMITS, CallType, VertexModel
from arena_core.spend.rates import ModeledCall, unit_high_cost

EXCHANGES = 12  # S2 8.5 ST-1; replay_script.v1 and the interactive cap share this bound
# The referee's own call (S4 8.2, four purposes sharing the `referee` call kind): the referee is not a
# roster slot (only assistant and subject candidates are, C-47), so admission models it at the D009 lineup's
# first referee call's model and thinking level rather than a per-tournament manifest.
REFEREE_MODEL = VertexModel.FLASH_LITE_35
REFEREE_THINKING = "LOW"


def _call(call_type: CallType, model_id: str, thinking_level: str) -> ModeledCall:
    limit = LIMITS[call_type]
    return ModeledCall(VertexModel(model_id), limit.input_bytes, limit.output_tokens, thinking_level)


def _referee_call() -> ModeledCall:
    return _call(CallType.REFEREE, REFEREE_MODEL.value, REFEREE_THINKING)


def _subject_calls(manifest: CandidateManifest) -> list[ModeledCall]:
    subject = manifest.limits["subject"]
    return [_call(CallType.SUBJECT, subject.model_id, subject.thinking_level) for _ in range(EXCHANGES)]


def _assistant_calls(manifest: CandidateManifest) -> list[ModeledCall]:
    """Every call one assistant's interactive or replay trial makes (S2 4): a card every exchange, the deep
    update if the manifest has one (by cadence alone), the final call once."""
    card = manifest.limits["card"]
    calls = [_call(CallType.CARD, card.model_id, card.thinking_level) for _ in range(EXCHANGES)]
    policy = manifest.coaching_policy
    deep = manifest.limits.get("deep")
    if policy is not None and policy.deep_update is not None and deep is not None:
        count = -(-EXCHANGES // policy.deep_update.every_n_exchanges)
        calls += [_call(CallType.DEEP, deep.model_id, deep.thinking_level) for _ in range(count)]
    final = manifest.limits["final"]
    calls.append(_call(CallType.FINAL, final.model_id, final.thinking_level))
    return calls


def interactive_trial_calls(assistant: CandidateManifest, subject: CandidateManifest) -> list[ModeledCall]:
    """One interactive trial's calls (S5 5.3): the subject and the assistant, then R1 and R2 (the
    block-boundary score call scores each of the block's trials in turn, C-42)."""
    return [*_subject_calls(subject), *_assistant_calls(assistant), _referee_call(), _referee_call()]


def block_calls(pairings: Sequence[tuple[CandidateManifest, CandidateManifest]]) -> list[ModeledCall]:
    """One block's calls (S3 "one family, both variants, nine pairings, one repeat: 18 trials"): every
    (assistant, subject) pairing's trial, once per variant."""
    calls: list[ModeledCall] = []
    for assistant, subject in pairings:
        calls += interactive_trial_calls(assistant, subject) * 2
    return calls


def corpus_trial_calls(subject: CandidateManifest) -> list[ModeledCall]:
    """One corpus transcript's calls (S2 8.6; BKO-6): the harness's script against one subject, then R1."""
    return [*_subject_calls(subject), _referee_call()]


def replay_trial_calls(assistant: CandidateManifest) -> list[ModeledCall]:
    """One replay trial's calls (S5 5.3; D2): one assistant re-scoring a sealed transcript, then R2 (R1 is
    not re-run; it is read back from the source corpus transcript)."""
    return [*_assistant_calls(assistant), _referee_call()]


@dataclass(frozen=True)
class AdmitResult:
    admitted: bool
    high_cost_usd: Decimal
    detail: Mapping[str, object]


def unit_cost(calls: Sequence[ModeledCall]) -> Decimal:
    return unit_high_cost(list(calls))
