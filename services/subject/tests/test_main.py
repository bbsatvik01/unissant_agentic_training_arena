"""S5 1.4 for `python -m arena_subject`: the boot checks run as a real process, and a clean environment
actually serves `/internal/answer` (S5 10.1) until signalled, not just "exits 0".

The refusal cases are shared with the other three roles (tools/tests/subprocess_support.py), so every
role proves the same S5 1.3 refusals against its own entry point; they still exit promptly, because
`boot()` (inside `state_from_env`) calls `sys.exit(1)` before `main()` ever reaches `uvicorn.run`.
"""

from __future__ import annotations

import signal
from typing import Any

import pytest

from arena_subject import __main__ as subject_main
from tools.tests.subprocess_support import good_env, popen_role_module, refusal_cases, run_role_module, with_overrides

ROLE = "subject"
MODULE = "arena_subject"
OWN_DSN_VAR = "ARENA_SUBJECT_DSN"
# ARENA_MODEL_MODE=fake: state_from_env() builds the agent port's adapter at startup (S5 10.4), and these
# tests never reach Vertex (D-012's "zero spend in tests" extends to boot, not only to a served request).
GOOD_ENV = {**good_env(ROLE, OWN_DSN_VAR), "ARENA_MODEL_MODE": "fake"}
SHUTDOWN_TIMEOUT_S = 10.0


def test_boots_clean_and_serves_until_signalled_then_shuts_down_gracefully() -> None:
    """Uvicorn's own SIGTERM handling runs the graceful-shutdown sequence to completion and then lets the
    signal finish terminating the process (the merged output shows "Application shutdown complete" before
    the wait below observes -SIGTERM, the correct, Unix-idiomatic outcome for a caught, handled,
    then-honoured signal - not a hard kill). The signal is sent only once uvicorn itself reports it is
    serving (not merely once this process's own pre-serve line has printed), or its handlers may not be
    installed yet."""
    proc = popen_role_module(MODULE, GOOD_ENV)
    assert proc.stdout is not None
    try:
        lines: list[str] = []
        for _ in range(200):  # readline blocks; the loop itself is bounded by the process's own timeout below
            line = proc.stdout.readline()
            if not line:
                break
            lines.append(line)
            if "Uvicorn running on" in line:
                break
        seen = "".join(lines)
        assert "boot checks passed" in seen, seen
        assert "Uvicorn running on" in seen, seen
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
    assert (calls[0]["host"], calls[0]["port"]) == ("127.0.0.1", subject_main.PORT)


def test_main_exits_1_in_process_on_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", {**GOOD_ENV, "GEMINI_API_KEY": "fake-value"})
    with pytest.raises(SystemExit) as exc_info:
        subject_main.main()
    assert exc_info.value.code == 1
