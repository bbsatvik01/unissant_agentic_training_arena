"""S5 1.4 for `python -m arena_api`: the boot checks run as a real process (each refusal exits 1 before any server
starts), and `main()` in process serves the app on 127.0.0.1:8080 (uvicorn stubbed, so the test never blocks)."""

from __future__ import annotations

import os
import selectors
import signal
import time
from typing import Any

import pytest

from arena_api import __main__ as api_main
from arena_api.state import PORT
from tools.tests.subprocess_support import good_env, popen_role_module, refusal_cases, run_role_module, with_overrides

ROLE = "api"
MODULE = "arena_api"
OWN_DSN_VAR = "ARENA_PUBLIC_DSN"
GOOD_ENV = {**good_env(ROLE, OWN_DSN_VAR), "ARENA_MODEL_MODE": "fake"}
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
    """S5 10.1: a clean environment really serves on 127.0.0.1:8080 (uvicorn's startup line), and SIGTERM runs
    the graceful shutdown to completion."""
    proc = popen_role_module(MODULE, GOOD_ENV)
    assert proc.stdout is not None
    try:
        fd = proc.stdout.fileno()
        seen = _output_until(fd, b"Uvicorn running on", time.monotonic() + TIMEOUT_S)
        assert b"boot checks passed" in seen, seen
        assert f"Uvicorn running on http://127.0.0.1:{PORT}".encode() in seen, seen
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


def test_main_serves_the_app_on_loopback_8080(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    calls: list[dict[str, Any]] = []

    def fake_run(app: object, *, host: str, port: int, log_level: str) -> None:
        calls.append({"app": app, "host": host, "port": port, "log_level": log_level})

    monkeypatch.setattr("arena_api.__main__.uvicorn.run", fake_run)
    assert api_main.main() == 0
    assert "boot checks passed" in capsys.readouterr().out
    assert [(c["host"], c["port"]) for c in calls] == [("127.0.0.1", PORT)]


def test_main_exits_1_in_process_on_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", {**GOOD_ENV, "GEMINI_API_KEY": "fake-value"})
    with pytest.raises(SystemExit) as exc_info:
        api_main.main()
    assert exc_info.value.code == 1
