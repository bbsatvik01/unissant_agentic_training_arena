"""tools/ensure_tools.sh refuses an unknown tool name before touching the cache or .tools/bin, and the
Makefile's SYNC_TOOLS selection reaches it (the CI gitleaks job installs only gitleaks)."""

import os
import subprocess
from pathlib import Path

from tools import proc
from tools.tests.conftest import REPO_ROOT


def test_an_unknown_tool_name_fails_closed_without_side_effects(tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    env = {**os.environ, "ARENA_TOOLS_CACHE": str(cache)}
    result = subprocess.run(
        ["/bin/bash", "tools/ensure_tools.sh", "gitleaks", "not-a-tool"],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "unknown tool 'not-a-tool'" in result.stderr
    assert not cache.exists()


def test_make_tools_sync_passes_the_selection_through() -> None:
    result = proc.run("make", ["-f", str(REPO_ROOT / "Makefile"), "tools-sync", "SYNC_TOOLS=not-a-tool"], cwd=REPO_ROOT)
    assert result.returncode != 0
    assert "unknown tool 'not-a-tool'" in result.stderr
