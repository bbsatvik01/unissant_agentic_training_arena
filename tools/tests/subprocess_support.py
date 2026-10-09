"""Shared helper for tests that boot a role's `python -m <module>` as a real subprocess (S5 1.4: the
boot-check acceptance criteria are phrased as "starting" a process, not calling a function)."""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def run_role_module(module: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run ``python -m <module>`` with a fully caller-controlled environment.

    argv is fixed shape (the running interpreter, ``-m``, a caller-given module name); there is no
    shell, cwd is pinned to the repo root, and env is fully replaced by the caller (no ambient
    credential leaks in) -- this is the one reviewed subprocess call site for these tests.
    """
    return subprocess.run(  # noqa: S603
        [sys.executable, "-m", module], cwd=REPO_ROOT, env=env, capture_output=True, text=True, check=False
    )
