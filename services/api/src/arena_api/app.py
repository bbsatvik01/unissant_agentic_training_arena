"""arena-api application factory (S5 1, 5.5, 6, 10.1, 10.3): the investigator's REST routes and the trial SSE.

Every request passes, in order: the D10 guard (Host, then Origin and the CSRF double-submit on a state-changing
request; `/internal/*` is not served here and is refused), the dev identity (an `ARENA_DEV_USER` outside the
allowlist gets 403 on every `/api/*` route, S5 10.4), and the kill switch (read at most every 5 s; 503
`{"code": "paused"}`, S5 4.8). `/api/health` is liveness only and skips the last two.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from fastapi import FastAPI, Response
from starlette.requests import Request
from starlette.responses import JSONResponse

from arena_api.referee_client import referee_client
from arena_api.routes import router
from arena_api.state import PORT, ApiState
from arena_api.subject_client import SUBJECT_URL, subject_client
from arena_api.voice_relay import subject_dialer
from arena_core.config import ArenaRole, boot
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import PooledConnector, closing_lifespan
from arena_core.http_guard import (
    CSRF_COOKIE,
    CSRF_HEADER,
    GuardConfig,
    GuardRefusalError,
    RequestFacts,
    evaluate_request,
)
from arena_core.identity import IdentityError, resolve_dev_user
from arena_core.npc.chat import FAKE_NPC_REPLIES, RATE_VAR, MessageLimit, NpcChat, messages_per_min
from arena_core.providers.mode import FAKE, MODE_VAR, model_adapter
from arena_core.providers.openai_compat import ChatClient, configured_endpoints
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import DbSpendGuard
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES

log = logging.getLogger("arena_api")
HEALTH = "/api/health"
PAUSE_CACHE_S = 5.0  # S5 4.8: the middleware reads the kill switch at most every 5 s
VITE_ORIGINS = frozenset({"http://127.0.0.1:5173", "http://localhost:5173"})


def guard_config(env: Mapping[str, str]) -> GuardConfig:
    hosts = frozenset({f"127.0.0.1:{PORT}", f"localhost:{PORT}"})
    raw = env.get("ARENA_BROWSER_ORIGINS", "").strip()
    extra = frozenset(o.strip().rstrip("/") for o in raw.split(",") if o.strip()) if raw else VITE_ORIGINS
    return GuardConfig(allowed_hosts=hosts, allowed_origins=frozenset(f"http://{h}" for h in hosts) | extra)


@dataclass
class _Pause:
    read_at: float = -1e9
    paused: bool = False
    clock: Callable[[], float] = field(default=time.monotonic)

    async def check(self, db: ArenaDb) -> bool:
        if self.clock() - self.read_at >= PAUSE_CACHE_S:
            self.paused = bool((await db.public_config())["paused"])
            self.read_at = self.clock()
        return self.paused


def _facts(request: Request) -> RequestFacts:
    headers = {k.lower(): v for k, v in request.headers.items()}
    return RequestFacts(
        method=request.method,
        path=request.url.path,
        host_header=headers.get("host"),
        headers=headers,
        authorization=headers.get("authorization"),
        origin=headers.get("origin"),
        sec_fetch_site=headers.get("sec-fetch-site"),
        csrf_cookie=request.cookies.get(CSRF_COOKIE),
        csrf_header=headers.get(CSRF_HEADER.lower()),
    )


def create_app(state: ApiState, config: GuardConfig, *, phoenix_url: str | None = None) -> FastAPI:
    app = FastAPI(
        title="arena-api", docs_url=None, redoc_url=None, lifespan=lambda _app: closing_lifespan(state.connect)
    )
    app.state.api = state
    app.state.guard_config = config
    app.state.phoenix_url = phoenix_url
    pause = _Pause()

    @app.middleware("http")
    async def boundary(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        try:
            evaluate_request(config, _facts(request))
        except GuardRefusalError as refusal:
            return JSONResponse({"code": "refused", "detail": refusal.reason}, status_code=refusal.status)
        path = request.url.path
        if path.startswith("/api/") and path != HEALTH:
            if state.identity is None:
                return JSONResponse({"code": "not_allowlisted"}, status_code=403)
            if await pause.check(state.db(state.identity.user_id)):
                return JSONResponse({"code": "paused"}, status_code=503)
        return await call_next(request)

    @app.get(HEALTH)
    async def health() -> dict[str, bool]:
        return {"ok": True}

    app.include_router(router)
    return app


def state_from_env(env: Mapping[str, str]) -> ApiState:
    """The process state: boot checks, the role's DSN, the dev identity, the agent port (fake replies registered
    for `ARENA_MODEL_MODE=fake`), the caller-token clients for arena-subject and arena-referee, and NPC chat."""
    settings = boot(ArenaRole.API, env)
    connect = PooledConnector(settings.dsn)
    try:
        identity = resolve_dev_user(env)
    except IdentityError as exc:
        log.warning("arena-api: no dev identity (%s); every /api/* request will be refused 403", exc)
        identity = None
    port = AgentPort(
        model_adapter(env, canned={**FAKE_COACH_REPLIES, **FAKE_NPC_REPLIES}), DbSpendGuard(connect), PortOptions()
    )
    # NPC chat (UI v2, D-035): the free endpoints whose keys are set, never in fake mode (no network there), then the
    # Gemini fallback on this same port and guard.
    fake = env.get(MODE_VAR, "").strip() == FAKE
    npc = NpcChat(endpoints=[] if fake else configured_endpoints(env), client=ChatClient(), port=port)
    token = env.get("ARENA_LOCAL_CALLER_TOKEN", "")
    return ApiState(
        connect=connect,
        identity=identity,
        port=port,
        subject=subject_client(token),
        debrief=referee_client(token),
        voice_dialer=subject_dialer(token, SUBJECT_URL.replace("http://", "ws://") + "/internal/voice/ws"),
        coach_name=env.get("ARENA_TRAINING_COACH", "A1"),
        subject_name=env.get("ARENA_TRAINING_SUBJECT", "S1"),
        case_draw_seed=env.get("ARENA_CASE_DRAW_SEED", "0"),
        planned_n=int(env.get("ARENA_PLANNED_N", "30")),
        npc=npc,
        npc_limit=MessageLimit(messages_per_min(env.get(RATE_VAR))),
    )
