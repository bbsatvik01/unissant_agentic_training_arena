"""`TournamentRunner`'s own resumable state machine (`_run_until_terminal`, S4 EF-05..EF-11; D3), against
light fakes for `db`/`orchestrator`/`referee` -- the admission refusal, `source_unavailable`, the
infra-retry-then-succeed and infra-retry-exhausted paths it_tournament.py's happy path and its one
mid-block-restart scenario never reach. `_count`/`_current_attempt` directly; the track methods lean on
`roster.py`'s own fixtures and are covered end to end in it_tournament.py (make db-test)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import CandidateManifest
from arena_core.db.arena import ArenaDb
from arena_core.turns.harness import Execution
from arena_core.turns.orchestrator import Orchestrator
from arena_tournament import admission
from arena_tournament import runner as runner_module
from arena_tournament.referee_client import RefereeClient
from arena_tournament.runner import MAX_ATTEMPTS, Attempt, HiddenTournamentError, TournamentRunner
from packages.core.tests.turns.test_orchestrator import Rig


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


class _FakeDb:
    """Only the three calls `_run_until_terminal` itself ever makes directly, plus the three reads
    `run_replay_track_prerequisite` makes before it (split, then an empty roster so its own corpus/replay
    loops do nothing)."""

    def __init__(self, *, admit: bool = True, start_state: str | None = None, split: str = "dev") -> None:
        self.admit = admit
        self.start_state = start_state
        self.split = split
        self.retry_calls: list[UUID] = []
        self.started: list[UUID] = []

    async def admit_unit(self, _bucket: str, _cost: object) -> dict[str, Any]:
        return {"decision": "admit" if self.admit else "refuse", "free_usd": 0.0}

    async def start_trial(self, trial: UUID) -> dict[str, Any]:
        self.started.append(trial)
        return {} if self.start_state is None else {"state": self.start_state}

    async def retry_trial(self, planned_trial: UUID) -> UUID:
        self.retry_calls.append(planned_trial)
        return uuid4()

    async def tournament_split(self, _tournament: UUID) -> str:
        return self.split

    async def planned_trials(self, _tournament: UUID) -> list[dict[str, Any]]:
        return []

    async def planned_trial_attempts(self, _tournament: UUID) -> dict[UUID, list[dict[str, Any]]]:
        return {}


class _FakeOrchestrator:
    def __init__(self) -> None:
        self.stopped: list[tuple[UUID, str, str]] = []

    async def stop(self, trial: UUID, state: str, reason: str) -> None:
        self.stopped.append((trial, state, reason))


def _runner_with(db: _FakeDb, orchestrator: _FakeOrchestrator) -> TournamentRunner:
    return TournamentRunner(
        db=cast("ArenaDb", db),
        orchestrator=cast("Orchestrator", orchestrator),
        referee=cast("RefereeClient", object()),
        manifests={},
    )


def _attempts(execution_state: str | None, *, attempt: int = 1) -> list[Attempt]:
    return [{"trial_id": uuid4(), "attempt": attempt, "status": "planned", "execution_state": execution_state}]


def test_current_attempt_is_the_latest_when_retriable_and_none_once_terminal() -> None:
    runner = _runner_with(_FakeDb(), _FakeOrchestrator())
    retriable = _attempts(None)
    assert runner._current_attempt(retriable) == retriable[-1]
    infra = _attempts("infra_failed")
    assert runner._current_attempt(infra) == infra[-1]
    done = _attempts("completed")
    assert runner._current_attempt(done) is None


def test_run_until_terminal_stops_with_budget_skipped_when_admission_refuses() -> None:
    db = _FakeDb(admit=False)
    orch = _FakeOrchestrator()
    runner = _runner_with(db, orch)
    attempts = _attempts(None)
    planned_trial_id = uuid4()

    async def step(_trial: UUID) -> Execution:
        msg = "never reached: admission refused before any step runs"
        raise AssertionError(msg)

    run(runner._run_until_terminal(planned_trial_id, attempts, [], step))
    assert runner.outcomes == {"budget_skipped": 1}
    assert orch.stopped == [(attempts[0]["trial_id"], "budget_skipped", "ops.admit_unit: not enough budget free")]
    assert db.started == []


def test_run_until_terminal_counts_source_unavailable_and_never_calls_step() -> None:
    db = _FakeDb(start_state="source_unavailable")
    runner = _runner_with(db, _FakeOrchestrator())
    attempts = _attempts(None)

    async def step(_trial: UUID) -> Execution:
        msg = "never reached: start_trial already derived source_unavailable"
        raise AssertionError(msg)

    run(runner._run_until_terminal(uuid4(), attempts, [], step))
    assert runner.outcomes == {"source_unavailable": 1}


def test_run_until_terminal_counts_the_steps_outcome_on_the_happy_path() -> None:
    db = _FakeDb()
    runner = _runner_with(db, _FakeOrchestrator())
    attempts = _attempts(None)

    async def step(_trial: UUID) -> Execution:
        return Execution.COMPLETED

    run(runner._run_until_terminal(uuid4(), attempts, [], step))
    assert runner.outcomes == {"completed": 1}
    assert db.started == [attempts[0]["trial_id"]]


def test_run_until_terminal_maps_an_unexpected_step_exception_to_infra_failed_and_stops_it() -> None:
    db = _FakeDb()
    orch = _FakeOrchestrator()
    runner = _runner_with(db, orch)
    attempts = _attempts(None, attempt=MAX_ATTEMPTS)  # already at the cap: one infra_failed attempt, no retry

    async def step(_trial: UUID) -> Execution:
        msg = "a provider blew up"
        raise RuntimeError(msg)

    run(runner._run_until_terminal(uuid4(), attempts, [], step))
    assert runner.outcomes == {"infra_failed": 1}
    assert orch.stopped[0][1] == "infra_failed"
    assert "a provider blew up" in orch.stopped[0][2]


def test_run_until_terminal_retries_after_infra_failed_then_succeeds() -> None:
    db = _FakeDb()
    runner = _runner_with(db, _FakeOrchestrator())
    attempts = _attempts("infra_failed", attempt=1)  # below MAX_ATTEMPTS: one retry is still available
    planned_trial_id = uuid4()
    calls = {"n": 0}

    async def step(_trial: UUID) -> Execution:
        calls["n"] += 1
        return Execution.COMPLETED

    run(runner._run_until_terminal(planned_trial_id, attempts, [], step))
    assert db.retry_calls == [planned_trial_id]
    assert calls["n"] == 1
    assert runner.outcomes == {"completed": 1}


def test_run_until_terminal_gives_up_once_the_attempt_cap_is_spent() -> None:
    db = _FakeDb()
    runner = _runner_with(db, _FakeOrchestrator())
    attempts = _attempts("infra_failed", attempt=MAX_ATTEMPTS)

    async def step(_trial: UUID) -> Execution:
        msg = "never reached: the cap is already spent"
        raise AssertionError(msg)

    run(runner._run_until_terminal(uuid4(), attempts, [], step))
    assert runner.outcomes == {}
    assert db.retry_calls == []


def test_count_keys_an_execution_value_by_its_string_and_accumulates() -> None:
    runner = _runner_with(_FakeDb(), _FakeOrchestrator())
    runner._count(Execution.COMPLETED)
    runner._count(Execution.COMPLETED)
    runner._count("budget_skipped")
    assert runner.outcomes == {"completed": 2, "budget_skipped": 1}


def test_run_replay_track_prerequisite_refuses_a_hidden_tournament_before_any_read() -> None:
    """A real gap (Codex round 1): `lifecycle.open_tournament` refuses split="hidden" at open time, but
    that is this operator tool's own convenience, not a database invariant `arena.open_tournament` itself
    enforces -- a hidden tournament opened by any other path must still never reach the job's own harness
    (no WP-16 hidden-text scan exists yet)."""
    db = _FakeDb(split="hidden")
    runner = _runner_with(db, _FakeOrchestrator())
    with pytest.raises(HiddenTournamentError):
        run(runner.run_replay_track_prerequisite(uuid4()))


def test_run_replay_track_prerequisite_proceeds_for_a_dev_tournament() -> None:
    db = _FakeDb(split="dev")
    runner = _runner_with(db, _FakeOrchestrator())
    run(runner.run_replay_track_prerequisite(uuid4()))  # an empty roster: nothing else to do


class _FakeReferee:
    def __init__(self) -> None:
        self.scored: list[UUID] = []

    async def score_trial(self, trial: UUID) -> None:
        self.scored.append(trial)


@pytest.mark.parametrize(
    ("outcome", "scored"),
    [
        (Execution.COMPLETED, True),
        (Execution.ASSISTANT_FAILED, True),  # S2/S3: judged too, as included_as_insufficient
        (Execution.BUDGET_TRUNCATED, False),
    ],
)
def test_replay_track_scores_every_trial_that_needs_review(
    monkeypatch: pytest.MonkeyPatch, outcome: Execution, *, scored: bool
) -> None:
    """S3: "every completed and assistant_failed trial" needs review, so a replay trial whose final call failed
    still goes to the referee (a real gap, Codex round 2: only COMPLETED was dispatched)."""

    class _Scorer:
        def __init__(self, *_args: object) -> None:
            pass

        async def run(self, _trial: UUID) -> Execution:
            return outcome

    monkeypatch.setattr(runner_module, "ReplayScorer", _Scorer)
    monkeypatch.setattr(admission, "replay_trial_calls", lambda _manifest: [])
    referee = _FakeReferee()
    runner = _runner_with(_FakeDb(), _FakeOrchestrator())
    runner.referee = cast("RefereeClient", referee)
    planned_id, assistant_id = uuid4(), uuid4()
    runner.manifests = {assistant_id: cast("CandidateManifest", object())}
    attempts = _attempts(None)
    row = {"planned_trial_id": planned_id, "assistant_candidate_id": assistant_id}
    run(runner._run_replay_track([row], {planned_id: attempts}))
    assert referee.scored == ([attempts[0]["trial_id"]] if scored else [])


def test_an_interactive_trial_runs_end_to_end_through_the_harness_on_the_runners_loop() -> None:
    """`_run_interactive_trial`: the harness loop in a worker thread, every port call on this loop (the
    orchestrator double's own fake database), through to the final call and its commitment."""
    rig = Rig()
    rig.db.kind = "interactive"
    assert run(runner_module._run_interactive_trial(rig.db.trial_id, rig.orch, "What happened?")) is Execution.COMPLETED
    assert rig.db.status == "finalized"


class _TrackDb(_FakeDb):
    def __init__(self, rows: list[dict[str, Any]], packet: dict[str, Any] | None) -> None:
        super().__init__()
        self.rows = rows
        self.packet = packet
        self.attempts = {r["planned_trial_id"]: _attempts(None) for r in rows}

    async def public_packet(self, _variant: UUID) -> dict[str, Any] | None:
        return self.packet

    async def planned_trials(self, _tournament: UUID) -> list[dict[str, Any]]:
        return self.rows

    async def planned_trial_attempts(self, _tournament: UUID) -> dict[UUID, list[dict[str, Any]]]:
        return self.attempts


class _TrackOrchestrator(_FakeOrchestrator):
    def __init__(self) -> None:
        super().__init__()
        self.finalized: list[UUID] = []

    async def finalize_corpus(self, trial: UUID) -> None:
        self.finalized.append(trial)


class _TrackReferee(_FakeReferee):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    async def score_block(self, _tournament: UUID, block_no: int) -> None:
        self.calls.append(f"block:{block_no}")

    async def corpus_seal(self, _tournament: UUID) -> None:
        self.calls.append("seal")

    async def close(self, _tournament: UUID) -> None:
        self.calls.append("close")


def _track_runner(
    monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]], packet: dict[str, Any] | None, outcome: Execution
) -> tuple[TournamentRunner, _TrackDb, _TrackOrchestrator, _TrackReferee]:
    async def trial(*_args: object) -> Execution:
        return outcome

    monkeypatch.setattr(runner_module, "_run_corpus_trial", trial)
    monkeypatch.setattr(runner_module, "_run_interactive_trial", trial)
    monkeypatch.setattr(admission, "corpus_trial_calls", lambda _m: [])
    monkeypatch.setattr(admission, "interactive_trial_calls", lambda _a, _s: [])
    db, orch, referee = _TrackDb(rows, packet), _TrackOrchestrator(), _TrackReferee()
    runner = _runner_with(db, orch)
    runner.orchestrator = cast("Orchestrator", orch)
    runner.referee = cast("RefereeClient", referee)
    runner.manifests = {cid: cast("CandidateManifest", object()) for r in rows for cid in (r["a"], r["s"])}
    for r in rows:
        r["assistant_candidate_id"], r["subject_candidate_id"] = r["a"], r["s"]
    return runner, db, orch, referee


