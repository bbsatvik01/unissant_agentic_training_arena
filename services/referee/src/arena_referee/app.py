"""arena-referee application factory (S5 1, 10.1, 10.3): the D10 Host/Origin/CSRF guard first on every
request, then the console, review and internal scoring/debrief routes. Binds 127.0.0.1:8082 (S5 10.1).

`ARENA_ENV=local` resolves one acting user for the whole run (S5 10.3: "one acting user per run"; restart to
switch). The hosted variant's IAP identity mapping (S5 9.3) is WP-33's.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Response
from starlette.requests import Request
from starlette.responses import JSONResponse

from arena_core.agents.manifests import load_prompts, referee_manifest, with_hash
from arena_core.config import ArenaRole, Settings, boot
from arena_core.db.pool import dsn_connector
from arena_core.http_guard import GuardConfig, GuardRefusalError, RequestFacts, evaluate_request
from arena_core.identity import DevIdentity, resolve_dev_user
from arena_core.providers.mode import model_adapter
from arena_core.providers.port import AgentPort
from arena_core.referee.fake_referee import FAKE_REFEREE_REPLIES
from arena_core.scoring.rubric import lineage_checked_sha256
from arena_core.spend.guard import DbSpendGuard
from arena_referee import db
from arena_referee.debrief import DebriefProvenance
from arena_referee.routes import router as api_router
from arena_referee.scoring import PromptContext, default_dev_rubric

REFEREE_PORT = 8082  # S5 10.1
_BROWSER_ORIGINS_VAR = "ARENA_BROWSER_ORIGINS"
_LOCAL_CALLERS_VAR = "ARENA_LOCAL_CALLERS"
_PORT_VAR = "ARENA_REFEREE_PORT"


def port(env: dict[str, str]) -> int:
    """`REFEREE_PORT` (S5 10.1), overridable so an integration test can run a real referee subprocess on a
    scratch port instead of the fixed one `scripts/dev.sh` always binds -- never set outside a test:
    nothing in production or `scripts/dev.sh` names this variable, so every real run still gets 8082."""
    return int(env.get(_PORT_VAR, str(REFEREE_PORT)))


def _default_origins(env: dict[str, str]) -> frozenset[str]:
    bound = port(env)
    return frozenset({f"http://127.0.0.1:{bound}", f"http://localhost:{bound}"})


def _browser_origins(env: dict[str, str]) -> frozenset[str]:
    raw = env.get(_BROWSER_ORIGINS_VAR, "").strip()
    return frozenset(o.strip() for o in raw.split(",") if o.strip()) if raw else _default_origins(env)


def _caller_hashes(env: dict[str, str]) -> frozenset[str]:
    """Every allowed internal caller's token sha256 (S5 10.2 item 4), pooled across routes: `arena-api` and
    `arena-tournament` each call a different internal path, and D-016 keeps one allowlist rather than a
    per-route one until `run_local.py` exists to mint per-caller tokens."""
    raw = env.get(_LOCAL_CALLERS_VAR, "").strip()
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def _guard_config(env: dict[str, str]) -> GuardConfig:
    bound = port(env)
    allowed_hosts = frozenset({f"127.0.0.1:{bound}", f"localhost:{bound}"})
    callers = _caller_hashes(env)
    return GuardConfig(
        allowed_hosts=allowed_hosts, allowed_origins=_browser_origins(env), internal_caller_hashes=lambda _p: callers
    )


def _install_d10_guard(app: FastAPI, config: GuardConfig) -> None:
    """S5 10.3's Host, Origin and CSRF sequence, run before any route (D10). A plain `@app.middleware("http")`
    function, not a `BaseHTTPMiddleware` subclass: Starlette's own middleware-factory typing does not match a
    subclass that takes extra constructor arguments, so a function closure over `config` is both simpler and
    cleanly typed."""

    @app.middleware("http")
    async def d10_guard(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        headers = {k.lower(): v for k, v in request.headers.items()}
        facts = RequestFacts(
            method=request.method,
            path=request.url.path,
            host_header=headers.get("host"),
            headers=headers,
            authorization=headers.get("authorization"),
            origin=headers.get("origin"),
            sec_fetch_site=headers.get("sec-fetch-site"),
            csrf_cookie=request.cookies.get("arena_csrf"),
            csrf_header=headers.get("x-arena-csrf"),
        )
        try:
            evaluate_request(config, facts)
        except GuardRefusalError as refusal:
            return JSONResponse({"detail": refusal.reason}, status_code=refusal.status)
        return await call_next(request)


def create_app(env: dict[str, str] | None = None) -> FastAPI:
    resolved_env = dict(os.environ if env is None else env)
    settings: Settings = boot(ArenaRole.REFEREE, resolved_env)
    connect = dsn_connector(settings.dsn)
    adapter = model_adapter(resolved_env, canned=FAKE_REFEREE_REPLIES)
    guard = DbSpendGuard(connect)
    port = AgentPort(adapter, guard)
    manifest = with_hash(referee_manifest())
    prompts = load_prompts(manifest)
    rubric = default_dev_rubric()  # S2 7.4: no rubric.v1 yet; a development placeholder only
    prompt_sha256 = manifest.sha256 or ""

    scoring_deps = db.make_scoring_deps(connect, port, prompt_sha256)
    provenance = DebriefProvenance(
        # The scorer's own hash (lexicon, prompt texts and model ids, S3 2.11) -- distinct from
        # `prompt_sha256` below, which is the referee *agent* manifest's hash (R1/R2's system prompts).
        # Conflating the two would make a rubric-only change (lexicon, thresholds, applicability rules)
        # invisible in a published debrief's provenance.
        rubric_sha256=lineage_checked_sha256(),
        r3_prompt_sha256=(prompt_sha256, prompt_sha256),
        referee_model_ids=("gemini-3.1-flash-lite", "gemini-3.5-flash-lite"),
        scorer_git_sha=resolved_env.get("ARENA_GIT_SHA", "0" * 40),
    )
    debrief_deps = db.make_debrief_deps(connect, scoring_deps, provenance)

    identity: DevIdentity | None = resolve_dev_user(resolved_env) if settings.is_local else None

    app = FastAPI(title="arena-referee")
    app.state.connect = connect
    app.state.scoring_deps = scoring_deps
    app.state.debrief_deps = debrief_deps
    app.state.prompt_context = PromptContext(prompts=prompts, rubric=rubric)
    app.state.identity = identity
    _install_d10_guard(app, _guard_config(resolved_env))
    app.include_router(api_router)

    @app.get("/api/health")
    async def health() -> dict[str, bool]:
        """Liveness only (S5 5.5): the one route with no identity requirement. Still passes the D10 Host
        check (every request does); a bodyless GET needs no Origin or CSRF check (D10 applies those to
        state-changing requests only)."""
        return {"ok": True}

    return app
