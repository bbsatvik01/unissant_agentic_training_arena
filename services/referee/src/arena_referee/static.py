"""The built web bundle on the referee origin (S6 4.13, C-39): `/admin` and `/review` are the same single-page app
the investigator origin serves, so the consoles call this origin's `/api/*` same-origin, with no extra browser
origin to configure. Static files come from `web/dist` (`ARENA_WEB_DIST` to override); any other GET outside
`/api/` and `/internal/` gets `index.html` (the SPA's own router renders the page). Without a built bundle
nothing is mounted and the API runs alone.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

DIST_VAR = "ARENA_WEB_DIST"
DEFAULT_DIST = Path(__file__).resolve().parents[4] / "web" / "dist"
_NOT_SPA = ("api/", "internal/")


def web_dist(env: dict[str, str]) -> Path:
    raw = env.get(DIST_VAR, "").strip()
    return Path(raw) if raw else DEFAULT_DIST


def install_static(app: FastAPI, dist: Path) -> bool:
    """Serve `dist` with an SPA fallback. Returns False (and mounts nothing) when there is no built bundle."""
    index = dist / "index.html"
    if not index.is_file():
        return False
    root = dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith(_NOT_SPA) or path in ("api", "internal"):
            raise HTTPException(status_code=404, detail="not_found")
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        return FileResponse(index)

    return True
