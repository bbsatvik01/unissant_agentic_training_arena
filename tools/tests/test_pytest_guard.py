"""Gate proof: any skipped or xfailed test fails the pytest run."""

import shutil
from pathlib import Path

import pytest

from tools import proc, pytest_guard
from tools.tests.conftest import REPO_ROOT

FIXTURES = Path(__file__).parent / "fixtures" / "suppressions.tsv"
RAISE_SKIP = next(
    line.split("\t", 1)[1]
    for line in FIXTURES.read_text().splitlines()
    if line.startswith("unittest-skip\traise unittest")
)
SKIP_BY_EXCEPTION = f"import unittest\n\n\ndef test_hidden() -> None:\n    {RAISE_SKIP}\n"


def test_unwanted_counts_only_skip_like_outcomes() -> None:
    stats: dict[str, list[object]] = {"passed": [1, 2], "skipped": [1], "xfailed": [1, 2]}
    assert pytest_guard.unwanted(stats) == {"skipped": 1, "xfailed": 2}
    assert pytest_guard.unwanted({"passed": [1]}) == {}


@pytest.mark.gateproof
def test_a_runtime_skip_fails_the_session(tmp_path: Path) -> None:
    (tmp_path / "tools").mkdir()
    shutil.copy(REPO_ROOT / "tools" / "pytest_guard.py", tmp_path / "tools" / "pytest_guard.py")
    (tmp_path / "tools" / "__init__.py").write_text("")
    shutil.copy(REPO_ROOT / "conftest.py", tmp_path / "conftest.py")
    (tmp_path / "test_probe.py").write_text(SKIP_BY_EXCEPTION)
    args = ["-q", "-p", "no:cacheprovider", "--rootdir", str(tmp_path), "-o", "pythonpath=.", str(tmp_path)]
    result = proc.run("pytest", args, cwd=tmp_path)
    assert result.returncode == pytest.ExitCode.TESTS_FAILED, result.stdout
    assert "pytest_guard: FAIL" in result.stdout
