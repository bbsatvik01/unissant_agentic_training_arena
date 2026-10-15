"""GEPA over the coach's strategy text (D-036; gepa-ai/gepa 0.1.4, MIT): the optimizer role.

Glue only: `GymAdapter` is GEPA's adapter (evaluate a candidate strategy on a batch through `CardEvaluator`, then
turn the grader's feedback into GEPA's reflective records), `ReflectionLM` is GEPA's reflection model (Gemini on
Vertex through the agent port and the spend guard, never LiteLLM), and `BudgetStop` ends the search before the
optimizer's share of the budget runs out. GEPA runs in a worker thread; every model call it triggers is sent back
to the one event loop that owns the port (`bridge`).

The optimizer only ever receives the train pool (with its canaries) and GEPA's validation set: the dev holdout is
not passed to it, and the adapter refuses a holdout example outright, so no holdout reference can reach the
reflection prompt.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Coroutine, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Annotated, Any, Protocol
from uuid import uuid4

from gepa.api import optimize as gepa_optimize
from gepa.core.adapter import EvaluationBatch, ProposalFn
from gepa.core.result import GEPAResult
from gepa.core.state import GEPAState
from pydantic import BaseModel, ConfigDict, StringConstraints

from arena_core.agents.manifests import PromptSet
from arena_core.coachgym.candidate import PLAYBOOK, STRATEGY, Candidate, build, components
from arena_core.coachgym.examples import Example
from arena_core.coachgym.metric import Grade
from arena_core.contracts.coaching import StoredCard
from arena_core.contracts.rendered import clean
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, CallContext, CallType, Message, ThinkingLevel, VertexModel
from scripts.coach_gym.evaluate import BudgetExhaustedError, CardEvaluator, Meter, run_metered, worst_case

log = logging.getLogger(__name__)

PURPOSE_OPTIMIZE = "coach_gym.optimize"
MAX_STRATEGY_CHARS = 4_000
REFLECT_MODEL = VertexModel.FLASH_LITE_35
REFLECT_SYSTEM = (
    "You revise the STRATEGY block of a coaching assistant's system prompt. The assistant watches an investigator"
    " interview a subject and, after each answer, writes a JSON card: flags on the subject's answers (each citing"
    " an exact quote), a running finding (truthful, deceptive or insufficient_evidence) and one neutral follow-up"
    " question. A separate, fixed contract defines the card's fields and citation rules; your block only shapes"
    " how the assistant reasons and coaches. Keep what works, fix what the feedback shows, and write general"
    " guidance: never copy case-specific names, ids, quotes or reference notes into the block. Never tell the"
    " assistant to judge demeanor, tone or nervousness. Return the complete new block in `instruction`,"
    f" at most {MAX_STRATEGY_CHARS} characters."
)


class Bridge(Protocol):
    """Runs a coroutine on the event loop that owns the port and waits for its result (from GEPA's thread)."""

    def __call__[T](self, coro: Coroutine[Any, Any, T]) -> T: ...


class HoldoutLeakError(RuntimeError):
    """A holdout example reached the optimizer (never expected; raised so the run stops)."""


class GymInstruction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instruction: Annotated[str, StringConstraints(min_length=40, max_length=MAX_STRATEGY_CHARS)]


class ReflectionFailedError(RuntimeError):
    """The reflection call produced no valid instruction; GEPA logs it and moves to its next iteration."""


@dataclass
class ReflectionLM:
    port: AgentPort
    meter: Meter
    run_id: str
    bridge: Bridge
    prompts: list[str] = field(default_factory=list)  # every reflection prompt sent (test evidence)

    def call(self, text: str) -> AgentCall[GymInstruction]:
        return AgentCall(
            model=REFLECT_MODEL,
            thinking=ThinkingLevel.MINIMAL,
            system=REFLECT_SYSTEM,
            messages=(Message("user", text),),
            schema=GymInstruction,
            context=CallContext(
                call_type=CallType.FINAL,
                purpose=PURPOSE_OPTIMIZE,
                step_key=f"coach_gym:{self.run_id}:reflect:{uuid4().hex}",
                split="dev",
            ),
        )

    def __call__(self, prompt: str | list[dict[str, Any]]) -> str:
        text = prompt if isinstance(prompt, str) else "\n".join(str(p.get("content", "")) for p in prompt)
        self.prompts.append(text)
        value, run = self.bridge(run_metered(self.port, self.meter, self.call(text)))
        if value is None:
            raise ReflectionFailedError(run.error or "no instruction")
        # GEPA's instruction extractor reads the text between the first and last ``` fence.
        return f"```\n{value.instruction}\n```"


def _card_summary(card: StoredCard | None, error: str | None) -> str:
    if card is None:
        return f"No valid card ({error or 'unknown error'})."
    flags = "; ".join(f'{f.kind} on {f.turn_id}: "{clean(f.quote)[:120]}"' for f in card.flags) or "none"
    f = card.finding
    return (
        f"Answer category: {card.answer_category}. Flags: {flags}. Finding: {f.label} ({f.likelihood}, confidence"
        f" {f.confidence}), cited turns {f.cited_turns}. Follow-up: {clean(card.follow_up.question)}"
    )


def _input_summary(example: Example) -> str:
    rows = example.context["transcript"][-3:]
    lines = [f"Exchange {example.turn}; {len(example.context['released_evidence'])} record(s) released so far."]
    lines += [f"t{r['turn_no']:02d} Q: {clean(r['question'])[:300]} A: {clean(r['answer'])[:400]}" for r in rows]
    return "\n".join(lines)


@dataclass(frozen=True)
class Trace:
    example: Example
    grade: Grade | None  # None: the candidate was refused before any call (see `summary`)
    summary: str


@dataclass
class GymAdapter:
    evaluator: CardEvaluator
    champion: PromptSet
    playbook: str
    version: str
    bridge: Bridge
    propose_new_texts: ProposalFn | None = None
    graded: dict[str, list[tuple[Example, Grade]]] = field(default_factory=dict)  # strategy -> its grades

    def candidate(self, strategy: str) -> Candidate:
        texts = {STRATEGY: strategy, PLAYBOOK: self.playbook}
        return build(self.champion, texts, self.version, "Coach Gym challenger")

    def evaluate(
        self, batch: list[Example], candidate: dict[str, str], capture_traces: bool = False
    ) -> EvaluationBatch[Trace, str]:
        if any(e.partition == "holdout" for e in batch):
            msg = "a holdout example reached the optimizer"
            raise HoldoutLeakError(msg)
        strategy = candidate[STRATEGY]
        if len(strategy) > MAX_STRATEGY_CHARS or not strategy.strip():
            note = f"The strategy block must be 1-{MAX_STRATEGY_CHARS} characters; this one is {len(strategy)}."
            traces = [Trace(e, None, note) for e in batch]
            return EvaluationBatch([note] * len(batch), [0.0] * len(batch), traces if capture_traces else None)
        results = self.bridge(self.evaluator.grade_all(self.candidate(strategy).prompts, batch))
        self.graded.setdefault(strategy, []).extend((e, g) for e, (g, _) in zip(batch, results, strict=True))
        outputs = [_card_summary(run.card, run.error) for _, run in results]
        traces = [Trace(e, g, out) for e, (g, _), out in zip(batch, results, outputs, strict=True)]
        return EvaluationBatch(outputs, [float(g.score) for g, _ in results], traces if capture_traces else None)

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch[Trace, str],
        components_to_update: list[str],
    ) -> Mapping[str, Sequence[Mapping[str, Any]]]:
        _ = candidate
        records = []
        for trace in eval_batch.trajectories or []:
            grade = trace.grade
            records.append(
                {
                    "Inputs": _input_summary(trace.example),
                    "Generated Outputs": trace.summary,
                    "Feedback": trace.summary if grade is None else grade.feedback,
                    "score": 0.0 if grade is None else round(float(grade.score), 3),
                }
            )
        return dict.fromkeys(components_to_update, records)


