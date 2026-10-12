"""`ReplayScorer.run` (S5 5.3; D2): copies each source turn and coaches it, stops at the first recorded
terminal state, then makes the final call -- a budget refusal or the kill switch there is ST-4
(`budget_truncated`), a failed final call ST-6 (`assistant_failed`)."""

from __future__ import annotations

import asyncio
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.db.arena import ArenaDb
from arena_core.providers.errors import BudgetRefusedError, KillSwitchOnError
from arena_core.scenario.relay import REPLAY_EXCHANGES
from arena_core.turns.harness import Execution
from arena_core.turns.orchestrator import Orchestrator
from arena_core.turns.replay import ReplayScorer


class _Db:
    def __init__(self, *, done: frozenset[int] = frozenset()) -> None:
        self.done = done
        self.advanced: list[int] = []
        self.state: str | None = None
        self.stop_after: int | None = None
        self.n = 0

    async def open_work_item(self, _trial: UUID, _kind: str, key: str, *_args: object) -> dict[str, Any]:
        self.n += 1  # one replay_turn work item per copied turn, in order
        status = "done" if self.n in self.done else "open"
        return {"status": status, "work_item_id": str(uuid4()), "key": key}

    async def advance_replay(self, _trial: UUID, _work_item: UUID) -> dict[str, Any]:
        self.advanced.append(self.n)
        return {}

    async def tournament_trial(self, _trial: UUID) -> dict[str, Any]:
        return {"execution_state": self.state}


class _Orch:
    def __init__(self, db: _Db, final: bool | Exception = True) -> None:
        self.db = db
        self.final = final
        self.coached: list[int] = []
        self.stopped: list[str] = []

    async def coach_after_answer(self, _trial: UUID, n: int) -> None:
        self.coached.append(n)
        if self.db.stop_after == n:
            self.db.state = "budget_truncated"

    async def final_and_finalize(self, _trial: UUID, _n: int) -> bool:
        if isinstance(self.final, Exception):
            raise self.final
        return self.final

    async def stop(self, _trial: UUID, state: str, _reason: str) -> None:
        self.stopped.append(state)


def _run(db: _Db, orch: _Orch) -> Execution:
    scorer = ReplayScorer(cast("ArenaDb", db), cast("Orchestrator", orch))
    return asyncio.run(scorer.run(uuid4()))


def test_copies_and_coaches_every_turn_then_completes() -> None:
    db = _Db()
    orch = _Orch(db)
    assert _run(db, orch) is Execution.COMPLETED
    assert orch.coached == list(range(1, REPLAY_EXCHANGES + 1))
    assert len(db.advanced) == REPLAY_EXCHANGES
    assert orch.stopped == []


def test_a_resumed_trial_never_recopies_a_finished_turn() -> None:
    db = _Db(done=frozenset({1}))
    orch = _Orch(db)
    assert _run(db, orch) is Execution.COMPLETED
    assert len(db.advanced) == REPLAY_EXCHANGES - 1
    assert orch.coached == list(range(1, REPLAY_EXCHANGES + 1))


def test_stops_at_the_state_a_coach_step_recorded() -> None:
    db = _Db()
    db.stop_after = 2
    orch = _Orch(db)
    assert _run(db, orch) is Execution.BUDGET_TRUNCATED
    assert orch.coached == [1, 2]


@pytest.mark.parametrize("error", [BudgetRefusedError("cap"), KillSwitchOnError("the kill switch is on")])
def test_a_budget_stop_on_the_final_call_is_budget_truncated(error: Exception) -> None:
    db = _Db()
    orch = _Orch(db, final=error)
    assert _run(db, orch) is Execution.BUDGET_TRUNCATED
    assert orch.stopped == ["budget_truncated"]


def test_a_failed_final_call_is_assistant_failed() -> None:
    db = _Db()
    orch = _Orch(db, final=False)
    assert _run(db, orch) is Execution.ASSISTANT_FAILED
    assert orch.stopped == ["assistant_failed"]
