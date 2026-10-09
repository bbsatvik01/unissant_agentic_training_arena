"""The single subprocess call site refuses unknown tools and fails closed on missing ones."""

from pathlib import Path

import pytest

from tools import proc


def test_unknown_tool_is_refused() -> None:
    with pytest.raises(ValueError, match="not an allowed gate tool"):
        proc.run("sh", ["-c", "true"])


def test_missing_pinned_binary_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setitem(proc.PINNED_BINARIES, "gitleaks", tmp_path / "absent")
    with pytest.raises(proc.ToolNotFoundError, match="make bootstrap"):
        proc.resolve("gitleaks")


def test_tool_missing_from_path_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tools.proc.shutil.which", lambda _name: None)
    with pytest.raises(proc.ToolNotFoundError, match="not on PATH"):
        proc.resolve("git")


def test_run_resolves_to_an_absolute_path_and_captures_output() -> None:
    result = proc.run("git", ["--version"])
    assert Path(result.args[0]).is_absolute()
    assert result.returncode == 0
    assert result.stdout.startswith("git version")