@dataclass
class BudgetStop:
    """Stop before the optimizer's share is spent: when what is left would not cover one more minibatch of cards
    and one reflection call at their worst case."""

    meter: Meter
    per_iteration: Decimal

    def __call__(self, gepa_state: GEPAState[Any, Any]) -> bool:
        _ = gepa_state
        return self.meter.remaining < self.per_iteration


class _Log:
    def log(self, message: str) -> None:
        log.info("gepa: %s", message)


@dataclass(frozen=True)
class OptimizeResult:
    strategy: str
    series: list[dict[str, Any]]
    stop_reason: str


def per_iteration_cost(champion: PromptSet, examples: Sequence[Example], minibatch: int) -> Decimal:
    """An upper bound for one GEPA iteration: a minibatch of cards for parent and child plus one reflection."""
    sample = examples[0] if examples else None
    card = Decimal(0)
    if sample is not None:
        rows = sample.context["transcript"]
        text = "\n".join(f"{r['question']} {r['answer']}" for r in rows) * 4
        model = VertexModel(champion.manifest.limits["card"].model_id)
        card = worst_case(model, CallType.CARD, "\n".join(champion.texts.values()), text, GymInstruction)
    reflect = worst_case(REFLECT_MODEL, CallType.FINAL, REFLECT_SYSTEM, "x" * 60_000, GymInstruction)
    return card * 2 * minibatch + reflect


