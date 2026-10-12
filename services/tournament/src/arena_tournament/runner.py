"""The resumable tournament runner (S5 5.3; D3, BKO-2).

Three phases in the sponsor's order: every `replay_corpus` transcript (scored R1, with its initial validity
verdict), the one corpus-seal call, every `replay` trial (scored R2 against its source's stored R1), then
every `interactive` block (scored R1+R2 after the block's last trial), then close.

A planned trial already at a terminal execution state is skipped outright. One still in progress (a killed
job's partial attempt) is resumed by simply re-running its harness loop from the top: every step of
`run_interactive`, `run_corpus` and `ReplayScorer.run` is idempotent by its own work item or question key (S5
5.1), so replaying an already-recorded step makes no model call and reasks no question -- it just reads the
stored result back and continues from wherever the process actually stopped. The runner itself therefore
keeps no partial state of its own across a restart; "no duplicate execution record" (S4 EF-05..EF-11) holds
because every terminal write (`finalize_trial`, `record_execution_failure`, `record_subject_turn`'s
quarantine path) is itself idempotent or guarded by the trial's own status.

`ops.admit_unit` is checked only for an attempt still `planned` (never started): a resumed, already-`running`
attempt relies on the per-call spend guard alone (S4 8.5), because `record_execution_failure` has no
`running -> budget_skipped` transition -- only `planned -> budget_skipped` -- a mid-trial budget stop is
always `budget_truncated`, and that is recorded by the step that hit it, not by this admission check.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from arena_core.agents.manifests import CandidateManifest
from arena_core.db.arena import ArenaDb
from arena_core.scoring.ranking import IG_CHECK_NAMES, IG_ITEMS
from arena_core.spend.rates import ModeledCall
from arena_core.turns.harness import CorpusPorts, Execution, run_corpus, run_interactive
from arena_core.turns.orchestrator import Orchestrator
from arena_core.turns.replay import ReplayScorer
from arena_tournament import admission
from arena_tournament.blocks import group_interactive_by_block
from arena_tournament.harness_asker import CorpusAsker, HarnessAsker
from arena_tournament.referee_client import RefereeClient

log = logging.getLogger("arena_tournament")


class IsolationGateNotPassedError(RuntimeError):
    """A hidden tournament whose isolation gate (S1 L9, S3 9: the six IG items, the hidden-text scan among them)
    did not pass, on one commit, before it went `running`. `arena.open_tournament` itself checks nothing, so the
    job refuses to run one opened any other way than the referee's gated open route."""


class MissingPacketError(RuntimeError):
    """A started trial whose variant has no public packet: a data defect (S4 ingest stores one per variant), not
    an infra failure, so the job stops instead of spending retries on it."""


MAX_ATTEMPTS = 3  # S4 arena.retry_trial: at most 3 attempts total (2 retries after infra_failed)
BUCKET = "global"  # D-013: one global spend bucket
# S3: "every completed and assistant_failed trial" needs review (assistant_failed counts as insufficient_evidence)
NEEDS_REVIEW = frozenset({Execution.COMPLETED, Execution.ASSISTANT_FAILED})
Attempt = dict[str, Any]
Row = Mapping[str, Any]
Step = Callable[[UUID], Awaitable[Execution]]


@dataclass(frozen=True)
class RunSummary:
    tournament_id: UUID
    outcomes: dict[str, int]  # execution state (plus "source_unavailable") -> count, every track combined
    closed: bool


async def _run_interactive_trial(trial: UUID, orchestrator: Orchestrator, opening_question: str) -> Execution:
    ports = HarnessAsker(trial, orchestrator, asyncio.get_running_loop())
    outcome = await asyncio.to_thread(run_interactive, ports, opening_question)
    return outcome.execution


async def _run_corpus_trial(trial: UUID, orchestrator: Orchestrator, public_packet: Mapping[str, Any]) -> Execution:
    ports: CorpusPorts = CorpusAsker(trial, orchestrator, public_packet, asyncio.get_running_loop())
    outcome = await asyncio.to_thread(run_corpus, ports, public_packet)
    return outcome.execution


