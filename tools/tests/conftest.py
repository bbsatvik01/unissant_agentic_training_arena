"""Shared helpers for gate tests. Lifted from TechnoMile tools/tests/conftest.py (ATTRIBUTIONS.md); the
fake-gcloud helper stays behind until the hosted cost audit it serves arrives (WP-33), and git runs with
the developer's own configuration switched off (below)."""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from tools import proc

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True, scope="session")
def _no_developer_git_config() -> Iterator[None]:
    """Every git command these tests start (scratch repositories, make recipes, the gates themselves) runs
    without the developer's global and system git configuration: a core.hooksPath, an init.templateDir or a
    commit hook there can neither receive files nor run, nor change an outcome."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
        patch.setenv("GIT_CONFIG_NOSYSTEM", "1")
        yield


def git_init(root: Path) -> None:
    proc.run("git", ["init", "-q", "-b", "main", str(root)], check=True)


def git_commit_all(root: Path, message: str) -> None:
    proc.run("git", ["-C", str(root), "add", "-A"], check=True)
    identity = ["-c", "user.name=gate-test", "-c", "user.email=gate-test@example.invalid", "-c", "commit.gpgsign=false"]
    proc.run("git", ["-C", str(root), *identity, "commit", "-q", "-m", message], check=True)