@dataclass(frozen=True)
class Search:
    """What GEPA searches over and how long: the train pool (canaries included), its validation set, the
    reflection model, the metric-call cap and the minibatch size."""

    train: Sequence[Example]
    val: Sequence[Example]
    reflection: ReflectionLM
    max_evals: int
    minibatch: int = 3


def optimize(adapter: GymAdapter, search: Search) -> OptimizeResult:
    """Run GEPA from the champion's strategy (blocking: call it from a worker thread)."""
    seed = components(adapter.champion)[STRATEGY]
    train, val, minibatch = search.train, search.val, search.minibatch
    stop = BudgetStop(adapter.evaluator.meter, per_iteration_cost(adapter.champion, train, minibatch))
    try:
        result: GEPAResult[Any, Any] = gepa_optimize(
            seed_candidate={STRATEGY: seed},
            trainset=list(train),
            valset=list(val),
            adapter=adapter,
            reflection_lm=search.reflection,
            max_metric_calls=search.max_evals,
            stop_callbacks=[stop],
            reflection_minibatch_size=minibatch,
            raise_on_exception=False,
            cache_evaluation=True,
            use_merge=False,
            display_progress_bar=False,
            logger=_Log(),
            seed=0,
        )
    except BudgetExhaustedError as exc:
        log.warning("coach gym: the search stopped before it began: %s", exc)
        return OptimizeResult(seed, [], "the budget ran out before the champion's validation score")
    series = [
        {
            "candidate": i,
            "parent": result.parents[i][0] if result.parents[i] else None,
            "metric_calls": result.discovery_eval_counts[i],
            "val_score": round(result.val_aggregate_scores[i], 4),
        }
        for i in range(len(result.candidates))
    ]
    best = result.best_candidate
    strategy = best[STRATEGY] if isinstance(best, dict) else seed
    reason = "budget" if stop.meter.remaining < stop.per_iteration else "max_evals"
    return OptimizeResult(strategy, series, reason)


async def run_in_thread[T](fn: Callable[[Bridge], T]) -> T:
    """Run blocking GEPA code in a worker thread with a bridge back to this event loop."""
    loop = asyncio.get_running_loop()

    def bridge[R](coro: Coroutine[Any, Any, R]) -> R:
        return asyncio.run_coroutine_threadsafe(coro, loop).result()

    return await asyncio.to_thread(fn, bridge)
