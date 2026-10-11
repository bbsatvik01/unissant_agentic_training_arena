"""What every `arena-api` route reads: the process state built at startup, the acting user, and the error
mapping from S4 refusals to HTTP answers (S5 5.5, 10.3)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from arena_api.referee_client import DebriefCall
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.db.pool import Connector
from arena_core.identity import DevIdentity
from arena_core.providers.port import AgentPort
from arena_core.turns.orchestrator import Orchestrator, SubjectCall, TrialSignals, TurnRefusedError, refusal

PORT = 8080  # S5 10.1
QUESTION_MAX_CHARS = 600  # D11


@dataclass(frozen=True)
class ApiState:
    connect: Connector
    identity: DevIdentity | None  # None: ARENA_DEV_USER is not on the allowlist (every /api/* route is 403)
    port: AgentPort
    subject: SubjectCall
    debrief: DebriefCall
    coach_name: str = "A1"
    subject_name: str = "S1"
    case_draw_seed: str = "0"
    stream_max_s: float = 600.0
    stream_poll_s: float = 1.0
    ping_after_s: float = 15.0
    signals: TrialSignals = field(default_factory=TrialSignals)
    make_db: Callable[[Connector, UUID], ArenaDb] = ArenaDb

    def db(self, actor: UUID) -> ArenaDb:
        return self.make_db(self.connect, actor)

    def orchestrator(self, actor: UUID) -> Orchestrator:
        return Orchestrator(db=self.db(actor), port=self.port, subject=self.subject, signals=self.signals)


def api_state(request: Request) -> ApiState:
    state: ApiState = request.app.state.api
    return state


def identity(request: Request) -> DevIdentity:
    """The acting investigator (S5 10.3); the middleware already refused a request without one."""
    found = api_state(request).identity
    if found is None:  # unreachable behind the middleware; kept so a route can never run unauthenticated
        raise HTTPException(status_code=403, detail="not_allowlisted")
    return found


def actor_db(request: Request) -> ArenaDb:
    return api_state(request).db(identity(request).user_id)


def error_response(exc: TurnRefusedError | ArenaError) -> JSONResponse:
    refused = refusal(exc) if isinstance(exc, ArenaError) else exc
    return JSONResponse({"code": refused.code, "detail": str(refused)}, status_code=refused.status)
