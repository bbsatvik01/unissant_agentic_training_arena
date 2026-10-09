"""tools/ci_base_ref.sh: CI compares a change with the state before it, per event (Codex round 1, finding 5:
`origin/main` on a push to main is HEAD itself, so push-clean and the ratchet compared HEAD with HEAD)."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT, git_commit_all, git_init

ZERO_SHA = "0" * 40


def scratch_history(tmp_path: Path) -> list[str]:
    """Three commits; returns their SHAs oldest first. The script is copied in at a fixed relative path."""
    git_init(tmp_path)
    shas = []
    for n in range(3):
        (tmp_path / f"f{n}.txt").write_text(f"{n}\n")
        git_commit_all(tmp_path, f"c{n}")
        shas.append(proc.run("git", ["-C", str(tmp_path), "rev-parse", "HEAD"], check=True).stdout.strip())
    shutil.copy(REPO_ROOT / "tools" / "ci_base_ref.sh", tmp_path / "ci_base_ref.sh")
    return shas


def base_ref(repo: Path, **env: str) -> subprocess.CompletedProcess[str]:
    clean = {k: v for k, v in os.environ.items() if k not in {"GITHUB_EVENT_NAME", "PR_BASE_SHA", "PUSH_BEFORE_SHA"}}
    return subprocess.run(
        ["/bin/bash", "ci_base_ref.sh"], cwd=repo, env={**clean, **env}, capture_output=True, text=True, check=False
    )


@pytest.mark.gateproof
def test_a_push_compares_with_the_tip_before_the_push_not_with_head(tmp_path: Path) -> None:
    _, c1, c2 = scratch_history(tmp_path)
    result = base_ref(tmp_path, GITHUB_EVENT_NAME="push", PUSH_BEFORE_SHA=c1)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == c1
    assert result.stdout.strip() != c2


def test_a_pull_request_compares_with_its_base_commit(tmp_path: Path) -> None:
    c0, _, _ = scratch_history(tmp_path)
    result = base_ref(tmp_path, GITHUB_EVENT_NAME="pull_request", PR_BASE_SHA=c0)
    assert (result.returncode, result.stdout.strip()) == (0, c0)


@pytest.mark.parametrize(
    "env",
    [
        {"GITHUB_EVENT_NAME": "push", "PUSH_BEFORE_SHA": ZERO_SHA},
        {"GITHUB_EVENT_NAME": "push", "PUSH_BEFORE_SHA": ""},
        {"GITHUB_EVENT_NAME": "workflow_dispatch"},
    ],
)
def test_a_first_push_or_a_manual_run_compares_with_the_root_commit(tmp_path: Path, env: dict[str, str]) -> None:
    c0, _, _ = scratch_history(tmp_path)
    result = base_ref(tmp_path, **env)
    assert (result.returncode, result.stdout.strip()) == (0, c0)


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "env",
    [
        {"GITHUB_EVENT_NAME": "push", "PUSH_BEFORE_SHA": "1" * 40},
        {"GITHUB_EVENT_NAME": "pull_request", "PR_BASE_SHA": "1" * 40},
        {"GITHUB_EVENT_NAME": "pull_request"},
    ],
)
def test_an_unknown_or_missing_base_fails_closed(tmp_path: Path, env: dict[str, str]) -> None:
    scratch_history(tmp_path)
    result = base_ref(tmp_path, **env)
    assert result.returncode != 0
    assert result.stdout.strip() == ""
