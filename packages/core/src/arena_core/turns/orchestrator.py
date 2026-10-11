"""The interactive turn, standalone evidence requests and the investigator's finding (S5 5.1, 5.2, 5.4; D3).

One POST runs every step of a turn inside the request ("no work outlives a request"): `submit_question`, the
turn's release (always, so scheduled records apply), the subject's answer through `arena-subject`, the coach
card, and A1's deep update on its own work item bound to the card's version. Each step opens its work item with
the step's request key, `sha256(f"{trial}:{turn_no}:{kind}:{purpose}")`; a repeated key returns the finished
item and its stored result, so a retried POST with the same `idem_key` resumes at the first unfinished step and
never repeats a finished one.

Inside this process every request on a trial runs under that trial's lock (S5 5.1, SG3-25, D-016: one
`arena-api` process), so a duplicate POST waits for the first and then finds its stored results; a step is
never run by two live requests. Every model call carries the investigator's user id as its actor, so the
per-user daily cap applies (D-017, D-024).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from arena_core.agents.coach_prompts import build_coach_prompt
from arena_core.agents.manifests import CandidateManifest, load_prompts
from arena_core.agents.views import CoachCall
from arena_core.contracts.coaching import CoachingCard, DeepUpdate
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.providers.errors import BudgetRefusedError, ProviderError, StructuredOutputError
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, CallContext, Message
from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel
from arena_core.turns.coach import CardMeta, CoachInputs, coach_inputs, deep_due, store_card, store_deep

log = logging.getLogger("arena_core.turns")
TURN_DEADLINE_S = 60.0  # S5 5.2: the app-level deadline of one turn request


def request_key(trial: UUID, turn_no: int, kind: str, purpose: str) -> str:
    """S5 5.1: the step's request key."""
    return hashlib.sha256(f"{trial}:{turn_no}:{kind}:{purpose}".encode()).hexdigest()


