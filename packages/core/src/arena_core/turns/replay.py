"""Replay-corpus scoring loop (S5 5.3; D2).

`ReplayScorer` copies a sealed corpus transcript into its own replay trial one turn at a time
(`arena.advance_replay`), coaching it exactly as an interactive trial would on the replay trial's own turn
numbers, work items and events (AT-HAR-8): card k sees turns 1..k and the evidence released before question k,
nothing later, because `coach_after_answer` reads `trial_context` fresh after each copy. No subject call: the
question and answer of each copied turn are the source's. After the last copied turn, the final call and
`finalize_trial` run through `Orchestrator.final_and_finalize`, exactly as the interactive track's ST-1 stop.

A budget refusal mid-trial is recorded once, by whichever step hit it (`Orchestrator._coach` for a card or deep
update, `ReplayScorer` itself for the final call, which has no `coach_unavailable` equivalent to swallow it);
`run` reads the trial's own execution state back rather than re-deriving the outcome, so the two paths agree.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from arena_core.db.arena import ArenaDb
from arena_core.providers.errors import BudgetRefusedError
from arena_core.scenario.relay import REPLAY_EXCHANGES
from arena_core.turns.harness import Execution
from arena_core.turns.orchestrator import Orchestrator, request_key


@dataclass(frozen=True)
class ReplayScorer:
    db: ArenaDb
    orchestrator: Orchestrator

    async def _execution_state(self, trial: UUID) -> str | None:
        """The trial's own recorded outcome, or None while it is still running (S4 `arena.v_trials`)."""
        meta = await self.db.tournament_trial(trial)
        return None if meta is None else meta["execution_state"]

    async def run(self, trial: UUID) -> Execution:
        """Runs a `replay` trial that `start_trial` has already moved to `running` against a completed,
        `valid` source transcript. Returns the S2 8.5 execution outcome; the caller records nothing further
        for this planned trial (the outcome is already a S4 terminal record, exactly as for an interactive
        harness trial)."""
        for n in range(1, REPLAY_EXCHANGES + 1):
            item = await self.db.open_work_item(trial, "replay_turn", request_key(trial, n, "replay_turn", "replay"))
            if item["status"] != "done":
                await self.db.advance_replay(trial, UUID(item["work_item_id"]))
            await self.orchestrator.coach_after_answer(trial, n)
            state = await self._execution_state(trial)
            if state is not None:
                return Execution(state)
        try:
            completed = await self.orchestrator.final_and_finalize(trial, REPLAY_EXCHANGES)
        except BudgetRefusedError as exc:
            await self.orchestrator.stop(trial, "budget_truncated", str(exc))
            return Execution.BUDGET_TRUNCATED
        if not completed:
            await self.orchestrator.stop(trial, "assistant_failed", "the final call failed after its one repair")
            return Execution.ASSISTANT_FAILED
        return Execution.COMPLETED