@dataclass
class TournamentRunner:
    db: ArenaDb
    orchestrator: Orchestrator
    referee: RefereeClient
    manifests: dict[UUID, CandidateManifest]  # every roster candidate's manifest, by candidate id
    outcomes: dict[str, int] = field(default_factory=dict)

    def _count(self, state: Execution | str) -> None:
        key = state.value if isinstance(state, Execution) else state
        self.outcomes[key] = self.outcomes.get(key, 0) + 1

    # ------------------------------------------------------------------ attempt bookkeeping (resumability)

    def _current_attempt(self, attempts: list[Attempt]) -> Attempt | None:
        """The latest attempt, or None if the planned trial already reached a non-retriable terminal state
        (an empty list is impossible here: `freeze_tournament` always creates attempt 1)."""
        latest = attempts[-1]
        return None if latest["execution_state"] not in (None, "infra_failed") else latest

    async def _admit(self, calls: list[ModeledCall], label: str) -> bool:
        cost = admission.unit_cost(calls)
        result = await self.db.admit_unit(BUCKET, cost)
        admitted = bool(result["decision"] == "admit")
        if not admitted:
            log.warning("%s skipped at admission: %s", label, result)
        return admitted

    async def _run_until_terminal(
        self, planned_trial_id: UUID, attempts: list[Attempt], admission_calls: list[ModeledCall], step: Step
    ) -> None:
        """Runs (or resumes) one planned trial until it reaches a non-`infra_failed` terminal state, or the
        attempt cap (`MAX_ATTEMPTS`) is spent. `admission_calls` is this trial's own modeled call list (or,
        for an interactive trial, its block's -- the caller decides the unit); checked only while the
        current attempt is still `planned`."""
        while True:
            attempt = self._current_attempt(attempts)
            if attempt is None:
                return
            trial_id, attempt_no = attempt["trial_id"], int(attempt["attempt"])
            if attempt["execution_state"] == "infra_failed":
                if attempt_no >= MAX_ATTEMPTS:
                    return  # the attempt cap is spent; this planned trial stays infra_failed (EF-*)
                trial_id = await self.db.retry_trial(planned_trial_id)
                attempt = {
                    "trial_id": trial_id,
                    "attempt": attempt_no + 1,
                    "status": "planned",
                    "execution_state": None,
                }
            if attempt["status"] == "planned" and not await self._admit(admission_calls, str(planned_trial_id)):
                self._count("budget_skipped")
                await self.orchestrator.stop(trial_id, "budget_skipped", "ops.admit_unit: not enough budget free")
                return
            started = await self.db.start_trial(trial_id)
            if started.get("state") == "source_unavailable":  # derived by start_trial itself, no caller input
                self._count("source_unavailable")
                return
            try:
                outcome = await step(trial_id)
            except MissingPacketError:
                raise
            except Exception as exc:
                log.exception("planned trial %s: unexpected failure", planned_trial_id)
                await self.orchestrator.stop(trial_id, "infra_failed", f"unexpected: {exc}")
                outcome = Execution.INFRA_FAILED
            self._count(outcome)
            if outcome is not Execution.INFRA_FAILED:
                return
            attempt["execution_state"] = "infra_failed"
            attempts.append(attempt)

    async def _packet(self, trial: UUID) -> Mapping[str, Any]:
        """The running trial's public packet (opening question, requestable records, replay topics), read once
        the trial is `running` through `arena.harness_trial_state` (WP-28): the dev library's packet, or the
        sealed hidden one, which no projection shows before reveal."""
        packet = (await self.db.harness_trial_state(trial)).public_packet
        if packet is None:
            msg = f"trial {trial}'s variant has no public packet"
            raise MissingPacketError(msg)
        return packet

    async def _require_gate(self, tournament: UUID) -> None:
        """A hidden tournament runs only if every IG item's latest check before it opened passed, all on one
        commit (S1 L9, S3 9); a dev tournament has no hidden corpus to scan and opens ungated."""
        if await self.db.tournament_split(tournament) != "hidden":
            return
        latest = {name: (passed, sha) for name, passed, sha in await self.db.gate_rows_before_open(tournament)}
        needed = [latest.get(IG_CHECK_NAMES[item]) for item in IG_ITEMS]
        commits = {row[1] for row in needed if row is not None}
        if any(row is None or not row[0] for row in needed) or len(commits) != 1 or None in commits:
            msg = f"hidden tournament {tournament} did not pass the isolation gate before it opened; not run"
            raise IsolationGateNotPassedError(msg)

    # ------------------------------------------------------------------ corpus track (S2 8.6; BKO-6)

    async def _run_corpus_track(self, planned: Sequence[Row], attempts_by_planned: dict[UUID, list[Attempt]]) -> None:
        for row in planned:
            attempts = attempts_by_planned[row["planned_trial_id"]]
            subject = self.manifests[row["subject_candidate_id"]]

            async def step(trial_id: UUID) -> Execution:
                outcome = await _run_corpus_trial(trial_id, self.orchestrator, await self._packet(trial_id))
                if outcome is Execution.COMPLETED:
                    # S2 8.6: no assistant, so `run_corpus` never calls a `.final()`-style port method; the
                    # trial still needs its own close (S4 `finalize_trial`'s finding is null for a corpus
                    # transcript) before the referee can label and adjudicate it.
                    await self.orchestrator.finalize_corpus(trial_id)
                    await self.referee.score_trial(trial_id)
                return outcome

            await self._run_until_terminal(
                row["planned_trial_id"], attempts, admission.corpus_trial_calls(subject), step
            )

    # ------------------------------------------------------------------ replay track (S5 5.3; D2)

    async def _run_replay_track(self, planned: Sequence[Row], attempts_by_planned: dict[UUID, list[Attempt]]) -> None:
        for row in planned:
            attempts = attempts_by_planned[row["planned_trial_id"]]
            assistant = self.manifests[row["assistant_candidate_id"]]

            async def step(trial_id: UUID) -> Execution:
                outcome = await ReplayScorer(self.db, self.orchestrator).run(trial_id)
                if outcome in NEEDS_REVIEW:
                    await self.referee.score_trial(trial_id)
                return outcome

            await self._run_until_terminal(
                row["planned_trial_id"], attempts, admission.replay_trial_calls(assistant), step
            )

    # ------------------------------------------------------------------ interactive track (S2 8; direction 7.2)

    async def _run_interactive_track(
        self, tournament: UUID, planned: Sequence[Row], attempts_by_planned: dict[UUID, list[Attempt]]
    ) -> None:
        for block_no, rows in group_interactive_by_block(planned):
            for row in rows:
                attempts = attempts_by_planned[row["planned_trial_id"]]
                # This one pairing's own calls (S4 8.5's "the unit" admitted is one trial, never the whole
                # block): checking the block's full ~18-trial cost before each trial -- a real bug, Codex
                # round 1 -- made a later pairing come back budget_skipped even with plenty left for it
                # alone, since the same, un-shrinking block-wide figure was re-asked of the ceiling trial
                # after trial.
                trial_calls = admission.interactive_trial_calls(
                    self.manifests[row["assistant_candidate_id"]], self.manifests[row["subject_candidate_id"]]
                )

                async def step(trial_id: UUID) -> Execution:
                    packet = await self._packet(trial_id)
                    return await _run_interactive_trial(trial_id, self.orchestrator, packet["opening_question"])

                await self._run_until_terminal(row["planned_trial_id"], attempts, trial_calls, step)
            await self.referee.score_block(tournament, block_no)

    # ------------------------------------------------------------------ the whole run

    async def run_replay_track_prerequisite(self, tournament: UUID) -> None:
        """BKO-2's first phase alone: every corpus transcript, scored and sealed, then every replay trial.
        A separate method (not just `run`'s first half inlined) because it is a meaningful phase boundary on
        its own -- interactive trials refuse to start before it (S4 `arena.start_trial`) -- and because
        resuming a killed job after this phase finished is exactly "run the rest" (`run` itself calls this
        first, so a fresh `run` after a crash here just repeats the now-idempotent replay phase and moves
        on). A dev and a hidden tournament run the same way (WP-28): every read the harness makes of a trial
        while it runs goes through `arena.harness_trial_state`, and a hidden tournament reaches `running` only
        through the referee's isolation gate (S3 9; `arena_referee.isolation.open_hidden_tournament`), which
        `_require_gate` checks again here."""
        await self._require_gate(tournament)
        planned = await self.db.planned_trials(tournament)
        corpus = [r for r in planned if r["track"] == "replay_corpus"]
        replay = [r for r in planned if r["track"] == "replay"]
        attempts_by_planned = await self.db.planned_trial_attempts(tournament)
        await self._run_corpus_track(corpus, attempts_by_planned)
        if corpus:
            await self.referee.corpus_seal(tournament)
        # Re-read: `start_trial`'s own `source_unavailable` check (replay rows) and the seal both depend on
        # state the corpus track just wrote.
        attempts_by_planned = await self.db.planned_trial_attempts(tournament)
        await self._run_replay_track(replay, attempts_by_planned)

    async def run(self, tournament: UUID) -> RunSummary:
        await self.run_replay_track_prerequisite(tournament)
        planned = await self.db.planned_trials(tournament)
        attempts_by_planned = await self.db.planned_trial_attempts(tournament)
        await self._run_interactive_track(tournament, planned, attempts_by_planned)
        await self.referee.close(tournament)
        return RunSummary(tournament, dict(self.outcomes), True)
