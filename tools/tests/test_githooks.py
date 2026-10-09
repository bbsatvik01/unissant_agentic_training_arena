"""tools/githooks: install.sh installs a shim that runs the tracked hook, never clobbers a foreign hook, and
fails closed; the tracked pre-commit hook refuses to run without its pinned gitleaks. Adapted from TechnoMile
tools/tests/test_githooks_pre_push.py (ATTRIBUTIONS.md): the pre-push audit cases arrive with WP-33.

Every git command here, including the scratch repository's `git init`, runs with the developer's global and
system git configuration switched off, so a configured core.hooksPath or init.templateDir can neither
receive a hook nor change an outcome (Codex round 2, finding 4)."""

import os
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path

from tools.tests.conftest import REPO_ROOT


def isolated(env: Mapping[str, str]) -> dict[str, str]:
    """``env`` with every global and system git configuration file switched off."""
    return {**env, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


ISOLATED_GIT = isolated(os.environ)


def kit_repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["/usr/bin/git", "init", "-q", "-b", "main"], cwd=root, env=ISOLATED_GIT, check=True)
    (root / "tools" / "githooks").mkdir(parents=True)
    for name in ("install.sh", "pre-commit"):
        shutil.copy2(REPO_ROOT / "tools" / "githooks" / name, root / "tools" / "githooks" / name)
    return root


def install(repo: Path, env: Mapping[str, str] = ISOLATED_GIT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/bash", "tools/githooks/install.sh"], cwd=repo, env=env, capture_output=True, text=True, check=False
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
        ["/bin/bash", ".git/hooks/pre-commit"], cwd=repo, env=ISOLATED_GIT, capture_output=True, text=True, check=False
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


def test_a_hooks_directory_from_the_developers_global_config_stays_untouched(tmp_path: Path) -> None:
    external = tmp_path / "external-hooks"
    external.mkdir()
    global_config = tmp_path / "gitconfig"
    global_config.write_text(f"[core]\n\thooksPath = {external}\n")
    developer_env = {**os.environ, "GIT_CONFIG_GLOBAL": str(global_config), "GIT_CONFIG_NOSYSTEM": "1"}
    repo = kit_repo(tmp_path / "repo")
    # The hazard is real: without isolation the installer follows core.hooksPath out of the repository.
    assert install(repo, developer_env).returncode == 0
    assert (external / "pre-commit").is_file()
    (external / "pre-commit").unlink()
    # The isolation every test here uses keeps the hook inside the scratch repository.
    assert install(repo, isolated(developer_env)).returncode == 0
    assert list(external.iterdir()) == []
    assert "arena-githooks-shim" in (repo / ".git" / "hooks" / "pre-commit").read_text()


def test_every_tools_test_runs_git_without_the_developers_configuration() -> None:
    """tools/tests/conftest.py switches global and system git config off for the whole session."""
    assert os.environ["GIT_CONFIG_GLOBAL"] == os.devnull
    assert os.environ["GIT_CONFIG_NOSYSTEM"] == "1"
