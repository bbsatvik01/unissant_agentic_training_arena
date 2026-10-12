"""`make real-smoke` (S5 3, 4, 5.1, 5.2): the offline parts of `scripts/probes/real_smoke.py` -- variant and
candidate lookup against a fake `ArenaDb`, and `RecordingPort` capturing model, usage, cost and latency from a
fake adapter and an in-memory guard, no database and no model call. `main`'s argv and env handling is proven by
monkeypatching `run_smoke` out; the real path, against a migrated database in `ARENA_MODEL_MODE=fake`, runs in
db-test (`packages/core/tests/db/it_real_smoke.py`)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Coroutine, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any, NoReturn, cast
from uuid import UUID, uuid4

import pytest
from pydantic import BaseModel, Field

from arena_core.contracts.subject import SubjectTurn
from arena_core.db.arena import ArenaError, SessionStart
from arena_core.db.pool import Connector
from arena_core.identity import DevIdentity
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.types import AgentCall, CallContext, Message
from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel
from arena_core.spend.memory import RunBudget
from arena_core.turns.orchestrator import SubjectCall, SubjectOutcome, SubjectUnavailableError, TurnRefusedError
from arena_subject.answer import AnswerError, AnswerOutcome, AnswerStep
from packages.core.tests.turns.fakedb import FakeArenaDb
from scripts.probes import real_smoke


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _no_sleep(_s: float) -> None:
    return None


def _unused_connect() -> Connector:
    """A `Connector` that is never called: `answer` is faked out in these tests, so `real_subject_call`'s own
    `get_context`/`record` closures (which would call it) never run."""

    def boom() -> NoReturn:
        msg = "not called in this test"
        raise AssertionError(msg)

    return cast("Connector", boom)


def _unused_port() -> AgentPort:
    """An `AgentPort` that is never called, for the same reason."""
    return cast("AgentPort", object())


class Reply(BaseModel):
    note: str = Field(max_length=40)


def test_dev_variant_finds_the_named_family() -> None:
    db = FakeArenaDb()
    assert run(real_smoke.dev_variant(db, "F01")) == db.variant_id


def test_dev_variant_refuses_an_unregistered_family() -> None:
    with pytest.raises(real_smoke.SmokeError, match="F99"):
        run(real_smoke.dev_variant(FakeArenaDb(), "F99"))


def test_registered_candidate_finds_the_named_candidate() -> None:
    db = FakeArenaDb()
    assert run(real_smoke.registered_candidate(db, "assistant", "A1")) == db.coach_id


def test_registered_candidate_refuses_an_unregistered_name() -> None:
    with pytest.raises(real_smoke.SmokeError, match="A9"):
        run(real_smoke.registered_candidate(FakeArenaDb(), "assistant", "A9"))


def test_real_subject_call_returns_the_answer_outcome_as_a_subject_outcome(monkeypatch: pytest.MonkeyPatch) -> None:
    """The wrapper's own logic (never `arena_subject.answer.answer` or `arena_core.db.subject` themselves,
    which need a real connection): a clean `AnswerOutcome` becomes exactly the matching `SubjectOutcome`."""
    trial, work_item, actor = uuid4(), uuid4(), uuid4()
    seen: dict[str, Any] = {}

    async def fake_answer(step: AnswerStep, *, get_context: object, record: object, port: object) -> AnswerOutcome:
        seen.update(step=step, get_context=get_context, record=record, port=port)
        return AnswerOutcome("recorded", 1, 2)

    monkeypatch.setattr(real_smoke, "answer", fake_answer)
    call = real_smoke.real_subject_call(_unused_connect(), _unused_port(), actor)
    outcome: SubjectOutcome = run(cast("Coroutine[Any, Any, SubjectOutcome]", call(trial, work_item, None)))
    assert outcome == SubjectOutcome("recorded", 1)
    assert (seen["step"].trial_id, seen["step"].work_item_id, seen["step"].actor) == (trial, work_item, actor)


def test_real_subject_call_prefers_the_steps_own_actor_over_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    trial, work_item = uuid4(), uuid4()
    default_actor, step_actor = uuid4(), uuid4()
    seen: dict[str, Any] = {}

    async def fake_answer(step: AnswerStep, **_kwargs: object) -> AnswerOutcome:
        seen["actor"] = step.actor
        return AnswerOutcome("recorded", 1, None)

    monkeypatch.setattr(real_smoke, "answer", fake_answer)
    call = real_smoke.real_subject_call(_unused_connect(), _unused_port(), default_actor)
    run(cast("Coroutine[Any, Any, SubjectOutcome]", call(trial, work_item, step_actor)))
    assert seen["actor"] == step_actor


def test_real_subject_call_wraps_an_answer_error_as_subject_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_a: object, **_k: object) -> AnswerOutcome:
        raise AnswerError("budget_refused", 503, "no budget")

    monkeypatch.setattr(real_smoke, "answer", boom)
    call = real_smoke.real_subject_call(_unused_connect(), _unused_port(), uuid4())
    with pytest.raises(SubjectUnavailableError) as caught:
        run(cast("Coroutine[Any, Any, SubjectOutcome]", call(uuid4(), uuid4(), None)))
    assert caught.value.code == "budget_refused"


def test_run_smoke_never_embeds_an_arena_errors_free_text_in_the_smoke_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`ArenaError.message` falls back to the raw psycopg message when a connection error never reached the
    server (a malformed DSN, S4 2.3's `_arena_error`) -- password included. `run_smoke` wraps a refused
    `start_session` into a `SmokeError`; this proves that wrap carries only the safe SQLSTATE (`exc.code`),
    never `exc.message`, even when the database layer hands it an unsafe one."""
    unsafe = "connection failed: password=s3cr3t-in-the-clear"
    actor = UUID(int=7)

    class _RefusingDb(FakeArenaDb):
        async def start_session(self, _start: SessionStart) -> dict[str, Any]:
            raise ArenaError("AR040", unsafe)

    refusing = _RefusingDb(actor)

    monkeypatch.setattr(real_smoke, "resolve_dev_user", lambda _env: DevIdentity(actor, "x@test", "X", frozenset()))
    monkeypatch.setattr(real_smoke, "dsn_connector", lambda _dsn: lambda: None)
    monkeypatch.setattr(real_smoke, "ArenaDb", lambda _connect, _actor: refusing)

    env = {"ARENA_MODEL_MODE": "fake", "ARENA_PUBLIC_DSN": "x", "ARENA_SUBJECT_DSN": "y"}
    with pytest.raises(real_smoke.SmokeError) as caught:
        run(real_smoke.run_smoke(env, family="F01", coach_name="A1", subject_name="S1", question="Why?"))
    assert "AR040" in str(caught.value)
    assert unsafe not in str(caught.value)
    assert "s3cr3t-in-the-clear" not in str(caught.value)


