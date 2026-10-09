"""S5 1.4: `python -m arena_referee` runs the boot checks as a real process."""

from tools.tests.subprocess_support import run_role_module

GOOD_ENV = {
    "PATH": "/usr/bin:/bin",
    "ARENA_ROLE": "referee",
    "ARENA_GCP_PROJECT": "arena-dev-000000",
    "ARENA_REFEREE_DSN": "postgresql://referee@127.0.0.1/arena",
    "ARENA_ENV": "local",
}


def test_boots_clean_and_exits_0() -> None:
    result = run_role_module("arena_referee", GOOD_ENV)
    assert result.returncode == 0, result.stderr
    assert "boot checks passed" in result.stdout


def test_wrong_dsn_exits_nonzero() -> None:
    bad = {**GOOD_ENV, "ARENA_REFEREE_DSN": "", "ARENA_PUBLIC_DSN": "postgresql://api@127.0.0.1/arena"}
    result = run_role_module("arena_referee", bad)
    assert result.returncode != 0
    assert "ARENA_REFEREE_DSN" in result.stderr


def test_kbg_production_exits_nonzero() -> None:
    bad = {**GOOD_ENV, "ARENA_GCP_PROJECT": "kbg-production"}
    result = run_role_module("arena_referee", bad)
    assert result.returncode != 0
    assert "kbg-production" in result.stderr
