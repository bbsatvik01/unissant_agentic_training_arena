"""S5 1.4 for `python -m arena_referee`: the boot checks run as a real process (each refusal exits 1
before any server starts), and a clean environment really serves the internal scoring routes on
127.0.0.1:8082 (S5 10.1) until signalled -- not just "exits 0", the WP-08-era stub's old behavior.
`services/tournament/tests/it_tournament.py` now depends on this real serving path (`popen_role_module`
launching this same module, on a scratch port), since that package may never import `arena_referee` in
process (S5 1.2 item 2).
"""

from __future__ import annotations

import os
import selectors
import signal
import tempfile
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from arena_referee import __main__ as referee_main
from arena_referee.app import REFEREE_PORT
from tools.tests.subprocess_support import good_env, popen_role_module, refusal_cases, run_role_module, with_overrides

ROLE = "referee"
MODULE = "arena_referee"
OWN_DSN_VAR = "ARENA_REFEREE_DSN"
ADMIN_EMAIL = "admin@example.test"
# `create_app` resolves one acting dev user whenever `ARENA_ENV=local` (S5 10.3), with no graceful
# fallback (unlike `arena_api`'s own boot, which only warns): every console/review route reads
# `app.state.identity`, so a run with no owner-approved reviewer refuses to boot rather than serve with a
# silently-missing identity. A throwaway users.toml, written once for this module's tests.
_USERS_DIR = tempfile.mkdtemp(prefix="arena-referee-test-main-")
_USERS_PATH = Path(_USERS_DIR) / "users.toml"
_USERS_PATH.write_text(f'[[users]]\nemail = "{ADMIN_EMAIL}"\ndisplay_name = "Admin"\nroles = ["admin"]\n')
# ARENA_MODEL_MODE=fake: create_app builds the agent port's adapter at startup (D-012's "zero spend in
# tests" extends to boot, not only to a served request).
GOOD_ENV = {
    **good_env(ROLE, OWN_DSN_VAR),
    "ARENA_MODEL_MODE": "fake",
    "ARENA_DEV_USER": ADMIN_EMAIL,
    "ARENA_USERS_FILE": str(_USERS_PATH),
    "ARENA_GIT_SHA": "f" * 40,  # fixture value only: create_app refuses to boot without one (S3 9)
}
TIMEOUT_S = 10.0


def _output_until(fd: int, needle: bytes, deadline: float) -> bytes:
    """The child's output until `needle` appears or the monotonic `deadline` passes (raw reads, never blocking)."""
    sel = selectors.DefaultSelector()
    sel.register(fd, selectors.EVENT_READ)
    seen = b""
    try:
        while needle not in seen:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not sel.select(timeout=remaining):
                break
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            seen += chunk
    finally:
        sel.close()
    return seen


def test_boots_clean_as_a_process_serves_until_signalled_then_shuts_down() -> None:
    """S5 10.1: a clean environment really serves on 127.0.0.1:8082 (uvicorn's startup line); a real,
    unauthenticated request against the real internal scoring route gets the D10 guard's 401 (proving
    this is the real app with its real route, not merely that something is listening), and SIGTERM runs
    the graceful shutdown to completion."""
    proc = popen_role_module(MODULE, GOOD_ENV)
    assert proc.stdout is not None
    try:
        fd = proc.stdout.fileno()
        seen = _output_until(fd, b"Uvicorn running on", time.monotonic() + TIMEOUT_S)
        assert b"boot checks passed" in seen, seen
        assert f"Uvicorn running on http://127.0.0.1:{REFEREE_PORT}".encode() in seen, seen

        resp = httpx.post(f"http://127.0.0.1:{REFEREE_PORT}/internal/trials/{uuid4()}/score", timeout=5.0)
        assert resp.status_code == HTTPStatus.UNAUTHORIZED

        proc.send_signal(signal.SIGTERM)
        seen += _output_until(fd, b"Application shutdown complete", time.monotonic() + TIMEOUT_S)
        assert proc.wait(timeout=TIMEOUT_S) == -signal.SIGTERM
        assert b"Application shutdown complete" in seen, seen
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=TIMEOUT_S)
        proc.stdout.close()


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("overrides", "needle"),
    [(o, n) for _, o, n in refusal_cases(ROLE, OWN_DSN_VAR)],
    ids=[c for c, _, _ in refusal_cases(ROLE, OWN_DSN_VAR)],
)
def test_each_refusal_exits_nonzero_and_names_the_reason(overrides: dict[str, str | None], needle: str) -> None:
    result = run_role_module(MODULE, with_overrides(GOOD_ENV, overrides))
    assert result.returncode == 1, (result.stdout, result.stderr)
    assert "arena boot check failed" in result.stderr
    assert needle in result.stderr
    assert "boot checks passed" not in result.stdout


def test_main_serves_the_app_on_loopback_8082(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`main()`'s own wiring, without actually serving: `uvicorn.run` is stubbed, so this proves the call
    arguments and the startup message without blocking the test process."""
    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    calls: list[dict[str, Any]] = []

    def fake_run(app: object, *, host: str, port: int, log_level: str) -> None:
        calls.append({"app": app, "host": host, "port": port, "log_level": log_level})

    monkeypatch.setattr("arena_referee.__main__.uvicorn.run", fake_run)
    assert referee_main.main() == 0
    assert "boot checks passed" in capsys.readouterr().out
    assert [(c["host"], c["port"]) for c in calls] == [("127.0.0.1", REFEREE_PORT)]


def test_main_exits_1_in_process_on_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", {**GOOD_ENV, "GEMINI_API_KEY": "fake-value"})
    with pytest.raises(SystemExit) as exc_info:
        referee_main.main()
    assert exc_info.value.code == 1