def test_run_smoke_never_embeds_a_turn_refused_errors_free_text_in_the_smoke_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`Orchestrator.run_turn` wraps ANY `ArenaError` raised anywhere inside a turn (`submit_question`,
    `release_evidence`, `record_coaching_event`, ...) into a `TurnRefusedError` that carries the original
    `exc.message` forward verbatim (`orchestrator.py`'s own `refusal()`) -- the same unsafe free-text a
    malformed DSN can put in an `ArenaError.message`. Unlike `start_session`'s own `ArenaError`, this one is
    not caught by a bare `except ArenaError` anywhere in this script, so `run_turn`'s own call needs its own
    wrap. Proves a `submit_question` failure (reached well after `start_session` succeeds) is turned into a
    `SmokeError` carrying only the safe `.code`, never the unsafe message."""
    unsafe = "connection failed: password=s3cr3t-in-the-clear"
    actor = UUID(int=7)
    db = FakeArenaDb(actor)
    db.fail_next["submit_question"] = ArenaError("AR040", unsafe)

    monkeypatch.setattr(real_smoke, "resolve_dev_user", lambda _env: DevIdentity(actor, "x@test", "X", frozenset()))
    monkeypatch.setattr(real_smoke, "dsn_connector", lambda _dsn: lambda: None)
    monkeypatch.setattr(real_smoke, "ArenaDb", lambda _connect, _actor: db)
    monkeypatch.setattr(real_smoke, "DbSpendGuard", lambda _connect: RunBudget(Decimal(100)))

    env = {"ARENA_MODEL_MODE": "fake", "ARENA_PUBLIC_DSN": "x", "ARENA_SUBJECT_DSN": "y"}
    with pytest.raises(real_smoke.SmokeError) as caught:
        run(real_smoke.run_smoke(env, family="F01", coach_name="A1", subject_name="S1", question="Why?"))
    assert "run_turn refused" in str(caught.value)
    assert unsafe not in str(caught.value)
    assert "s3cr3t-in-the-clear" not in str(caught.value)


def test_run_smoke_builds_the_report_end_to_end_against_a_fake_db(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every line of `run_smoke` runs for real: variant and candidate lookup, `start_session`, both ports, one
    real `Orchestrator.run_turn` (a real coach card through a real `AgentPort` + `FakeAdapter` + in-memory
    `RunBudget`), with only the database layer (`ArenaDb`, `DbSpendGuard`) and the subject call faked -- the
    full database path is proven separately in db-test's `it_real_smoke.py`."""
    actor = UUID(int=7)
    db = FakeArenaDb(actor)

    def fake_arena_db(_connect: object, given_actor: UUID | None) -> FakeArenaDb:
        assert given_actor == actor
        return db

    def fake_guard(_connect: object) -> RunBudget:
        return RunBudget(Decimal(100))

    def fake_subject_call(_connect: object, port: AgentPort, _actor: UUID | None) -> SubjectCall:
        async def call(_trial: UUID, work_item: UUID, _step_actor: UUID | None) -> SubjectOutcome:
            # A real call through the real subject_port (its FakeAdapter is configured for SubjectTurn by
            # run_smoke itself), so subject_port.calls is non-empty exactly as a real answer() call would
            # leave it; FakeArenaDb's own transcript then needs a real recorded answer (not just a canned
            # outcome) for the coach step that follows to read a turn with a non-null answer.
            subject_call = AgentCall(
                model=VertexModel.FLASH_LITE_31,
                thinking=ThinkingLevel.MINIMAL,
                system="s",
                messages=(Message("user", "hello"),),
                schema=SubjectTurn,
                context=CallContext(
                    call_type=CallType.SUBJECT,
                    purpose="subject.answer",
                    step_key=str(work_item),
                    data_class="subject_private",
                ),
            )
            await port.run(subject_call)
            return db.record_answer(work_item)

        return call

    monkeypatch.setattr(real_smoke, "resolve_dev_user", lambda _env: DevIdentity(actor, "x@test", "X", frozenset()))
    monkeypatch.setattr(real_smoke, "dsn_connector", lambda _dsn: lambda: None)
    monkeypatch.setattr(real_smoke, "ArenaDb", fake_arena_db)
    monkeypatch.setattr(real_smoke, "DbSpendGuard", fake_guard)
    monkeypatch.setattr(real_smoke, "real_subject_call", fake_subject_call)

    env = {"ARENA_MODEL_MODE": "fake", "ARENA_PUBLIC_DSN": "x", "ARENA_SUBJECT_DSN": "y"}
    result = run(real_smoke.run_smoke(env, family="F01", coach_name="A1", subject_name="S1", question="Why?"))

    assert result["trial_id"] == str(db.trial_id)
    assert result["outcome"] == "recorded"
    assert result["turn_no"] == 1
    assert len(result["subject"]) == 1  # the real subject call, through the real port and FakeAdapter
    assert result["subject"][0]["purpose"] == "subject.answer"
    assert len(result["coach"]) == 1  # the real coach card, through the real port and FakeAdapter
    assert result["coach"][0]["purpose"] == "coach.card"
    assert result["coach"][0]["cost_usd"] == "0.000000"
    assert isinstance(result["elapsed_ms"], float)


def test_run_smoke_refuses_to_report_success_when_the_subject_call_never_happened(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`Orchestrator.run_turn` returns normally, with `outcome` other than `"recorded"` and no coach step run,
    for a budget-refused, kill-switch-paused or quarantined subject reply (`Orchestrator._answer`): a smoke
    test that called `run_turn` and got a clean return is not the same thing as one real subject call and one
    real coach card. `run_smoke` must refuse this as a failure, never report it as success."""
    actor = UUID(int=7)
    db = FakeArenaDb(actor)

    def fake_subject_call(_connect: object, _port: object, _actor: UUID | None) -> SubjectCall:
        async def call(_trial: UUID, _work_item: UUID, _step_actor: UUID | None) -> SubjectOutcome:
            raise SubjectUnavailableError("budget_refused")

        return call

    monkeypatch.setattr(real_smoke, "resolve_dev_user", lambda _env: DevIdentity(actor, "x@test", "X", frozenset()))
    monkeypatch.setattr(real_smoke, "dsn_connector", lambda _dsn: lambda: None)
    monkeypatch.setattr(real_smoke, "ArenaDb", lambda _connect, _actor: db)
    monkeypatch.setattr(real_smoke, "DbSpendGuard", lambda _connect: RunBudget(Decimal(100)))
    monkeypatch.setattr(real_smoke, "real_subject_call", fake_subject_call)

    env = {"ARENA_MODEL_MODE": "fake", "ARENA_PUBLIC_DSN": "x", "ARENA_SUBJECT_DSN": "y"}
    with pytest.raises(real_smoke.SmokeError, match="0 subject call"):
        run(real_smoke.run_smoke(env, family="F01", coach_name="A1", subject_name="S1", question="Why?"))


def test_run_smoke_refuses_to_report_success_when_the_coach_card_was_never_persisted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A coach call whose MODEL attempt succeeds (so `coach_port.calls` is non-empty, exactly as a real call
    would leave it) but whose STORAGE step `record_coaching_event` discards -- an AR002 stale-version race,
    `Orchestrator._coach`'s own documented discard path -- still returns `outcome="recorded"` from
    `run_turn`: nothing about the orchestrator's return value says the card was never written. `run_smoke`
    must read the trial's own events back (`ArenaDb.all_events`), not trust a non-empty `coach_port.calls`,
    and refuse this as a failure rather than report a false success."""
    actor = UUID(int=7)
    db = FakeArenaDb(actor)
    db.fail_next["record:coach_card"] = ArenaError("AR002", "stale transcript version: discard this card")

    def fake_subject_call(_connect: object, port: AgentPort, _actor: UUID | None) -> SubjectCall:
        async def call(_trial: UUID, work_item: UUID, _step_actor: UUID | None) -> SubjectOutcome:
            subject_call = AgentCall(
                model=VertexModel.FLASH_LITE_31,
                thinking=ThinkingLevel.MINIMAL,
                system="s",
                messages=(Message("user", "hello"),),
                schema=SubjectTurn,
                context=CallContext(
                    call_type=CallType.SUBJECT,
                    purpose="subject.answer",
                    step_key=str(work_item),
                    data_class="subject_private",
                ),
            )
            await port.run(subject_call)
            return db.record_answer(work_item)

        return call

    monkeypatch.setattr(real_smoke, "resolve_dev_user", lambda _env: DevIdentity(actor, "x@test", "X", frozenset()))
    monkeypatch.setattr(real_smoke, "dsn_connector", lambda _dsn: lambda: None)
    monkeypatch.setattr(real_smoke, "ArenaDb", lambda _connect, _actor: db)
    monkeypatch.setattr(real_smoke, "DbSpendGuard", lambda _connect: RunBudget(Decimal(100)))
    monkeypatch.setattr(real_smoke, "real_subject_call", fake_subject_call)

    env = {"ARENA_MODEL_MODE": "fake", "ARENA_PUBLIC_DSN": "x", "ARENA_SUBJECT_DSN": "y"}
    with pytest.raises(real_smoke.SmokeError, match="coach card stored=False"):
        run(real_smoke.run_smoke(env, family="F01", coach_name="A1", subject_name="S1", question="Why?"))

    # The model attempt genuinely ran (this is the condition the pre-fix code mistook for success).
    assert db.calls.count("record:coach_card") == 1


def _call(purpose: str, step_key: str = "k" * 10) -> AgentCall[Reply]:
    return AgentCall(
        model=VertexModel.FLASH_LITE_31,
        thinking=ThinkingLevel.MINIMAL,
        system="s",
        messages=(Message("user", "hello"),),
        schema=Reply,
        context=CallContext(
            call_type=CallType.SUBJECT, purpose=purpose, step_key=step_key, data_class="subject_private"
        ),
    )


def test_recording_port_captures_model_usage_cost_and_latency() -> None:
    port = real_smoke.RecordingPort(
        FakeAdapter(canned={"Reply": '{"note": "fine"}'}), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep)
    )
    result = run(port.run(_call("subject.answer")))
    assert result.value.note == "fine"
    assert len(port.calls) == 1
    recorded = port.calls[0]
    assert (recorded.purpose, recorded.model) == ("subject.answer", VertexModel.FLASH_LITE_31.value)
    assert recorded.result is result
    report = real_smoke._call_report(recorded)
    assert report["purpose"] == "subject.answer"
    assert report["model"] == VertexModel.FLASH_LITE_31.value
    assert report["attempts"] == result.attempts
    assert Decimal(report["cost_usd"]) == result.cost_usd
    assert json.dumps(report)  # every field is JSON-serializable (no UUID, no Decimal, no raw dataclass)


def test_recording_port_keeps_one_entry_per_call() -> None:
    port = real_smoke.RecordingPort(
        FakeAdapter(canned={"Reply": '{"note": "a"}'}), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep)
    )
    run(port.run(_call("subject.answer", step_key="k" * 10)))
    run(port.run(_call("experiment.fidelity", step_key="j" * 10)))
    assert [c.purpose for c in port.calls] == ["subject.answer", "experiment.fidelity"]


