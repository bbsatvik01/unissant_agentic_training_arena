"""S5 1.4 for `python -m arena_api`: the boot checks run as a real process (each refusal exits 1 before any server
starts), and `main()` in process serves the app on 127.0.0.1:8080 (uvicorn stubbed, so the test never blocks)."""

from __future__ import annotations

from typing import Any

import pytest

from arena_api import __main__ as api_main
from arena_api.state import PORT
from tools.tests.subprocess_support import good_env, refusal_cases, run_role_module, with_overrides

ROLE = "api"
MODULE = "arena_api"
OWN_DSN_VAR = "ARENA_PUBLIC_DSN"
GOOD_ENV = {**good_env(ROLE, OWN_DSN_VAR), "ARENA_MODEL_MODE": "fake"}


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
