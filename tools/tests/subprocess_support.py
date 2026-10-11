"""Shared boot-check contract for the four role entry points (S5 1.4: the acceptance criteria are phrased
as "starting" a process, so each role is started as a real ``python -m <package>`` subprocess).

Every role's ``tests/test_main.py`` runs ``refusal_cases(role, own_dsn_var)`` against its own entry
point, so the same refusals are proven for api, subject, referee and tournament, not for one role only.
"""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ROLE_DSN_VARS = ("ARENA_PUBLIC_DSN", "ARENA_SUBJECT_DSN", "ARENA_REFEREE_DSN")
# The child gets exactly this environment plus the case's overrides: no ambient variable (a DSN or an
# API key exported in the developer's shell) can leak in and change the outcome.
BASE_ENV = {"PATH": "/usr/bin:/bin", "ARENA_GCP_PROJECT": "cna-guardian", "ARENA_ENV": "local"}


def good_env(role: str, own_dsn_var: str) -> dict[str, str]:
    return {**BASE_ENV, "ARENA_ROLE": role, own_dsn_var: f"postgresql://{role}@127.0.0.1/arena"}


def refusal_cases(role: str, own_dsn_var: str) -> list[tuple[str, dict[str, str | None], str]]:
    """(case id, env overrides (None deletes), text stderr must contain) for every S5 1.3/1.4 refusal."""
    other_role = "subject" if role != "subject" else "api"
    cases: list[tuple[str, dict[str, str | None], str]] = [
        (f"extra-{var}", {var: "postgresql://other@127.0.0.1/arena"}, var)
        for var in ROLE_DSN_VARS
        if var != own_dsn_var
    ]
    cases += [
        ("owner-dsn", {"ARENA_OWNER_DSN": "postgresql://postgres@127.0.0.1/arena"}, "ARENA_OWNER_DSN"),
        ("own-dsn-missing", {own_dsn_var: None}, f"{own_dsn_var} is not set"),
        ("gemini-api-key", {"GEMINI_API_KEY": "fake-value"}, "D-001"),
        ("google-api-key", {"GOOGLE_API_KEY": "fake-value"}, "D-001"),
        ("kbg-production", {"ARENA_GCP_PROJECT": "kbg-production"}, "D-015"),
        ("ai-studio-project", {"ARENA_GCP_PROJECT": "gen-lang-client-0635695834"}, "D-015"),
        ("padded-project", {"ARENA_GCP_PROJECT": " cna-guardian\n"}, "D-015"),
        ("arbitrary-project", {"ARENA_GCP_PROJECT": "arena-dev-000000"}, "D-015"),
        ("project-missing", {"ARENA_GCP_PROJECT": None}, "ARENA_GCP_PROJECT is not set"),
        ("non-loopback-bind", {"ARENA_BIND_HOST": "10.1.2.3"}, "loopback bind address"),
        ("all-interfaces-bind", {"ARENA_BIND_HOST": "::"}, "loopback bind address"),
        ("local-on-cloud-run", {"K_SERVICE": f"arena-{role}"}, "K_SERVICE"),
        ("unknown-env", {"ARENA_ENV": "staging"}, "ARENA_ENV must be one of"),
        ("role-mismatch", {"ARENA_ROLE": other_role}, "does not match this process"),
    ]
    return cases


def with_overrides(env: dict[str, str], overrides: dict[str, str | None]) -> dict[str, str]:
    merged = dict(env)
    for key, value in overrides.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def run_role_module(module: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run ``python -m <module>`` with a fully caller-controlled environment.

    argv is fixed shape (the running interpreter, ``-m``, a caller-given module name); there is no
    shell, cwd is pinned to the repo root, and env is fully replaced by the caller (no ambient
    credential leaks in) -- this is the one reviewed subprocess call site for these tests
    (tools/proc.py has no env parameter by design: the gate tools always inherit the gate's environment).
    """
    # S603 false positive: argv is [sys.executable, "-m", <module constant from the role test>], no shell, no
    # untrusted input; the allowlist entry in tools/gates/suppressions-allowlist.toml carries the reason.
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", module], cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=False
    )


def popen_role_module(module: str, env: dict[str, str]) -> subprocess.Popen[str]:
    """The same fixed-shape, caller-controlled launch as `run_role_module`, but non-blocking: for a role
    whose `main()` serves once its boot checks pass (S5 10.1) and so never exits on its own, the caller
    reads its startup line, then signals it (`popen_role_module(...).terminate()`) and waits with a
    timeout, instead of blocking forever on `subprocess.run`. stderr is merged into stdout (uvicorn logs
    its own startup and shutdown lines there) so the caller reads one ordered stream, never two pipes at
    once without a selector or a thread."""
    # S603 false positive: same argv shape as run_role_module, reviewed there; the allowlist entry covers
    # this call too (same file, same pattern).
    return subprocess.Popen(  # noqa: S603
        [sys.executable, "-m", module],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
