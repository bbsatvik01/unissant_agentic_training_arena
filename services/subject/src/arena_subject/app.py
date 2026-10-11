"""arena-subject application factory: `POST /internal/answer` (S2 6.10; S5 1, 5.2, 5.5).

`arena-subject` is internal-only (S5 5.5: its route table has exactly `/internal/answer` and
`/internal/voice/ws`, "never reachable from a browser"), so this app has no CORS, no static serving, no
OpenAPI UI and no extra route beyond the one S5 5.5 names; its one real route is authenticated by
`arena_subject.internal_auth`, the local stand-in for the Host/Origin/CSRF policy `arena_core.http_guard`
applies to the browser-facing services (WP-13).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from arena_core.config import ArenaRole, boot
from arena_core.db import subject as db_subject
from arena_core.db.pool import Connector, dsn_connector
from arena_core.providers.mode import model_adapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import DbSpendGuard
from arena_subject.answer import AnswerError, AnswerOutcome, answer
from arena_subject.internal_auth import CALLERS_VAR, InternalCallerRefusedError, parse_callers, verify_internal_caller

# S2 6.8's SubjectTurn schema has no canned reply pre-registered anywhere; a local fake-mode run needs one so
# `make dev` works without a per-session script (S5 10.4). It is schema-valid for every packet: an empty tag
# references no fact, uncertainty or gate ID (trivially within any packet's own sets, V2), and `responsive` is
# always an allowed behavior (V4, S2 6.4's base set, every role).
FAKE_SUBJECT_REPLY = (
    '{"utterance": "I do not have anything further to add right now.", '
    '"tag": {"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []}}'
)


@dataclass(frozen=True)
class AppState:
    """Everything a request handler needs: built once at process start, or once per test with doubles."""

    connect: Connector
    port: AgentPort
    allowed_callers: frozenset[str]


def state_from_env(env: Mapping[str, str]) -> AppState:
    """`AppState` for a real process: the S5 1.3 boot checks, the role's own DSN connector, the agent port on
    `ARENA_MODEL_MODE`'s adapter, and the local caller allowlist (S5 10.2 item 4)."""
    settings = boot(ArenaRole.SUBJECT, env)
    connect = dsn_connector(settings.dsn)
    adapter = model_adapter(env, canned={"SubjectTurn": FAKE_SUBJECT_REPLY})
    port = AgentPort(adapter, DbSpendGuard(connect), PortOptions())
    return AppState(connect=connect, port=port, allowed_callers=parse_callers(env.get(CALLERS_VAR, "")))


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trial: UUID
    work_item: UUID


class AnswerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str
    turn_no: int
    transcript_version: int | None = None


def _response(outcome: AnswerOutcome) -> AnswerResponse:
    return AnswerResponse(
        outcome=outcome.outcome, turn_no=outcome.turn_no, transcript_version=outcome.transcript_version
    )


def create_app(state: AppState) -> FastAPI:
    app = FastAPI(title="arena-subject", docs_url=None, redoc_url=None, openapi_url=None)

    async def _get_context(trial_id: UUID, work_item_id: UUID) -> db_subject.TurnContext:
        async with state.connect() as conn:
            return await db_subject.turn_context(conn, trial_id, work_item_id)

    async def _record(req: db_subject.RecordSubjectTurn) -> db_subject.RecordResult:
        async with state.connect() as conn:
            return await db_subject.record_subject_turn(conn, req)

    @app.post("/internal/answer", response_model=AnswerResponse)
    async def internal_answer(body: AnswerRequest, request: Request) -> AnswerResponse:
        try:
            verify_internal_caller(request.headers, state.allowed_callers)
        except InternalCallerRefusedError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.reason) from exc
        try:
            outcome = await answer(
                body.trial, body.work_item, get_context=_get_context, record=_record, port=state.port
            )
        except AnswerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc
        return _response(outcome)

    return app
