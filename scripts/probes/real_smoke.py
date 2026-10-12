"""`make real-smoke` (S5 3, 4, 5.1, 5.2): one real subject call and one real coach card through the real
`AgentPort`, each reserved through the real spend guard against the database named by `ARENA_PUBLIC_DSN` and
`ARENA_SUBJECT_DSN` -- the same two role credentials and the same production code (`training.start_session`,
`arena.submit_question`, `subject.turn_context`, `arena_subject.answer.answer`,
`arena_core.turns.orchestrator.Orchestrator`) a real training session runs, with no HTTP server and no web
client in between. Prints one JSON object: each call's model, token usage, cost and latency; never a DSN, a
password or packet content.

Needs, read from the environment only (never argv, never printed):

    ARENA_GCP_PROJECT     cna-guardian (D-015), checked by the port's own policy
    ARENA_PUBLIC_DSN      arena_public credential: session start, submit_question, the coach's reservations
    ARENA_SUBJECT_DSN     arena_subject credential: the subject's own turn_context, reservation and record
    ARENA_DEV_USER        an email in ARENA_USERS_FILE's allowlist (S5 10.3): the acting investigator
    ARENA_USERS_FILE      the allowlist TOML
    ARENA_MODEL_MODE      unset, or `vertex`, for a real Vertex call; `fake` for the zero-spend smoke test
                          this script is tested with (`arena_core.providers.fake.FakeAdapter`)
    VERTEX_IMPERSONATE_SERVICE_ACCOUNT   optional, local impersonation (S5 10.2)

    ARENA_TRAINING_COACH, ARENA_TRAINING_SUBJECT   optional, default A1 and S1 (the same defaults
                          `/api/sessions` uses) -- the newest registered version of each is called

Run it as a module from the repository root, exactly as `scripts/budget_plan.py`:

    uv run --locked python -m scripts.probes.real_smoke --family F01

A development case family only (`training.start_session` refuses a retired or hidden-split variant); the
session is a practice session, never scored, and starts no voice. One turn: submit one question, release
nothing, let the subject answer, let the coach write its card. A1's own deep update fires only on a release
or every third exchange (S2 4.6), so turn 1 with no release calls the coach exactly once.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import psycopg
from pydantic import BaseModel

from arena_core.db import subject as db_subject
from arena_core.db.arena import ArenaDb, ArenaError, SessionStart
from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import DevIdentity, IdentityError, resolve_dev_user
from arena_core.providers.mode import model_adapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.types import AgentCall, AgentResult, ModelAdapter
from arena_core.spend.guard import DbSpendGuard, SpendGuard
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import (
    Orchestrator,
    SubjectCall,
    SubjectOutcome,
    SubjectUnavailableError,
    TrialSignals,
)
from arena_subject.answer import AnswerError, AnswerStep, answer
from arena_subject.app import FAKE_SUBJECT_REPLY

DEFAULT_COACH = "A1"
DEFAULT_SUBJECT = "S1"
DEFAULT_FAMILY = "F01"
OPENING_QUESTION = "Can you walk me through what happened that day?"
DSN_VARS = ("ARENA_PUBLIC_DSN", "ARENA_SUBJECT_DSN")


class SmokeError(RuntimeError):
    """A precondition (a DSN, the dev user, the family, a registered candidate) is not met; no call was made."""


@dataclass(frozen=True)
class _Recorded:
    purpose: str
    model: str
    result: AgentResult[Any]


class RecordingPort(AgentPort):
    """The real `AgentPort`, with the model and `AgentResult` of every call it runs kept for this run's report."""

    def __init__(self, adapter: ModelAdapter, guard: SpendGuard, options: PortOptions | None = None) -> None:
        super().__init__(adapter, guard, options)
        self.calls: list[_Recorded] = []

    async def run[T: BaseModel](self, call: AgentCall[T]) -> AgentResult[T]:
        result = await super().run(call)
        self.calls.append(_Recorded(purpose=call.context.purpose, model=call.model.value, result=result))
        return result


def real_subject_call(connect: Connector, port: AgentPort, actor: UUID | None) -> SubjectCall:
    """A `SubjectCall` that runs the real `arena_subject.answer.answer` in this process (no HTTP hop): the same
    split of work `services/api/tests/it_api.py`'s own stand-in uses, with the real model behind it."""

    async def get_context(trial: UUID, work_item: UUID) -> db_subject.TurnContext:
        async with connect() as conn:
            return await db_subject.turn_context(conn, trial, work_item)

    async def record(req: db_subject.RecordSubjectTurn) -> db_subject.RecordResult:
        async with connect() as conn:
            return await db_subject.record_subject_turn(conn, req)

    async def call(trial: UUID, work_item: UUID, step_actor: UUID | None) -> SubjectOutcome:
        step = AnswerStep(trial, work_item, step_actor if step_actor is not None else actor)
        try:
            outcome = await answer(step, get_context=get_context, record=record, port=port)
        except AnswerError as exc:
            raise SubjectUnavailableError(exc.code) from exc
        return SubjectOutcome(outcome.outcome, outcome.turn_no)

    return call


