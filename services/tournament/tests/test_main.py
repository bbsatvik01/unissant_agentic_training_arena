"""S5 1.4 for `python -m arena_tournament`: the boot checks run as a real process, and `main()` in process.

The refusal cases are shared with the other three roles (tools/tests/subprocess_support.py), so every
role proves the same S5 1.3 refusals against its own entry point.
"""

import pytest

from arena_tournament.__main__ import main
from tools.tests.subprocess_support import good_env, refusal_cases, run_role_module, with_overrides

ROLE = "tournament"
MODULE = "arena_tournament"
OWN_DSN_VAR = "ARENA_PUBLIC_DSN"
GOOD_ENV = good_env(ROLE, OWN_DSN_VAR)


def test_boots_clean_as_a_process_and_exits_0() -> None:
    result = run_role_module(MODULE, GOOD_ENV)
    assert result.returncode == 0, result.stderr
    assert "boot checks passed" in result.stdout


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


def test_main_returns_0_in_process(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    assert main() == 0
    assert "boot checks passed" in capsys.readouterr().out


def test_main_exits_1_in_process_on_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("os.environ", {**GOOD_ENV, "GEMINI_API_KEY": "fake-value"})
    with pytest.raises(SystemExit) as exc_info:
        main()
    assert exc_info.value.code == 1
