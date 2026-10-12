"""Ports for the interactive and replay-corpus harness tracks (S2 8, S5 5.3).

`HarnessAsker` implements `TrialPorts` and `CorpusAsker` implements `CorpusPorts`
(`arena_core.turns.harness`), each over the real `Orchestrator` and `ArenaDb` -- the same `arena_public`
primitives `arena-api` uses (S5 2.2) -- never a duplicate of the question-level decisions (the relay test,
the fallback cycle, the replay script) `harness.py` already owns; these two classes only carry the
database's answer back to it.

`run_interactive` and `run_corpus` are plain synchronous functions (no model call, no database, AT-HAR-6), so
the runner drives them in a worker thread (`asyncio.to_thread`) and each port method hands its coroutine back
to the runner's own event loop (`loop`, captured where the trial starts) with `run_coroutine_threadsafe`,
then blocks the worker thread on the result. Every coroutine therefore runs on the one long-lived loop that
owns the job's pooled clients (the database pool, the Vertex and HTTP clients `main.build_runner` builds
once): a fresh `asyncio.run` per call would bind a pooled connection to a loop it then closes, and the next
call on that connection fails with "Event loop is closed". The loop is free while the worker thread waits,
because the runner is suspended in `await asyncio.to_thread(...)`.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from arena_core.contracts.coaching import StoredCard
from arena_core.db.arena import ArenaDb, CoachEvent, QuestionOrigin
from arena_core.scenario.relay import ReleasedRecord
from arena_core.turns.harness import (
    BudgetStopError,
    Card,
    CorpusPorts,
    HarnessQuestion,
    SubjectStopError,
    TransientStopError,
    TrialPorts,
)
from arena_core.turns.orchestrator import HARNESS_BUDGET_STOPS, Orchestrator, TurnRefusedError

COACH_EVENT_KINDS = ("coach_card", "coach_unavailable")
# The corpus track's own release step already applied every due record before this exchange's question
# (S2 8.6); the turn's own release call therefore always runs with an empty list (still required, S5 5.2
# step 2's "always called" rule, harmless here: nothing is left to apply).
NO_RELEASES: tuple[str, ...] = ()


def _on_loop[T](loop: asyncio.AbstractEventLoop, coro: Coroutine[Any, Any, T]) -> T:
    """Runs `coro` on the runner's loop from the harness's worker thread and waits for its result."""
    return asyncio.run_coroutine_threadsafe(coro, loop).result()


async def _ask(
    orchestrator: Orchestrator, trial: UUID, n: int, question: HarnessQuestion, record_requests: Sequence[str]
) -> None:
    """Shared by both tracks' `.ask`: records the question and its answer, then raises the matching
    `StopError` for a quarantine or a budget refusal (ST-3, ST-4, already recorded by `_answer` itself), the
    subject's own kill switch (ST-4 groups it with a budget refusal, "the per-call spend guard refused a
    reservation, or the kill switch is on" -- `_answer` maps it to `TurnRefusedError(503, "paused")`, with
    nothing else recording a terminal state for it), or a genuine infra-level subject refusal (ST-5,
    recorded here -- unlike the other stop paths, nothing else writes it, S2 8.5)."""
    origin = QuestionOrigin(question.source.value, question.relay_outcome, question.proposal_seq)
    try:
        outcome = await orchestrator.harness_turn(trial, n, question.text, record_requests, origin)
    except TurnRefusedError as exc:
        if exc.code == "paused":
            await orchestrator.stop(trial, "budget_truncated", str(exc))
            raise BudgetStopError(dispatched=True) from exc
        await orchestrator.stop(trial, "infra_failed", str(exc))
        raise TransientStopError(str(exc)) from exc
    if outcome.outcome == "quarantined":
        raise SubjectStopError(outcome.outcome)
    if outcome.outcome == "budget":
        raise BudgetStopError(dispatched=True)


async def _budget_stopped(db: ArenaDb, trial: UUID) -> bool:
    meta = await db.tournament_trial(trial)
    return meta is not None and meta["execution_state"] == "budget_truncated"


async def _latest_coach_event(db: ArenaDb, trial: UUID, n: int) -> CoachEvent | None:
    """The turn's `coach_card` or `coach_unavailable` event, read back so the harness can decide what to
    relay: `coach_after_answer` itself returns only a version, never the card content (S5 5.2). Read through
    `arena.harness_trial_state` (WP-28), the job's own in-flight read, which sees a running hidden trial's
    events before reveal; the reveal-gated `arena.v_trial_events` would show it nothing."""
    events = (await db.harness_trial_state(trial)).coach_events
    matching = [e for e in events if e.turn_no == n and e.kind in COACH_EVENT_KINDS]
    return matching[-1] if matching else None


def _card_from_event(event: CoachEvent) -> Card | None:
    if event.kind == "coach_unavailable":
        return None
    stored = StoredCard.model_validate(event.payload)
    return Card(
        seq=event.seq,
        question=stored.follow_up.question,
        commit_requested=stored.commit_requested,
        record_request=stored.follow_up.record_request,
    )


@dataclass(frozen=True)
class HarnessAsker(TrialPorts):
    """The interactive track's ports: one tournament trial, no model call and no subject text in any
    decision of its own (AT-HAR-6)."""

    trial: UUID
    orchestrator: Orchestrator
    loop: asyncio.AbstractEventLoop

    def _run[T](self, coro: Coroutine[Any, Any, T]) -> T:
        return _on_loop(self.loop, coro)

    def ask(self, n: int, question: HarnessQuestion, record_requests: Sequence[str]) -> None:
        self._run(_ask(self.orchestrator, self.trial, n, question, record_requests))

    def card(self, n: int) -> Card | None:
        db = self.orchestrator.db
        self._run(self.orchestrator.coach_after_answer(self.trial, n))
        if self._run(_budget_stopped(db, self.trial)):
            raise BudgetStopError(dispatched=True)
        event = self._run(_latest_coach_event(db, self.trial, n))
        if event is None:
            # Discarded as stale (overtaken by a release or the next question, S4 AR002): the harness treats
            # a missing card exactly like a failed one (`fallback_no_card`).
            return None
        return _card_from_event(event)

    def final(self) -> bool:
        db = self.orchestrator.db
        meta = self._run(db.tournament_trial(self.trial))
        n_completed = 0 if meta is None else int(meta["exchanges"])
        try:
            completed = self._run(self.orchestrator.final_and_finalize(self.trial, n_completed))
        except HARNESS_BUDGET_STOPS as exc:
            self._run(self.orchestrator.stop(self.trial, "budget_truncated", str(exc)))
            raise BudgetStopError(dispatched=True) from exc
        if not completed:
            self._run(
                self.orchestrator.stop(self.trial, "assistant_failed", "the final call failed after its one repair")
            )
        return completed


@dataclass(frozen=True)
class CorpusAsker(CorpusPorts):
    """The replay-corpus track's ports (S2 8.6; BKO-6): no coaching, no commit, no assistant -- the harness
    only releases what is due, asks the script's question and records the subject's answer."""

    trial: UUID
    orchestrator: Orchestrator
    public_packet: Mapping[str, Any]
    loop: asyncio.AbstractEventLoop

    def _run[T](self, coro: Coroutine[Any, Any, T]) -> T:
        return _on_loop(self.loop, coro)

    def _title(self, record_id: str, titles: Mapping[str, str]) -> str:
        if record_id in titles:
            return titles[record_id]
        for row in self.public_packet.get("requestable_records", []):
            if row["record_id"] == record_id:
                return str(row["title"])
        return record_id  # unreachable on a validated case (S1 V1c); a safe fallback, never a crash

    def _date(self, record_id: str) -> str | None:
        """The public packet's own optional record date (S2 8.6; not one of `arena.harness_trial_state`'s released
        columns, so this always reads the packet, unlike `_title`'s released-row shortcut)."""
        for row in self.public_packet.get("requestable_records", []):
            if row["record_id"] == record_id:
                date = row.get("date")
                return str(date) if date is not None else None
        return None

    def release(self, n: int, record_ids: Sequence[str]) -> Sequence[ReleasedRecord]:
        db = self.orchestrator.db
        result = self._run(self.orchestrator.request_evidence(self.trial, list(record_ids), f"corpus:{n}"))
        released_ids = [row["record_id"] for row in result["released"]]
        if not released_ids:
            return []
        state = self._run(db.harness_trial_state(self.trial))
        titles = {row["record_id"]: row["title"] for row in state.released}
        return [ReleasedRecord(rid, n - 1, self._title(rid, titles), self._date(rid)) for rid in released_ids]

    def ask(self, n: int, question: HarnessQuestion) -> None:
        self._run(_ask(self.orchestrator, self.trial, n, question, NO_RELEASES))
