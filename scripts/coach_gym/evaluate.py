"""Coach Gym card runs: a candidate's card call on one example through the real agent port, then the grader.

Every call goes through `AgentPort` and its spend guard (the database guard in a real run: the global ceiling
and the kill switch apply as for any other call), labeled `app=unissant-arena` by the port, purpose
`coach_gym.*`. On top of that, `Meter` caps the whole gym run at `BUDGET`: before each call it holds that call's
worst case (the same formula as `ops.reserve_model_call`, at the request's own size) and refuses once the cap
would be passed; after it, the hold becomes the call's settled cost (the worst case again when the call failed
and its real cost is unknown here). A refusal raises `BudgetExhaustedError`.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Coroutine, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from arena_core.agents.coach_prompts import build_coach_prompt
from arena_core.agents.manifests import PromptSet
from arena_core.coachgym.examples import Example
from arena_core.coachgym.metric import CardRun, Grade, GradeLimits, grade
from arena_core.contracts.coaching import CoachingCard
from arena_core.policy import check_call_policy
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError, ProviderError
from arena_core.providers.port import AgentPort, seed_for
from arena_core.providers.structured import sent_schema
from arena_core.providers.types import (
    AgentCall,
    CallContext,
    CallType,
    Message,
    ModelRequest,
    ThinkingLevel,
    VertexModel,
    request_bytes,
)
from arena_core.spend.limits import LIMITS, REPAIR_BYTES
from arena_core.spend.rates import model_call_reservation, receipt_usd
from arena_core.turns.coach import CardMeta, CoachInputs, coach_inputs, store_card

PURPOSE_CARD = "coach_gym.card"
# The most one card may cost before the mechanical check fails it: one attempt at the card call's whole input
# limit priced as tokens (an over-estimate: a token is several bytes) plus its full output limit, on the dearer
# allowlisted model. A card above it took repairs or retries, or ran far longer than any real card.
CARD_COST_CAP = receipt_usd(
    VertexModel.FLASH_LITE_35, LIMITS[CallType.CARD].input_bytes, LIMITS[CallType.CARD].output_tokens
)


class BudgetExhaustedError(RuntimeError):
    """The gym run's BUDGET would be passed by the next call; nothing was sent."""


@dataclass
class Meter:
    budget: Decimal
    cap: Decimal | None = None  # a lower phase cap (the optimizer's share); None = the whole budget
    spent: Decimal = Decimal(0)
    held: Decimal = Decimal(0)
    calls: int = 0
    largest: Decimal = Decimal(0)  # the largest single hold so far (the stopper's per-call bound)

    @property
    def limit(self) -> Decimal:
        return self.budget if self.cap is None else min(self.cap, self.budget)

    @property
    def remaining(self) -> Decimal:
        return self.limit - self.spent - self.held

    def hold(self, worst: Decimal) -> None:
        if worst > self.remaining:
            msg = f"the gym budget is exhausted: ${self.spent} spent, ${self.held} held, ${self.limit} cap"
            raise BudgetExhaustedError(msg)
        self.held += worst
        self.largest = max(self.largest, worst)

    def settle(self, worst: Decimal, actual: Decimal) -> None:
        self.held -= worst
        self.spent += actual
        self.calls += 1


def reservation_for(call: AgentCall[Any]) -> Decimal:
    """Exactly what `ops.reserve_model_call` will hold for this call: the port measures the attempt-1 request
    (`request_bytes`, the same `ModelRequest` it sends) plus the repair allowance, and the database prices that
    size with the call type's output limit, times the attempts (`spend.rates.model_call_reservation`, parity-tested
    against the seeds). A call that fails without reported usage is charged this full hold."""
    limits = check_call_policy(call, None)
    ctx = call.context
    request = ModelRequest(
        model=call.model,
        system=call.system,
        messages=call.messages,
        json_schema=sent_schema(call.schema),
        max_output_tokens=limits.output_tokens,
        thinking=call.thinking,
        seed=seed_for(str(ctx.trial_id or "none"), ctx.turn_no, ctx.purpose, 1),
    )
    return model_call_reservation(call.model, ctx.call_type, request_bytes(request) + REPAIR_BYTES)


