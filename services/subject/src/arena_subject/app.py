"""arena-subject application factory: `POST /internal/answer` (S2 6.10; S5 1, 5.2, 5.5).

`arena-subject` is internal-only (S5 5.5: its route table has exactly `/internal/answer` and
`/internal/voice/ws`, "never reachable from a browser"), so this app has no CORS, no static serving, no
OpenAPI UI and no extra route beyond the one S5 5.5 names; its one real route is authenticated by
`arena_subject.internal_auth`, the local stand-in for the Host/Origin/CSRF policy `arena_core.http_guard`
applies to the browser-facing services (WP-13).
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict

from arena_core.config import ArenaRole, boot
from arena_core.db import subject as db_subject
from arena_core.db.pool import Connector, PooledConnector, close_connector
from arena_core.db.voice import close_orphans
from arena_core.providers.mode import FAKE, MODE_VAR, model_adapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.vertex_live import vertex_live
from arena_core.spend.guard import DbSpendGuard
from arena_core.voice.live import FakeLive, LiveBackend
from arena_subject.answer import AnswerError, AnswerOutcome, AnswerStep, answer
from arena_subject.internal_auth import (
    CALLERS_VAR,
    InternalCallerRefusedError,
    parse_callers,
    verify_host,
    verify_internal_caller,
)
from arena_subject.live_session import VoiceSession
from arena_subject.voice_ws import VOICE_CALLER_VAR, DbVoiceStore, StarletteRelay

log = logging.getLogger("arena_subject")

# S5 10.1: arena-subject binds 127.0.0.1:8081 (ARENA_SUBJECT_PORT moves it for a second local stack).
# S5 10.3 step 1 applies the Host check "to every request"
# before dispatching on the path - independent of who the caller is, so it runs as middleware ahead of the
# one route this app has today and any internal route S5 5.5 adds later (/internal/voice/ws, WP-22).
PORT = int(os.environ.get("ARENA_SUBJECT_PORT", "8081"))
_ALLOWED_HOSTS = frozenset({f"127.0.0.1:{PORT}", f"localhost:{PORT}"})

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
    """Everything a request handler needs: built once at process start, or once per test with doubles.
    `in_progress` is this process's own record of which (trial, work_item) pairs are mid-request (S5 5.1:
    "a step is never executed by two live requests"); it is this route's whole claim to that rule until
    WP-13's orchestrator holds its own per-trial lock in front of this call. Plain `set` membership is
    enough only because nothing ever awaits between a check and its matching add or discard below (one
    asyncio event loop, D-016's one arena-subject process); it would need a real lock across more than
    one worker process."""

    connect: Connector
    port: AgentPort
    allowed_callers: frozenset[str]
    bind_host: str = "127.0.0.1"
    in_progress: set[tuple[UUID, UUID]] = field(default_factory=set)
    # Voice (S5 7): the Live backend (None: voice is off) and the one caller allowed on /internal/voice/ws, the
    # api's token (the tournament's is refused there).
    live: LiveBackend | None = None
    voice_callers: frozenset[str] = frozenset()
    sweep_orphans: bool = False


def state_from_env(env: Mapping[str, str]) -> AppState:
    """`AppState` for a real process: the S5 1.3 boot checks, the role's own DSN connector, the agent port on
    `ARENA_MODEL_MODE`'s adapter, and the local caller allowlist (S5 10.2 item 4)."""
    settings = boot(ArenaRole.SUBJECT, env)
    connect = PooledConnector(settings.dsn)
    adapter = model_adapter(env, canned={"SubjectTurn": FAKE_SUBJECT_REPLY})
    port = AgentPort(adapter, DbSpendGuard(connect), PortOptions())
    return AppState(
        connect=connect,
        port=port,
        allowed_callers=parse_callers(env.get(CALLERS_VAR, "")),
        bind_host=settings.bind_host,
        live=live_backend(env),
        voice_callers=parse_callers(env.get(VOICE_CALLER_VAR, "")),
        sweep_orphans=True,
    )


def live_backend(env: Mapping[str, str]) -> LiveBackend:
    """The scripted fake in `ARENA_MODEL_MODE=fake` (no network, no spend), else Vertex Live."""
    if env.get(MODE_VAR, "").strip() == FAKE:
        return FakeLive()
    return vertex_live(env)


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trial: UUID
    work_item: UUID
    # D-024: the investigator whose session this is, so the per-user daily cap (D-017) applies to the subject
    # call; None for a tournament trial (no investigator).
    actor: UUID | None = None


class AnswerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str
    turn_no: int
    transcript_version: int | None = None


def _response(outcome: AnswerOutcome) -> AnswerResponse:
    return AnswerResponse(
        outcome=outcome.outcome, turn_no=outcome.turn_no, transcript_version=outcome.transcript_version
    )


@asynccontextmanager
async def _lifespan(state: AppState) -> AsyncIterator[None]:
    """At start, close every voice session a previous process left open (S5 7.2 step 4: the local stack runs one
    arena-subject); at stop, close the pool."""
    if state.sweep_orphans:
        try:
            async with state.connect() as conn:
                closed = await close_orphans(conn)
            if closed:
                log.info("closed %d orphaned voice sessions", closed)
        except Exception:
            # A failed sweep leaves the sessions for the next start; serving goes on.
            log.exception("orphan voice sweep failed")
    try:
        yield
    finally:
        await close_connector(state.connect)


def create_app(state: AppState) -> FastAPI:
    app = FastAPI(
        title="arena-subject",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lambda _app: _lifespan(state),
    )

    @app.middleware("http")
    async def _internal_policy(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        # S5 10.3's whole internal policy - Host, then the caller's bearer token - runs ahead of routing and
        # body parsing, not just the Host half of it: inside the route handler, a malformed body already
        # returns 422 (FastAPI's own Pydantic validation, which runs before the handler body executes) and an
        # unmatched /internal/* path already returns 404, both *before* an unauthenticated caller was ever
        # refused. Checking both here, in order, means every response an unauthenticated caller can observe
        # is 421 or 401/403, never a hint about what a request's body or path would otherwise have done.
        try:
            verify_host(request.headers, _ALLOWED_HOSTS)
            verify_internal_caller(request.headers, state.allowed_callers)
        except InternalCallerRefusedError as exc:
            return JSONResponse({"detail": exc.reason}, status_code=exc.status_code)
        return await call_next(request)

    async def _get_context(trial_id: UUID, work_item_id: UUID) -> db_subject.TurnContext:
        async with state.connect() as conn:
            return await db_subject.turn_context(conn, trial_id, work_item_id)

    async def _record(req: db_subject.RecordSubjectTurn) -> db_subject.RecordResult:
        async with state.connect() as conn:
            return await db_subject.record_subject_turn(conn, req)

    @app.post("/internal/answer", response_model=AnswerResponse)
    async def internal_answer(body: AnswerRequest) -> AnswerResponse:
        key = (body.trial, body.work_item)
        if key in state.in_progress:
            # A live request for this exact work item is already running: recover=True inside answer()
            # would otherwise settle ITS reservation as usage_unknown out from under it (S5 4.10 recovery
            # is for a dead attempt, never a concurrent live one). The caller's own retry (after a timeout
            # or a crash) is exactly what recover is for, once this one has actually finished.
            raise HTTPException(status_code=409, detail="step_in_progress")
        state.in_progress.add(key)
        try:
            outcome = await answer(
                AnswerStep(body.trial, body.work_item, body.actor),
                get_context=_get_context,
                record=_record,
                port=state.port,
            )
        except AnswerError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.code) from exc
        finally:
            state.in_progress.discard(key)
        return _response(outcome)

    @app.websocket("/internal/voice/ws")
    async def voice_ws(ws: WebSocket) -> None:
        try:
            verify_host(ws.headers, _ALLOWED_HOSTS)
            verify_internal_caller(ws.headers, state.voice_callers)
        except InternalCallerRefusedError:
            await ws.close()  # before accept: the upgrade is refused (HTTP 403)
            return
        if state.live is None:
            await ws.close()
            return
        await ws.accept()
        await VoiceSession(StarletteRelay(ws), DbVoiceStore(state.connect), state.live).run()

    return app