def _row(track: str, block_no: int | None = None) -> dict[str, Any]:
    return {
        "planned_trial_id": uuid4(),
        "track": track,
        "variant_id": uuid4(),
        "block_no": block_no,
        "position": 1,
        "a": uuid4(),
        "s": uuid4(),
    }


def test_run_finalizes_and_scores_a_completed_corpus_transcript_seals_scores_each_block_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [_row("replay_corpus"), _row("interactive", 1)]
    runner, db, orch, referee = _track_runner(monkeypatch, rows, {"opening_question": "Why?"}, Execution.COMPLETED)
    summary = run(runner.run(uuid4()))
    corpus_trial = db.attempts[rows[0]["planned_trial_id"]][0]["trial_id"]
    assert orch.finalized == [corpus_trial]
    assert referee.scored == [corpus_trial]
    assert referee.calls == ["seal", "block:1", "close"]
    assert summary.closed
    assert summary.outcomes == {"completed": 2}


def test_a_corpus_transcript_that_did_not_complete_is_neither_finalized_nor_scored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner, _db, orch, referee = _track_runner(monkeypatch, [_row("replay_corpus")], {}, Execution.SUBJECT_QUARANTINED)
    run(runner.run_replay_track_prerequisite(uuid4()))
    assert (orch.finalized, referee.scored, referee.calls) == ([], [], ["seal"])


@pytest.mark.parametrize("track", ["replay_corpus", "interactive"])
def test_a_variant_with_no_public_packet_is_refused(monkeypatch: pytest.MonkeyPatch, track: str) -> None:
    runner, *_ = _track_runner(monkeypatch, [_row(track, 1)], None, Execution.COMPLETED)
    with pytest.raises(RuntimeError, match="no public packet"):
        run(runner.run(uuid4()))