def test_main_refuses_without_either_dsn(capsys: pytest.CaptureFixture[str]) -> None:
    assert real_smoke.main(["--family", "F01"], {}) == 1
    assert "ARENA_PUBLIC_DSN" in capsys.readouterr().err


def test_main_never_echoes_a_malformed_dsns_own_password(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """A real psycopg connection attempt (dev_variant's own ArenaDb.fetch), not mocked: libpq's parser quotes a
    malformed connection string back whole, password included, on a stray quote or bad percent-encoding. The
    real identity resolution runs too (a real ARENA_USERS_FILE), so this exercises `main` end to end short of
    an actual server."""
    secret = "s3c" + "r3t"  # not a real credential; split so it is never one password-shaped literal
    malformed = "'postgresql://x:" + secret + "@owner-host:5/postgres'"  # the quotes break libpq's parser
    users_file = tmp_path / "users.toml"
    users_file.write_text('[[users]]\nemail = "x@test.local"\ndisplay_name = "X"\nroles = ["investigator"]\n')
    env = {
        "ARENA_PUBLIC_DSN": malformed,
        "ARENA_SUBJECT_DSN": malformed,
        "ARENA_DEV_USER": "x@test.local",
        "ARENA_USERS_FILE": str(users_file),
    }
    assert real_smoke.main(["--family", "F01"], env) == 1
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    assert malformed not in captured.out + captured.err
    assert "detail withheld" in captured.err


def test_main_uses_training_env_defaults_when_no_flag_is_given(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_run_smoke(
        _env: Mapping[str, str], *, family: str, coach_name: str, subject_name: str, question: str
    ) -> dict[str, Any]:
        seen.update(family=family, coach_name=coach_name, subject_name=subject_name, question=question)
        return {"ok": True}

    monkeypatch.setattr(real_smoke, "run_smoke", fake_run_smoke)
    env = {"ARENA_TRAINING_COACH": "A3", "ARENA_TRAINING_SUBJECT": "S3"}
    assert real_smoke.main(["--family", "F02"], env) == 0
    assert seen == {"family": "F02", "coach_name": "A3", "subject_name": "S3", "question": real_smoke.OPENING_QUESTION}


def test_main_flags_override_the_training_env_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_run_smoke(
        _env: Mapping[str, str], *, coach_name: str, subject_name: str, **_rest: str
    ) -> dict[str, Any]:
        seen.update(coach_name=coach_name, subject_name=subject_name)
        return {"ok": True}

    monkeypatch.setattr(real_smoke, "run_smoke", fake_run_smoke)
    env = {"ARENA_TRAINING_COACH": "A3", "ARENA_TRAINING_SUBJECT": "S3"}
    assert real_smoke.main(["--coach", "A2", "--subject", "S2"], env) == 0
    assert seen == {"coach_name": "A2", "subject_name": "S2"}


def test_main_reports_a_smoke_error_and_prints_nothing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def boom(*_a: object, **_k: object) -> dict[str, Any]:
        msg = "no development variant of family 'F09' is registered"
        raise real_smoke.SmokeError(msg)

    monkeypatch.setattr(real_smoke, "run_smoke", boom)
    assert real_smoke.main(["--family", "F09"], {}) == 1
    captured = capsys.readouterr()
    assert "F09" in captured.err
    assert captured.out == ""


def test_main_never_echoes_a_turn_refused_errors_free_text_if_one_ever_escapes_run_smoke(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Defense in depth: `run_smoke` wraps a `TurnRefusedError` into a `SmokeError` itself (the test above),
    but `main`'s own except tuple also lists `TurnRefusedError` directly, so a future call path that raises
    one without that wrap still never prints its unsafe `.args[0]`/`str(exc)` (which can carry an
    `ArenaError.message` forward verbatim, S4 2.3's `_arena_error`) -- only the exception's type name."""
    unsafe = "connection failed: password=s3cr3t-in-the-clear"

    async def boom(*_a: object, **_k: object) -> dict[str, Any]:
        raise TurnRefusedError(500, "database_error", unsafe)

    monkeypatch.setattr(real_smoke, "run_smoke", boom)
    assert real_smoke.main([], {}) == 1
    captured = capsys.readouterr()
    assert "TurnRefusedError" in captured.err
    assert unsafe not in captured.err
    assert "s3cr3t-in-the-clear" not in captured.err
    assert captured.out == ""


def test_main_prints_exactly_the_reports_json_object(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    canned = {"trial_id": str(uuid4()), "turn_no": 1, "outcome": "recorded", "subject": [], "coach": []}

    async def fake_run_smoke(*_a: object, **_k: object) -> dict[str, Any]:
        return canned

    monkeypatch.setattr(real_smoke, "run_smoke", fake_run_smoke)
    assert real_smoke.main([], {}) == 0
    assert json.loads(capsys.readouterr().out) == canned
