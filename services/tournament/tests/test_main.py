"""S5 1.4 for `python -m arena_tournament`: the boot checks run as a real process, and `main()` in process.

The refusal cases are shared with the other three roles (tools/tests/subprocess_support.py), so every
role proves the same S5 1.3 refusals against its own entry point. `run <id>`'s own dispatch (S5 5.3;
WP-17) is proven here with `run_tournament` stubbed (a real run is it_tournament.py's job, against a real
database); this file only proves `__main__.main`'s own argv wiring.
"""

from collections.abc import Mapping
from uuid import UUID, uuid4

import pytest

import arena_tournament.__main__ as tournament_main
from arena_tournament.__main__ import main
from arena_tournament.runner import RunSummary
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


def test_main_run_dispatches_to_run_tournament_and_prints_the_summary(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tournament_id = uuid4()
    seen: list[tuple[Mapping[str, str], UUID]] = []

    async def fake_run_tournament(env: Mapping[str, str], tid: UUID) -> RunSummary:
        seen.append((env, tid))
        return RunSummary(tournament_id=tid, outcomes={"completed": 6}, closed=True)

    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    monkeypatch.setattr(tournament_main, "run_tournament", fake_run_tournament)
    assert main(["run", str(tournament_id)]) == 0
    out = capsys.readouterr().out
    assert f"tournament {tournament_id} closed" in out
    assert "outcomes {'completed': 6}" in out
    assert seen == [(dict(GOOD_ENV), tournament_id)]


USAGE_EXIT = 2  # __main__.main's own usage-error return code


@pytest.mark.parametrize("bad_argv", [["run"], ["run", str(uuid4()), "extra"], ["serve", str(uuid4())], ["bogus"]])
def test_main_usage_for_an_unrecognized_argv_shape(bad_argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    assert main(bad_argv) == USAGE_EXIT
    assert "usage: python -m arena_tournament" in capsys.readouterr().err


def test_main_run_exits_1_and_says_so_when_blocks_are_left_unscored(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tournament_id = uuid4()

    async def fake_run_tournament(_env: Mapping[str, str], tid: UUID) -> RunSummary:
        return RunSummary(tournament_id=tid, outcomes={"completed": 6}, closed=False)

    monkeypatch.setattr("os.environ", dict(GOOD_ENV))
    monkeypatch.setattr(tournament_main, "run_tournament", fake_run_tournament)
    assert main(["run", str(tournament_id)]) == 1
    out = capsys.readouterr().out
    assert f"tournament {tournament_id} not closed" in out
    assert "run it again" in out
