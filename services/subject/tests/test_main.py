"""S5 1.4: `python -m arena_subject` runs the boot checks as a real process."""

from tools.tests.subprocess_support import run_role_module

GOOD_ENV = {
    "PATH": "/usr/bin:/bin",
    "ARENA_ROLE": "subject",
    "ARENA_GCP_PROJECT": "arena-dev-000000",
    "ARENA_SUBJECT_DSN": "postgresql://subject@127.0.0.1/arena",
    "ARENA_ENV": "local",
}


def test_boots_clean_and_exits_0() -> None:
    result = run_role_module("arena_subject", GOOD_ENV)
    assert result.returncode == 0, result.stderr
    assert "boot checks passed" in result.stdout


def test_extra_credential_exits_nonzero_and_names_it() -> None:
    bad = {**GOOD_ENV, "ARENA_REFEREE_DSN": "postgresql://referee@127.0.0.1/arena"}
    result = run_role_module("arena_subject", bad)
    assert result.returncode != 0
    assert "ARENA_REFEREE_DSN" in result.stderr


def test_gemini_api_key_exits_nonzero() -> None:
    bad = {**GOOD_ENV, "GEMINI_API_KEY": "fake"}
    result = run_role_module("arena_subject", bad)
    assert result.returncode != 0
    assert "D-001" in result.stderr


def test_hosted_marker_refuses_local_env() -> None:
    bad = {**GOOD_ENV, "K_SERVICE": "arena-subject"}
    result = run_role_module("arena_subject", bad)
    assert result.returncode != 0
    assert "K_SERVICE" in result.stderr
