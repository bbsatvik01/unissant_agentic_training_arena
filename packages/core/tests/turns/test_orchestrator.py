"""The interactive turn (S5 5.1, 5.2, 5.4, 5.6) against an in-memory S4 (`fakedb`) and the real agent port on the
fake adapter with the in-memory guard: step order, request-key resumption, the version binding of the deep
update, failure paths, refusals, and the actor on every model call (D-024)."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Coroutine
from decimal import Decimal
from http import HTTPStatus
from typing import Any
from uuid import UUID, uuid4

import pytest

from arena_core.db.arena import ArenaError
from arena_core.db.calls import ModelCallRequest
from arena_core.providers.errors import BudgetRefusedError, ErrorKind, ProviderCallError
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import Reservation
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import (
    Orchestrator,
    SubjectOutcome,
    SubjectUnavailableError,
    TrialSignals,
    TurnRefusedError,
    request_key,
)

from .fakedb import COACH, FakeArenaDb

ACTOR = UUID("00000000-0000-0000-0000-00000000000a")


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _no_sleep(_s: float) -> None:
    return None


class Rig:
    def __init__(
        self,
        *,
        script: list[Any] | None = None,
        budget: Decimal = Decimal(100),
        mode: str = "practice",
        guard: RunBudget | None = None,
    ) -> None:
        self.db = FakeArenaDb(ACTOR, mode=mode)
        self.adapter = FakeAdapter(script=list(script or []), canned=FAKE_COACH_REPLIES)
        self.budget = guard if guard is not None else RunBudget(budget)
        self.port = AgentPort(self.adapter, self.budget, PortOptions(sleep=_no_sleep))
        self.subject_calls: list[tuple[UUID, UUID, UUID | None]] = []
        self.subject_error: SubjectUnavailableError | None = None
        self.quarantine = False
        self.orch = Orchestrator(db=self.db, port=self.port, subject=self.subject, signals=TrialSignals())

    async def subject(self, trial: UUID, work_item: UUID, actor: UUID | None) -> SubjectOutcome:
        self.subject_calls.append((trial, work_item, actor))
        if self.subject_error is not None:
            raise self.subject_error
        return self.db.quarantine(work_item) if self.quarantine else self.db.record_answer(work_item)

    def turn(self, question: str = "What did you do in B-12?", key: str | None = None) -> dict[str, Any]:
        return run(self.orch.run_turn(self.db.trial_id, question, [], self.db.version, key or str(uuid4())))

    def kinds(self) -> list[str]:
        return [e.kind for e in self.db.events]


def test_one_turn_runs_question_release_answer_and_card_in_order() -> None:
    rig = Rig()
    assert rig.turn() == {"turn_no": 1, "outcome": "recorded"}
    assert rig.kinds() == ["question_recorded", "subject_turn", "coach_card"]
    order = [c for c in rig.db.calls if c.startswith(("submit", "open", "release", "record", "trial_context"))]
    assert order == [
        "submit_question",
        "open:release",
        "release_evidence",
        "open:subject_answer",
        "open:coaching",
        "trial_context",
        "record:coach_card",
    ]
    card = rig.db.events[-1].payload
    assert (card["turn_id"], card["card_seq"], card["transcript_version"]) == ("t01", 1, 2)
    assert card["candidate_sha256"] == COACH.sha256


def test_every_model_call_carries_the_investigator_as_actor() -> None:
    """D-024: the per-user daily cap applies to coach calls; the subject call gets the actor too."""
    rig = Rig()
    rig.turn()
    assert rig.subject_calls[0][2] == ACTOR
    assert rig.budget.reservations
    assert all(ACTOR in r.identity for r in rig.budget.reservations.values())


def test_deep_update_runs_every_third_exchange_after_the_card() -> None:
    rig = Rig()
    for _ in range(3):
        rig.turn()
    assert rig.kinds()[-2:] == ["coach_card", "coach_deep"]
    assert rig.kinds().count("coach_deep") == 1
    deep = rig.db.events[-1]
    assert deep.payload["as_of_turn"] == "t03"
    assert deep.transcript_version == rig.db.events[-2].transcript_version


def test_a_release_on_the_turn_triggers_the_deep_update() -> None:
    rig = Rig()
    for _ in range(5):
        rig.turn()
    # rec-05 is scheduled after 5 exchanges: the sixth question's release applies it
    rig.turn()
    kinds = rig.kinds()
    assert "evidence_released" in kinds
    assert kinds[-1] == "coach_deep"
    assert rig.db.events[-1].payload["evidence_coverage"][0]["record_id"] == "rec-05"


def test_retry_with_the_same_key_resumes_without_repeating_a_finished_step() -> None:
    """S5 5.6: a replay of the same POST produces one question, one answer, one card."""
    rig = Rig()
    key = str(uuid4())
    first = rig.turn(key=key)
    requests = len(rig.adapter.requests)
    again = run(rig.orch.run_turn(rig.db.trial_id, "What did you do in B-12?", [], 0, key))
    assert again == first
    assert rig.kinds() == ["question_recorded", "subject_turn", "coach_card"]
    assert len(rig.subject_calls) == 1
    assert len(rig.adapter.requests) == requests


def test_a_crash_after_the_answer_resumes_at_the_card() -> None:
    rig = Rig()
    key = str(uuid4())
    rig.db.fail_next["open:coaching"] = ArenaError("XX000", "connection lost")
    with pytest.raises(TurnRefusedError) as exc_info:
        rig.turn(key=key)
    assert exc_info.value.status == HTTPStatus.INTERNAL_SERVER_ERROR
    assert rig.kinds() == ["question_recorded", "subject_turn"]
    rig.turn(key=key)
    assert rig.kinds() == ["question_recorded", "subject_turn", "coach_card"]
    assert len(rig.subject_calls) == 1


def test_a_stale_card_is_discarded_and_never_streamed() -> None:
    rig = Rig()
    rig.db.fail_next["record:coach_card"] = ArenaError("AR002", "stale")
    rig.turn()
    assert "coach_card" not in rig.kinds()


def test_a_deep_update_overtaken_by_the_next_question_is_discarded() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()
    rig.db.overtake_bound_steps = True
    rig.turn()
    assert rig.kinds()[-1] == "coach_card"
    assert "coach_deep" not in rig.kinds()


def test_an_invalid_card_after_the_repair_records_coach_unavailable_and_the_trial_continues() -> None:
    rig = Rig(script=["{}", "{}"])
    rig.turn()
    assert rig.kinds()[-1] == "coach_unavailable"
    assert rig.db.events[-1].payload == {"turn_no": 1, "reason": "repair_failed"}
    assert rig.turn()["turn_no"] == 1 + 1


def test_a_provider_failure_on_the_card_is_a_timeout() -> None:
    failure = ProviderCallError(ErrorKind.TRANSIENT, "boom")
    rig = Rig(script=[failure] * 4)
    rig.turn()
    assert rig.db.events[-1].payload["reason"] == "timeout"


def test_a_budget_refusal_of_the_subject_truncates_the_trial() -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("budget_refused")
    assert rig.turn()["outcome"] == "budget"
    assert (rig.db.status, rig.db.execution_state) == ("terminated", "budget_truncated")
    assert rig.db.events[-1].payload == {"reason": "budget"}


@pytest.mark.parametrize(
    ("code", "expected"), [("kill_switch_on", "paused"), ("provider_failed", "subject_unavailable")]
)
def test_other_subject_failures_leave_the_turn_open_for_a_retry(code: str, expected: str) -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError(code)
    key = str(uuid4())
    with pytest.raises(TurnRefusedError) as exc_info:
        rig.turn(key=key)
    assert (exc_info.value.status, exc_info.value.code) == (503, expected)
    rig.subject_error = None
    assert rig.turn(key=key)["outcome"] == "recorded"


def test_a_budget_refusal_of_the_card_truncates_the_trial() -> None:
    rig = Rig(budget=Decimal(0))
    rig.turn()
    assert rig.db.execution_state == "budget_truncated"


def test_a_quarantine_ends_the_turn_with_no_card() -> None:
    rig = Rig()
    rig.quarantine = True
    assert rig.turn()["outcome"] == "quarantined"
    assert rig.kinds() == ["question_recorded", "trial_ended"]
    with pytest.raises(TurnRefusedError) as exc_info:
        rig.turn()
    assert exc_info.value.code == "trial_not_running"


def test_a_stale_expected_version_is_409() -> None:
    rig = Rig()
    rig.turn()
    with pytest.raises(TurnRefusedError) as exc_info:
        run(rig.orch.run_turn(rig.db.trial_id, "Again?", [], 0, str(uuid4())))
    assert (exc_info.value.status, exc_info.value.code) == (409, "stale_version")


def test_two_concurrent_turns_one_succeeds_the_other_is_409() -> None:
    rig = Rig()

    async def both() -> list[object]:
        a = rig.orch.run_turn(rig.db.trial_id, "First?", [], 0, str(uuid4()))
        b = rig.orch.run_turn(rig.db.trial_id, "Second?", [], 0, str(uuid4()))
        results: list[object] = list(await asyncio.gather(a, b, return_exceptions=True))
        return results

    results = run(both())
    assert sum(isinstance(r, dict) for r in results) == 1
    refused = [r for r in results if isinstance(r, TurnRefusedError)]
    assert len(refused) == 1
    assert refused[0].status == HTTPStatus.CONFLICT


def test_evidence_request_between_turns_and_its_retry() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()
    key = str(uuid4())
    result = run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01", "rec-04"], key))
    assert [r["record_id"] for r in result["released"]] == ["rec-01"]
    assert result["denied"] == ["rec-04"]
    assert run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01", "rec-04"], key)) == result
    assert rig.kinds().count("evidence_released") == 1


def test_evidence_request_for_an_unknown_id_is_422_and_during_an_open_turn_409() -> None:
    rig = Rig()
    rig.turn()
    with pytest.raises(TurnRefusedError) as unknown:
        run(rig.orch.request_evidence(rig.db.trial_id, ["rec-05"], str(uuid4())))
    assert (unknown.value.status, unknown.value.code) == (422, "unknown_record")
    rig.db.coaching_pending = True
    with pytest.raises(TurnRefusedError) as busy:
        run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01"], str(uuid4())))
    assert busy.value.status == HTTPStatus.CONFLICT


FINDING = {
    "label": "truthful",
    "likelihood": "unlikely",
    "confidence": "moderate",
    "basis_flag_refs": [],
    "cited_turns": [1],
    "cited_records": ["doc-01"],
    "corroboration_needed": [],
    "rationale": "The account matches the access report.",
    "alternative_explanations": None,
    "last_revised_turn": None,
}


def test_finding_commit_finalizes_once_and_a_retry_returns_the_stored_result() -> None:
    rig = Rig()
    rig.turn()
    key = str(uuid4())
    first = run(rig.orch.commit_finding(rig.db.trial_id, FINDING, key))
    assert first["commitment_sha256"] == "c" * 64
    assert run(rig.orch.commit_finding(rig.db.trial_id, FINDING, key)) == first
    assert rig.kinds()[-2:] == ["finding_committed", "trial_ended"]


def test_finding_with_a_bad_citation_is_422_and_writes_nothing() -> None:
    rig = Rig()
    rig.turn()
    with pytest.raises(TurnRefusedError) as exc_info:
        run(rig.orch.commit_finding(rig.db.trial_id, {**FINDING, "cited_records": ["doc-04"]}, str(uuid4())))
    assert exc_info.value.status == HTTPStatus.UNPROCESSABLE_ENTITY
    assert rig.db.finding is None


def test_unknown_database_errors_are_500() -> None:
    rig = Rig()
    rig.db.fail_next["submit_question"] = ArenaError("XX999", "odd")
    with pytest.raises(TurnRefusedError) as exc_info:
        rig.turn()
    assert (exc_info.value.status, exc_info.value.code) == (500, "database_error")


def test_a_missing_coach_manifest_is_500() -> None:
    rig = Rig()
    rig.db.manifest_missing = True
    with pytest.raises(TurnRefusedError) as exc_info:
        rig.turn()
    assert exc_info.value.code == "no_manifest"


def test_request_key_is_sha256_of_trial_turn_kind_purpose() -> None:
    trial = uuid4()
    assert (
        request_key(trial, 3, "coaching", "coach.deep")
        == hashlib.sha256(f"{trial}:3:coaching:coach.deep".encode()).hexdigest()
    )


def test_signals_wake_a_waiting_stream() -> None:
    signals = TrialSignals()
    trial = uuid4()

    async def scenario() -> float:
        loop = asyncio.get_running_loop()
        start = loop.time()
        waiter = asyncio.create_task(signals.wait(trial, 5.0))
        await asyncio.sleep(0)
        signals.notify(trial)
        await waiter
        await signals.wait(trial, 0.01)  # a timeout returns quietly
        return loop.time() - start

    assert run(scenario()) < 1.0


class DeepRefused(RunBudget):
    """The guard admits every call but A1's deep update (its reservation is refused, as at the cap)."""

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        if req.purpose == "coach.deep":
            raise BudgetRefusedError("cap")
        return await super().reserve(req)


