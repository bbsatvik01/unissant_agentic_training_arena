"""S5 1.4 for `python -m arena_subject`: the boot checks run as a real process, and a clean environment
actually serves `/internal/answer` (S5 10.1) until signalled, not just "exits 0".

The refusal cases are shared with the other three roles (tools/tests/subprocess_support.py), so every
role proves the same S5 1.3 refusals against its own entry point; they still exit promptly, because
`boot()` (inside `state_from_env`) calls `sys.exit(1)` before `main()` ever reaches `uvicorn.run`.
"""

from __future__ import annotations

import os
import selectors
import signal
import time
from collections.abc import Iterator
from http import HTTPStatus
from typing import IO, Any
from uuid import uuid4

import httpx
import pytest

from arena_subject import __main__ as subject_main
from arena_subject.app import PORT
from tools.tests.subprocess_support import good_env, popen_role_module, refusal_cases, run_role_module, with_overrides

ROLE = "subject"
MODULE = "arena_subject"
OWN_DSN_VAR = "ARENA_SUBJECT_DSN"
# ARENA_MODEL_MODE=fake: state_from_env() builds the agent port's adapter at startup (S5 10.4), and these
# tests never reach Vertex (D-012's "zero spend in tests" extends to boot, not only to a served request).
GOOD_ENV = {**good_env(ROLE, OWN_DSN_VAR), "ARENA_MODEL_MODE": "fake"}
STARTUP_TIMEOUT_S = 10.0
SHUTDOWN_TIMEOUT_S = 10.0


def _lines_before(stream: IO[str], deadline: float) -> Iterator[str]:
    """Every complete line the child writes before the monotonic `deadline`, so a hung child can never
    block this test forever.

    Reads raw bytes off `stream`'s own file descriptor with `os.read`, never through
    `TextIOWrapper.readline()`: a selector only knows whether the OS-level fd has *new* bytes, but
    `readline()` can pull more than one line into the `TextIOWrapper`'s own internal buffer in a single
    underlying read - a second, already-complete line can then sit there, invisible to the next
    `select()` call, which reports not-ready and the deadline expires even though a line was available
    the whole time (reproduced with this test's real 10s timeout, not only a contrived short one: a
    later `select()` can genuinely time out while a prior `readline()`-style call already has a full
    line buffered). Keeping an explicit byte buffer here and never touching `stream`'s own read methods
    avoids that race entirely; `stream.read()` is still safe to call afterwards (nothing has drained its
    internal buffer, since nothing has called into it)."""
    fd = stream.fileno()
    sel = selectors.DefaultSelector()
    sel.register(fd, selectors.EVENT_READ)
    buf = b""
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not sel.select(timeout=remaining):
                if buf:
                    yield buf.decode("utf-8", errors="replace")
                return
            chunk = os.read(fd, 65536)
            if not chunk:  # EOF: the process exited (or closed the pipe) before the deadline
                if buf:
                    yield buf.decode("utf-8", errors="replace")
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                yield line.decode("utf-8", errors="replace") + "\n"
    finally:
        sel.close()


def test_boots_clean_and_serves_until_signalled_then_shuts_down_gracefully() -> None:
    """Uvicorn's own SIGTERM handling runs the graceful-shutdown sequence to completion and then lets the
    signal finish terminating the process (the merged output shows "Application shutdown complete" before
    the wait below observes -SIGTERM, the correct, Unix-idiomatic outcome for a caught, handled,
    then-honoured signal - not a hard kill). A real, unauthenticated HTTP request over the actual socket
    proves this is the real app with its real route - not merely that something is listening - before the
    signal is sent; the Host check passes because the request's own target IS 127.0.0.1:8081, so httpx
    sends exactly that Host by construction."""
    proc = popen_role_module(MODULE, GOOD_ENV)
    assert proc.stdout is not None
    try:
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        lines: list[str] = []
        ready = False
        for line in _lines_before(proc.stdout, deadline):
            lines.append(line)
            if "Uvicorn running on" in line:
                ready = True
                break
        seen = "".join(lines)
        assert ready, (seen, proc.poll())
        assert "boot checks passed" in seen, seen

        resp = httpx.post(
            f"http://127.0.0.1:{PORT}/internal/answer",
            json={"trial": str(uuid4()), "work_item": str(uuid4())},
            timeout=5.0,
        )
        assert resp.status_code == HTTPStatus.UNAUTHORIZED

        proc.send_signal(signal.SIGTERM)
        returncode = proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
        seen += proc.stdout.read()
        assert returncode == -signal.SIGTERM, seen
        assert "Application shutdown complete" in seen
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
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


def test_main_calls_uvicorn_run_with_the_bound_app_host_and_port_in_process(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`main()`'s own wiring, without actually serving: `uvicorn.run` is stubbed, so this proves the call
    arguments and the startup message without blocking the test process."""
    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    calls: list[dict[str, Any]] = []

    def fake_run(app: object, *, host: str, port: int, log_level: str) -> None:
        calls.append({"app": app, "host": host, "port": port, "log_level": log_level})

    monkeypatch.setattr("arena_subject.__main__.uvicorn.run", fake_run)
    assert subject_main.main() == 0
    assert "boot checks passed" in capsys.readouterr().out
    assert len(calls) == 1
    assert (calls[0]["host"], calls[0]["port"]) == ("127.0.0.1", PORT)


def test_main_exits_1_in_process_on_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", {**GOOD_ENV, "GEMINI_API_KEY": "fake-value"})
    with pytest.raises(SystemExit) as exc_info:
        subject_main.main()
    assert exc_info.value.code == 1