class TurnRefusedError(Exception):
    """A request the trial's state refuses; `status` and `code` are the HTTP answer."""

    def __init__(self, status: int, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.status = status
        self.code = code


class SubjectUnavailableError(Exception):
    """`arena-subject` could not answer; `code` is its reason (`budget_refused`, `kill_switch_on`, ...)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SubjectOutcome:
    outcome: str  # recorded | quarantined
    turn_no: int


# (trial, work item, actor) -> the subject's recorded outcome (S5 5.5 `/internal/answer`)
SubjectCall = Callable[[UUID, UUID, UUID | None], Awaitable[SubjectOutcome]]

# S4 refusals a route can act on, by SQLSTATE.
REFUSALS: dict[str, tuple[int, str]] = {
    "AR001": (409, "trial_not_running"),
    "AR002": (409, "stale_version"),
    "AR003": (409, "idempotency_conflict"),
    "AR004": (409, "turn_in_progress"),
    "AR005": (422, "unknown_record"),
    "AR006": (422, "release_limit"),
    "AR007": (422, "invalid_request"),
    "AR040": (404, "not_found"),
}


def refusal(exc: ArenaError) -> TurnRefusedError:
    status, code = REFUSALS.get(exc.code, (500, "database_error"))
    return TurnRefusedError(status, code, exc.message)


@dataclass(frozen=True)
class _Step:
    """One coach step: the call, its trial and turn, its work item, the version it is bound to, its key."""

    call: CoachCall
    trial: UUID
    n: int
    work_item: UUID
    version: int
    key: str


@dataclass
class TrialSignals:
    """Per-trial locks and in-process wake-ups for the trial streams (S5 5.1, 6.4)."""

    _events: dict[UUID, asyncio.Event] = field(default_factory=dict)
    _locks: dict[UUID, asyncio.Lock] = field(default_factory=dict)

    def notify(self, trial: UUID) -> None:
        event = self._events.pop(trial, None)
        if event is not None:
            event.set()

    async def wait(self, trial: UUID, timeout_s: float) -> None:
        """Until the next `notify` of this trial, or `timeout_s` (the stream's 1 s re-poll)."""
        event = self._events.setdefault(trial, asyncio.Event())
        try:
            await asyncio.wait_for(event.wait(), timeout_s)
        except TimeoutError:  # silent-ok: the re-poll interval passing is the normal path, not a failure
            # Drop it, so no event outlives its waiters; a concurrent waiter on the same event still re-polls.
            if self._events.get(trial) is event:
                del self._events[trial]

    def lock(self, trial: UUID) -> asyncio.Lock:
        return self._locks.setdefault(trial, asyncio.Lock())


@dataclass(frozen=True)
class Orchestrator:
    db: ArenaDb
    port: AgentPort
    subject: SubjectCall
    signals: TrialSignals
    clock: Callable[[], float] = time.monotonic
    deadline_s: float = TURN_DEADLINE_S

    async def _open(self, trial: UUID, kind: str, key: str, expected_version: int | None = None) -> dict[str, Any]:
        return await self.db.open_work_item(trial, kind, key, expected_version)

    async def _fail(self, trial: UUID, state: str, reason: str) -> None:
        item = await self._open(trial, "failure", request_key(trial, 0, "failure", state))
        if item["status"] != "done":
            await self.db.record_execution_failure(trial, UUID(item["work_item_id"]), state, reason)
        self.signals.notify(trial)

    # ------------------------------------------------------------------ one turn (S5 5.2)

    async def run_turn(
        self, trial: UUID, question: str, release_ids: list[str], expected_version: int, idem_key: str
    ) -> dict[str, Any]:
        try:
            async with asyncio.timeout(self.deadline_s), self.signals.lock(trial):
                return await self._turn(trial, question, release_ids, expected_version, idem_key)
        except ArenaError as exc:
            raise refusal(exc) from exc
        except TimeoutError as exc:
            # S5 5.2: the request's 60 s deadline. Every finished step is stored; a retry with the same idem_key
            # resumes at the first unfinished one (an interrupted model call is recovered by its step key).
            log.warning("turn on %s passed its %ss deadline", trial, self.deadline_s)
            raise TurnRefusedError(504, "turn_deadline") from exc

    async def _turn(
        self, trial: UUID, question: str, release_ids: list[str], expected_version: int, idem_key: str
    ) -> dict[str, Any]:
        await self._check_requestable(trial, release_ids)
        asked = await self.db.submit_question(trial, expected_version, question, idem_key)
        n = int(asked["turn_no"])
        self.signals.notify(trial)
        item = await self._open(trial, "release", request_key(trial, n, "release", "turn"))
        # Always called, also for a finished item: S4 returns the stored result for the same input and refuses a
        # different one (AR003), so a reused key never silently answers for another request.
        await self.db.release_evidence(trial, UUID(item["work_item_id"]), release_ids)
        self.signals.notify(trial)
        answered = await self._answer(trial, n)
        if answered.outcome == "recorded":
            card_version = await self._coach(trial, n, "card", None)
            if card_version is not None:
                await self._deep(trial, n, card_version)
        return {"turn_no": n, "outcome": answered.outcome}

    async def _check_requestable(self, trial: UUID, release_ids: list[str]) -> None:
        """An id off the case's requestable list is refused before the question is recorded (S5 5.4's AR005
        contract), so a bad request never leaves an open, unanswerable question behind."""
        if not release_ids:
            return
        meta = await self.db.trial(trial)
        packet = None if meta is None else await self.db.public_packet(meta["variant_id"])
        requestable = {r["record_id"] for r in (packet or {}).get("requestable_records", [])}
        if not set(release_ids) <= requestable:
            raise TurnRefusedError(422, "unknown_record", "a requested id is not on the case's requestable list")

    async def _answer(self, trial: UUID, n: int) -> SubjectOutcome:
        item = await self._open(trial, "subject_answer", request_key(trial, n, "subject_answer", "subject.answer"))
        if item["status"] == "done":
            return SubjectOutcome(str(item["result"]["outcome"]), n)
        try:
            return await self.subject(trial, UUID(item["work_item_id"]), self.db.actor)
        except SubjectUnavailableError as exc:
            log.warning("subject for turn %s unavailable: %s", n, exc.code)
            if exc.code == "budget_refused":
                await self._fail(trial, "budget_truncated", "the subject call was refused by the spend guard")
                return SubjectOutcome("budget", n)
            code = "paused" if exc.code == "kill_switch_on" else "subject_unavailable"
            raise TurnRefusedError(503, code) from exc
        finally:
            self.signals.notify(trial)

    # ------------------------------------------------------------------ coaching (S5 5.2; S2 4)

    async def _manifest(self, trial: UUID) -> tuple[CandidateManifest, str]:
        meta = await self.db.trial(trial)
        found = None if meta is None else await self.db.manifest(meta["assistant_candidate_id"])
        if found is None:
            msg = "the trial's coach manifest is not readable"
            raise TurnRefusedError(500, "no_manifest", msg)
        return CandidateManifest.model_validate(found["manifest"]), str(found["sha256"])

    def _call[T: BaseModel](
        self, schema: type[T], call: CoachCall, inputs: CoachInputs, manifest: CandidateManifest, ctx: CallContext
    ) -> AgentCall[T]:
        prompt = build_coach_prompt(inputs.view, load_prompts(manifest), call)
        limit = manifest.limits[call]
        return AgentCall(
            model=VertexModel(limit.model_id),
            thinking=ThinkingLevel(limit.thinking_level.lower()),
            system=prompt.system_instruction,
            messages=(Message("user", prompt.user_message),),
            schema=schema,
            context=ctx,
            timeout_s=limit.attempt_timeout_ms / 1000,
            deadline_s=limit.deadline_ms / 1000,
            validation_context=inputs.citations,
            salt=prompt.salt,
        )

    def _context(self, step: _Step) -> CallContext:
        return CallContext(
            call_type=CallType.CARD if step.call == "card" else CallType.DEEP,
            purpose=f"coach.{step.call}",
            step_key=step.key,
            work_item_id=step.work_item,
            trial_id=step.trial,
            actor_user_id=self.db.actor,
            turn_no=step.n,
            split="dev",
            data_class="public",
            # No candidate_manifest_sha: the roster check (AST-5) binds tournament calls; a training session's coach
            # is the configured candidate, and its hash is stored on every card instead.
            # Under the trial lock in the one api process, an open reservation under this step can only be a
            # request that died (S5 4.10).
            recover=True,
        )

    async def _model(self, step: _Step) -> tuple[dict[str, Any], str]:
        """One coach call and its stored payload (S2 4.1, 4.6)."""
        manifest, sha = await self._manifest(step.trial)
        inputs = coach_inputs(await self.db.trial_context(step.trial, step.work_item), step.call, step.n)
        ctx = self._context(step)
        started = self.clock()
        if step.call == "card":
            card = await self.port.run(self._call(CoachingCard, step.call, inputs, manifest, ctx))
            latency = int((self.clock() - started) * 1000)
            stored = store_card(card.value, inputs, CardMeta(latency, step.work_item, step.version, sha))
            return stored.model_dump(mode="json"), "coach_card"
        deep = await self.port.run(self._call(DeepUpdate, step.call, inputs, manifest, ctx))
        return store_deep(deep.value, inputs).model_dump(mode="json"), "coach_deep"

    async def _coach(self, trial: UUID, n: int, call: CoachCall, expected_version: int | None) -> int | None:
        """The card (or deep update) of turn n. Returns the version the step was bound to once its event is
        stored, None when it was not (a failure event, a discarded stale update, or a terminal failure)."""
        key = request_key(trial, n, "coaching", f"coach.{call}")
        try:
            item = await self._open(trial, "coaching", key, expected_version)
        except ArenaError as exc:
            if exc.code == "AR002":  # overtaken by a question or a release: the update is discarded
                log.info("coach %s for turn %s overtaken: %s", call, n, exc.message)
                return None
            raise
        version = int(item["transcript_version"])
        if item["status"] == "done":  # a retry: answer as the first run did (a coach_unavailable step bound nothing)
            seq = int(item["result"]["seq"])
            stored = await self.db.trial_events(trial, seq - 1, 1)
            return version if stored and stored[0].kind != "coach_unavailable" else None
        work_item = UUID(item["work_item_id"])
        try:
            payload, kind = await self._model(_Step(call, trial, n, work_item, version, key))
        except BudgetRefusedError as exc:
            log.warning("coach %s for turn %s refused by the spend guard: %s", call, n, exc)
            await self._fail(trial, "budget_truncated", f"the coach {call} call was refused by the spend guard")
            return None
        except ProviderError as exc:
            log.warning("coach %s for turn %s failed: %s: %s", call, n, type(exc).__name__, exc)
            if call == "card":  # S5 5.2: a KPI-4 miss; the practice trial continues
                reason = "repair_failed" if isinstance(exc, StructuredOutputError) else "timeout"
                failed = {"turn_no": n, "reason": reason}
                await self.db.record_coaching_event(trial, work_item, failed, "coach_unavailable")
                self.signals.notify(trial)
            return None
        try:
            await self.db.record_coaching_event(trial, work_item, payload, kind)
        except ArenaError as exc:
            if exc.code == "AR002":  # stale: the output read an older version; discarded, never streamed
                log.info("coach %s for turn %s stale: %s", call, n, exc.message)
                return None
            raise
        self.signals.notify(trial)
        return version

    async def _deep(self, trial: UUID, n: int, card_version: int) -> None:
        """A1's deep update: every third exchange, and on each release, i.e. when a record first became visible to
        this turn's coaching (released after exchange n - 1, at this question or between the turns; S2 4.4.1)."""
        manifest, _ = await self._manifest(trial)
        released = any(r["released_after_exchanges"] == n - 1 for r in await self.db.released(trial))
        if deep_due(manifest.model_dump(mode="json"), n, released):
            await self._coach(trial, n, "deep", card_version)

    # ------------------------------------------------------------------ between turns (S5 5.4)

    async def request_evidence(self, trial: UUID, record_ids: list[str], idem_key: str) -> dict[str, Any]:
        async with self.signals.lock(trial):
            if await self.db.open_question(trial):  # S5 5.4: between turns only; the open turn's retry owns it
                raise TurnRefusedError(409, "turn_in_progress", "the last question is not answered yet")
            try:
                key = request_key(trial, 0, "release", f"evidence:{idem_key}")
                result = await self.db.release_between_turns(trial, key, record_ids)
            except ArenaError as exc:
                raise refusal(exc) from exc
            self.signals.notify(trial)
            return result

    async def commit_finding(self, trial: UUID, finding: dict[str, Any], idem_key: str) -> dict[str, Any]:
        async with self.signals.lock(trial):
            try:
                key = request_key(trial, 0, "finalize", f"investigator:{idem_key}")
                item = await self._open(trial, "finalize", key)
                # Called for a finished item too: S4 answers the stored result only for the same finding (AR003 else).
                result = await self.db.finalize_trial(trial, UUID(item["work_item_id"]), finding)
            except ArenaError as exc:
                raise refusal(exc) from exc
            self.signals.notify(trial)
            return result