def test_a_budget_refusal_of_the_deep_update_truncates_the_trial_after_its_card() -> None:
    rig = Rig(guard=DeepRefused(Decimal(100)))
    for _ in range(3):
        rig.turn()
    assert rig.kinds()[-2:] == ["coach_card", "trial_ended"]
    assert rig.db.execution_state == "budget_truncated"


def test_an_unrequestable_release_id_is_422_and_records_no_question() -> None:
    rig = Rig()
    with pytest.raises(TurnRefusedError) as exc_info:
        run(rig.orch.run_turn(rig.db.trial_id, "Why?", ["rec-05"], 0, str(uuid4())))
    assert (exc_info.value.status, exc_info.value.code) == (HTTPStatus.UNPROCESSABLE_ENTITY, "unknown_record")
    assert rig.db.turns == {}
    assert rig.turn()["turn_no"] == 1


def test_a_release_between_turns_triggers_the_next_deep_update() -> None:
    rig = Rig()
    for _ in range(3):
        rig.turn()
    run(rig.orch.request_evidence(rig.db.trial_id, ["rec-02"], str(uuid4())))
    rig.turn()
    deeps = [e.payload["as_of_turn"] for e in rig.db.events if e.kind == "coach_deep"]
    assert deeps == ["t03", "t04"]


