"""S5 1.4: `python -m arena_tournament` runs the boot checks as a real process."""

from tools.tests.subprocess_support import run_role_module

GOOD_ENV = {
    "PATH": "/usr/bin:/bin",
    "ARENA_ROLE": "tournament",
    "ARENA_GCP_PROJECT": "arena-dev-000000",
    "ARENA_PUBLIC_DSN": "postgresql://api@127.0.0.1/arena",
    "ARENA_ENV": "local",
}


def test_boots_clean_and_exits_0() -> None:
    result = run_role_module("arena_tournament", GOOD_ENV)
    assert result.returncode == 0, result.stderr
    assert "boot checks passed" in result.stdout


def test_role_mismatch_exits_nonzero() -> None:
    bad = {**GOOD_ENV, "ARENA_ROLE": "api"}
    result = run_role_module("arena_tournament", bad)
    assert result.returncode != 0
    assert "does not match this process" in result.stderr


def test_owner_dsn_exits_nonzero() -> None:
    bad = {**GOOD_ENV, "ARENA_OWNER_DSN": "postgresql://owner@127.0.0.1/arena"}
    result = run_role_module("arena_tournament", bad)
    assert result.returncode != 0
    assert "ARENA_OWNER_DSN" in result.stderr
