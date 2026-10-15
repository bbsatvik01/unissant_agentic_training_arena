"""What every `arena-api` route reads: the process state built at startup, the acting user, and the error
mapping from S4 refusals to HTTP answers (S5 5.5, 10.3)."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from arena_api.referee_client import DebriefCall
from arena_api.voice_relay import RelayRegistry, SubjectDialer
from arena_core.agents.templates import REPO_ROOT
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.db.pool import Connector
from arena_core.identity import DevIdentity
from arena_core.npc.chat import DEFAULT_MESSAGES_PER_MIN, MessageLimit, NpcChat
from arena_core.providers.port import AgentPort
from arena_core.turns.orchestrator import Orchestrator, SubjectCall, TrialSignals, TurnRefusedError, refusal

PORT = int(os.environ.get("ARENA_API_PORT", "8080"))  # S5 10.1 (ARENA_API_PORT moves it for a second local stack)
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
    planned_n: int = 30  # S8 1.3: the 30-case baseline (34 only if OD-8 approves after the dev pilot)
    stream_max_s: float = 600.0
    stream_poll_s: float = 1.0
    ping_after_s: float = 15.0
    signals: TrialSignals = field(default_factory=TrialSignals)
    make_db: Callable[[Connector, UUID], ArenaDb] = ArenaDb
    voice_dialer: SubjectDialer | None = None
    voice_relays: RelayRegistry = field(default_factory=RelayRegistry)
    coachlab_root: Path = REPO_ROOT  # the repository whose coachlab/ registry the Coach Lab routes read (D-036)
    npc: NpcChat | None = None  # None: no NPC chat in this process (404)
    npc_limit: MessageLimit = field(default_factory=lambda: MessageLimit(DEFAULT_MESSAGES_PER_MIN))

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
    """The refusal's status and stable code only: database and exception text never reach the browser."""
    refused = refusal(exc) if isinstance(exc, ArenaError) else exc
    return JSONResponse({"code": refused.code}, status_code=refused.status)