def test_a_reused_key_with_a_different_body_is_refused() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()
    key = str(uuid4())
    run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01"], key))
    with pytest.raises(TurnRefusedError) as evidence:
        run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01", "rec-02"], key))
    assert evidence.value.code == "idempotency_conflict"
    finding_key = str(uuid4())
    run(rig.orch.commit_finding(rig.db.trial_id, FINDING, finding_key))
    with pytest.raises(TurnRefusedError) as finding:
        run(rig.orch.commit_finding(rig.db.trial_id, {**FINDING, "rationale": "Changed."}, finding_key))
    assert finding.value.code == "idempotency_conflict"


def test_an_evidence_request_while_a_question_is_unanswered_is_409_and_the_turn_retry_still_answers() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()
    rig.subject_error = SubjectUnavailableError("provider_failed")
    key = str(uuid4())
    with pytest.raises(TurnRefusedError):
        rig.turn(key=key)
    with pytest.raises(TurnRefusedError) as busy:
        run(rig.orch.request_evidence(rig.db.trial_id, ["rec-01"], str(uuid4())))
    assert (busy.value.status, busy.value.code) == (HTTPStatus.CONFLICT, "turn_in_progress")
    rig.subject_error = None
    assert run(rig.orch.run_turn(rig.db.trial_id, "What did you do in B-12?", [], 0, key))["outcome"] == "recorded"


def test_a_turn_past_its_deadline_is_504_and_its_retry_resumes() -> None:
    rig = Rig()

    async def stalled(_t: UUID, _w: UUID, _a: UUID | None) -> SubjectOutcome:
        await asyncio.sleep(1)
        raise AssertionError

    stuck = Orchestrator(db=rig.db, port=rig.port, subject=stalled, signals=rig.orch.signals, deadline_s=0.05)
    key = str(uuid4())
    with pytest.raises(TurnRefusedError) as exc_info:
        run(stuck.run_turn(rig.db.trial_id, "Why?", [], 0, key))
    assert (exc_info.value.status, exc_info.value.code) == (HTTPStatus.GATEWAY_TIMEOUT, "turn_deadline")
    assert run(rig.orch.run_turn(rig.db.trial_id, "Why?", [], 0, key))["outcome"] == "recorded"
    assert rig.kinds().count("question_recorded") == 1
