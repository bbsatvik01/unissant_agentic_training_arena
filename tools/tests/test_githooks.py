"""tools/githooks: install.sh installs a shim that runs the tracked hook, never clobbers a foreign hook, and
fails closed; the tracked pre-commit hook refuses to run without its pinned gitleaks. Adapted from TechnoMile
tools/tests/test_githooks_pre_push.py (ATTRIBUTIONS.md): the pre-push audit cases arrive with WP-33."""

import os
import shutil
import subprocess
from pathlib import Path

from tools.tests.conftest import REPO_ROOT, git_init

# The hooks must land in the scratch repository, never in a hooks directory a developer's global or system
# git config points at (core.hooksPath).
ISOLATED_GIT = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def kit_repo(tmp_path: Path) -> Path:
    git_init(tmp_path)
    (tmp_path / "tools" / "githooks").mkdir(parents=True)
    for name in ("install.sh", "pre-commit"):
        shutil.copy2(REPO_ROOT / "tools" / "githooks" / name, tmp_path / "tools" / "githooks" / name)
    (tmp_path / ".git" / "hooks" / "pre-commit").unlink(missing_ok=True)  # a git init template hook, if any
    return tmp_path


def install(repo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", "tools/githooks/install.sh"], cwd=repo, capture_output=True, text=True, check=False
    )


def test_install_writes_a_shim_that_runs_the_tracked_hook(tmp_path: Path) -> None:
    repo = kit_repo(tmp_path)
    assert install(repo).returncode == 0
    shim = (repo / ".git" / "hooks" / "pre-commit").read_text()
    assert "arena-githooks-shim" in shim
    assert 'tracked="$top/tools/githooks/pre-commit"' in shim
    assert install(repo).returncode == 0, "re-running the installer over its own shim is allowed"


def test_install_refuses_to_replace_a_foreign_hook(tmp_path: Path) -> None:
    repo = kit_repo(tmp_path)
    foreign = repo / ".git" / "hooks" / "pre-commit"
    foreign.write_text("#!/bin/sh\necho someone else's hook\n")
    result = install(repo)
    assert result.returncode == 1
    assert "is not ours" in result.stderr
    assert "someone else's hook" in foreign.read_text()


def test_the_shim_blocks_when_the_kit_is_present_but_its_hook_is_missing(tmp_path: Path) -> None:
    repo = kit_repo(tmp_path)
    assert install(repo).returncode == 0
    (repo / "tools" / "githooks" / "pre-commit").unlink()
    result = subprocess.run(
        ["/bin/bash", ".git/hooks/pre-commit"], cwd=repo, capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "pre-commit blocked" in result.stderr


def test_pre_commit_fails_closed_without_the_pinned_gitleaks(tmp_path: Path) -> None:
    repo = kit_repo(tmp_path)
    result = subprocess.run(
        ["/bin/bash", "tools/githooks/pre-commit"],
        cwd=repo,
        env=ISOLATED_GIT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "gitleaks missing; run make bootstrap" in result.stderr