async def run_metered[T: BaseModel](port: AgentPort, meter: Meter, call: AgentCall[T]) -> tuple[T | None, CardRun]:
    """One metered port call. A budget refusal or the kill switch is systemic and raised; any other provider
    failure is the candidate's (no valid output) and returned as a `CardRun` without a card."""
    worst = reservation_for(call)
    meter.hold(worst)
    started = time.monotonic()
    actual = worst
    try:
        result = await port.run(call)
    except (BudgetRefusedError, KillSwitchOnError):
        raise
    except ProviderError as exc:
        latency = int((time.monotonic() - started) * 1000)
        return None, CardRun(None, f"{type(exc).__name__}: {exc}"[:300], latency, worst)
    else:
        actual = result.cost_usd
        return result.value, CardRun(None, None, int(result.latency_ms), result.cost_usd)
    finally:
        meter.settle(worst, actual)


@dataclass
class CardEvaluator:
    """The candidate side (its card) and the grader side (`metric.grade`) of one evaluation."""

    port: AgentPort
    meter: Meter
    run_id: str
    concurrency: int = 4
    calls: list[str] = field(default_factory=list)  # every example id a card was requested for (test evidence)

    def _call(self, prompts: PromptSet, example: Example) -> tuple[AgentCall[CoachingCard], CoachInputs]:
        inputs = coach_inputs(example.context, "card", example.turn)
        prompt = build_coach_prompt(inputs.view, prompts, "card")
        limit = prompts.manifest.limits["card"]
        call = AgentCall(
            model=VertexModel(limit.model_id),
            thinking=ThinkingLevel(limit.thinking_level.lower()),
            system=prompt.system_instruction,
            messages=(Message("user", prompt.user_message),),
            schema=CoachingCard,
            context=CallContext(
                call_type=CallType.CARD,
                purpose=PURPOSE_CARD,
                step_key=f"coach_gym:{self.run_id}:{uuid4().hex}",
                turn_no=example.turn,
                split="dev",
                data_class="public",
            ),
            timeout_s=limit.attempt_timeout_ms / 1000,
            deadline_s=limit.deadline_ms / 1000,
            validation_context=inputs.citations,
            salt=prompt.salt,
        )
        return call, inputs

    async def card(self, prompts: PromptSet, example: Example) -> CardRun:
        self.calls.append(example.example_id)
        call, inputs = self._call(prompts, example)
        value, run = await run_metered(self.port, self.meter, call)
        if value is None:
            return run
        meta = CardMeta(run.latency_ms, uuid4(), 0, prompts.manifest.sha256 or "")
        try:
            stored = store_card(value, inputs, meta)
        except ValidationError as exc:  # a valid card.v1 whose stored form breaks a code-filled rule (S2 4.1)
            return CardRun(None, f"stored card invalid ({exc.error_count()} error(s))", run.latency_ms, run.cost_usd)
        return CardRun(stored, None, run.latency_ms, run.cost_usd)

    async def grade_all(self, prompts: PromptSet, examples: Sequence[Example]) -> list[tuple[Grade, CardRun]]:
        limit = prompts.manifest.limits["card"]
        limits = GradeLimits(deadline_ms=limit.deadline_ms, cost_cap_usd=CARD_COST_CAP)
        gate = asyncio.Semaphore(self.concurrency)

        async def one(example: Example) -> tuple[Grade, CardRun]:
            async with gate:
                run = await self.card(prompts, example)
            return grade(example, run, limits), run

        return await gather_all([one(e) for e in examples])


async def gather_all[T](coros: Sequence[Coroutine[Any, Any, T]]) -> list[T]:
    """Every coroutine in one task group: the first failure cancels the rest (no call keeps spending after the
    budget or the kill switch stopped the batch) and is raised as itself."""
    try:
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(c) for c in coros]
    except ExceptionGroup as failed:
        raise failed.exceptions[0] from failed
    return [t.result() for t in tasks]