async def dev_variant(public: ArenaDb, family: str) -> UUID:
    cases = [c for c in await public.dev_cases() if c["family_code"] == family]
    if not cases:
        msg = f"no development variant of family {family!r} is registered"
        raise SmokeError(msg)
    return UUID(str(sorted(cases, key=lambda c: str(c["variant_id"]))[0]["variant_id"]))


async def registered_candidate(public: ArenaDb, kind: str, name: str) -> UUID:
    found = await public.candidate(kind, name)
    if found is None:
        msg = f"{kind} candidate {name!r} is not registered (run make seed-hosted first)"
        raise SmokeError(msg)
    return found[0]


def _call_report(recorded: _Recorded) -> dict[str, Any]:
    result = recorded.result
    return {
        "purpose": recorded.purpose,
        "model": recorded.model,
        "attempts": result.attempts,
        "input_tokens": result.usage.input_tokens,
        "output_tokens": result.usage.output_tokens,
        "thinking_tokens": result.usage.thinking_tokens,
        "cost_usd": str(result.cost_usd),
        "latency_ms": round(result.latency_ms, 1),
    }


async def run_smoke(
    env: Mapping[str, str], *, family: str, coach_name: str, subject_name: str, question: str
) -> dict[str, Any]:
    missing = [v for v in DSN_VARS if not env.get(v)]
    if missing:
        msg = f"{missing} not set"
        raise SmokeError(msg)
    who: DevIdentity = resolve_dev_user(env)
    public_connect = dsn_connector(env["ARENA_PUBLIC_DSN"])
    subject_connect = dsn_connector(env["ARENA_SUBJECT_DSN"])
    public = ArenaDb(public_connect, who.user_id)

    variant = await dev_variant(public, family)
    coach_id = await registered_candidate(public, "assistant", coach_name)
    subject_id = await registered_candidate(public, "subject", subject_name)

    start = SessionStart(variant, "practice", coach_id, subject_id, False, secrets.token_hex(16))
    try:
        started = await public.start_session(start)
    except ArenaError as exc:
        msg = f"start_session refused: {exc.code} {exc.message}"
        raise SmokeError(msg) from exc
    trial_id = UUID(str(started["trial_id"]))

    # The canned replies are real production fixtures (arena_subject.app, arena_core.turns.fake_coach), passed
    # unconditionally: model_adapter uses them only in ARENA_MODEL_MODE=fake, so a real run ignores them.
    coach_port = RecordingPort(
        model_adapter(env, canned=FAKE_COACH_REPLIES), DbSpendGuard(public_connect), PortOptions()
    )
    subject_port = RecordingPort(
        model_adapter(env, canned={"SubjectTurn": FAKE_SUBJECT_REPLY}), DbSpendGuard(subject_connect), PortOptions()
    )
    subject_call = real_subject_call(subject_connect, subject_port, who.user_id)
    orchestrator = Orchestrator(db=public, port=coach_port, subject=subject_call, signals=TrialSignals())

    started_at = time.monotonic()
    turn = await orchestrator.run_turn(trial_id, question, [], 0, secrets.token_hex(16))
    elapsed_ms = (time.monotonic() - started_at) * 1000

    return {
        "trial_id": str(trial_id),
        "turn_no": turn["turn_no"],
        "outcome": turn["outcome"],
        "elapsed_ms": round(elapsed_ms, 1),
        "subject": [_call_report(c) for c in subject_port.calls],
        "coach": [_call_report(c) for c in coach_port.calls],
    }


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scripts.probes.real_smoke", description=__doc__)
    parser.add_argument("--family", default=DEFAULT_FAMILY)
    parser.add_argument("--coach", default=None, help=f"default: $ARENA_TRAINING_COACH or {DEFAULT_COACH}")
    parser.add_argument("--subject", default=None, help=f"default: $ARENA_TRAINING_SUBJECT or {DEFAULT_SUBJECT}")
    parser.add_argument("--question", default=OPENING_QUESTION)
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    coach = args.coach or resolved.get("ARENA_TRAINING_COACH", DEFAULT_COACH)
    subject = args.subject or resolved.get("ARENA_TRAINING_SUBJECT", DEFAULT_SUBJECT)
    try:
        result = asyncio.run(
            run_smoke(resolved, family=args.family, coach_name=coach, subject_name=subject, question=args.question)
        )
    except (SmokeError, IdentityError, ArenaError, psycopg.Error) as exc:
        sys.stderr.write(f"real_smoke: {type(exc).__name__}: {exc}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
