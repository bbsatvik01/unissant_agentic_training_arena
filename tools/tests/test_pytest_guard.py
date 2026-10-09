"""Gate proofs: any skipped or xfailed test fails the pytest run, and so does a test file whose module was
shadowed by another file with the same import name (its tests would silently run someone else's code)."""

import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import cast

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


def _scratch_project(tmp_path: Path) -> list[str]:
    """A scratch project that loads the real guard through the real root conftest.py; returns pytest args."""
    (tmp_path / "tools").mkdir()
    shutil.copy(REPO_ROOT / "tools" / "pytest_guard.py", tmp_path / "tools" / "pytest_guard.py")
    (tmp_path / "tools" / "__init__.py").write_text("")
    shutil.copy(REPO_ROOT / "conftest.py", tmp_path / "conftest.py")
    return ["-q", "-p", "no:cacheprovider", "--import-mode=importlib", "--rootdir", str(tmp_path), "-o", "pythonpath=."]


def test_unwanted_counts_only_skip_like_outcomes() -> None:
    stats: dict[str, list[object]] = {"passed": [1, 2], "skipped": [1], "xfailed": [1, 2]}
    assert pytest_guard.unwanted(stats) == {"skipped": 1, "xfailed": 2}
    assert pytest_guard.unwanted({"passed": [1]}) == {}


def _item(path: Path, defined_in: Path) -> pytest.Item:
    return cast(pytest.Item, SimpleNamespace(path=path, module=SimpleNamespace(__file__=str(defined_in))))


def test_shadowed_names_a_file_that_ran_another_files_tests(tmp_path: Path) -> None:
    first, second = tmp_path / "api" / "test_main.py", tmp_path / "subject" / "test_main.py"
    assert pytest_guard.shadowed([_item(first, first), _item(second, second)]) == []
    assert pytest_guard.shadowed([_item(first, first), _item(second, first)]) == [f"{second} ran the tests of {first}"]


@pytest.mark.gateproof
def test_a_runtime_skip_fails_the_session(tmp_path: Path) -> None:
    args = _scratch_project(tmp_path)
    (tmp_path / "test_probe.py").write_text(SKIP_BY_EXCEPTION)
    result = proc.run("pytest", [*args, str(tmp_path)], cwd=tmp_path)
    assert result.returncode == pytest.ExitCode.TESTS_FAILED, result.stdout
    assert "pytest_guard: FAIL" in result.stdout


@pytest.mark.gateproof
def test_a_shadowed_test_module_fails_the_session(tmp_path: Path) -> None:
    """Two `tests` packages each holding test_main.py share the import name `tests.test_main` under
    --import-mode=importlib; without the guard the second file's tests silently run the first file's code."""
    args = _scratch_project(tmp_path)
    for role in ("api", "subject"):
        tests = tmp_path / "services" / role / "tests"
        tests.mkdir(parents=True)
        (tests / "__init__.py").write_text("")
        (tests / "test_main.py").write_text(f"ROLE = '{role}'\n\n\ndef test_role() -> None:\n    assert ROLE\n")
    result = proc.run("pytest", [*args, str(tmp_path / "services")], cwd=tmp_path)
    assert result.returncode != pytest.ExitCode.OK, result.stdout
    assert "pytest_guard: FAIL" in result.stdout + result.stderr
    assert "services/subject/tests/test_main.py" in result.stdout + result.stderr


def test_distinct_test_modules_pass(tmp_path: Path) -> None:
    args = _scratch_project(tmp_path)
    for role in ("api", "subject"):
        tests = tmp_path / "services" / role / "tests"
        tests.mkdir(parents=True)
        (tests / "test_main.py").write_text(f"ROLE = '{role}'\n\n\ndef test_role() -> None:\n    assert ROLE\n")
    result = proc.run("pytest", [*args, str(tmp_path / "services")], cwd=tmp_path)
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert "2 passed" in result.stdout


def test_this_repository_collects_every_test_file_as_its_own_module() -> None:
    result = proc.run("pytest", ["-q", "-p", "no:cacheprovider", "--collect-only"], cwd=REPO_ROOT)
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert "pytest_guard: FAIL" not in result.stdout


# ---------------------------------------------------------------- the full gate collects everything (Codex round 7)
# Under --full-gate (the Makefile's `test` recipe) a run that selects fewer tests than the test roots hold
# fails: a selection option (-k, -m, --deselect, --ignore, --last-failed, --stepwise), a deselected item, or a
# test file on disk that was never collected (conftest collect_ignore, a pytest_ignore_collect hook).
TWO_TESTS = "def test_one() -> None:\n    assert True\n\n\ndef test_two() -> None:\n    assert 1 == 2\n"


def _full_gate_project(tmp_path: Path) -> list[str]:
    args = _scratch_project(tmp_path)
    (tmp_path / "test_a.py").write_text(TWO_TESTS.replace("1 == 2", "2 == 2"))
    return [*args, "-o", "testpaths=.", "--full-gate"]


def test_a_full_gate_run_that_collects_everything_passes(tmp_path: Path) -> None:
    result = proc.run("pytest", _full_gate_project(tmp_path), cwd=tmp_path)
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert "2 passed" in result.stdout


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "selection",
    [
        ["--deselect", "test_b.py::test_two"],
        ["-k", "not test_two"],
        ["-m", "not slow"],
        ["--ignore", "test_b.py"],
        ["--ignore-glob", "*_b.py"],
    ],
)
def test_a_full_gate_run_that_drops_a_failing_test_fails(tmp_path: Path, selection: list[str]) -> None:
    args = _full_gate_project(tmp_path)
    (tmp_path / "test_b.py").write_text(TWO_TESTS)
    result = proc.run("pytest", [*args, *selection], cwd=tmp_path)
    assert result.returncode != pytest.ExitCode.OK, result.stdout + result.stderr
    assert "pytest_guard: FAIL" in result.stdout + result.stderr


@pytest.mark.gateproof
def test_a_test_file_a_conftest_hides_fails_the_full_gate(tmp_path: Path) -> None:
    args = _full_gate_project(tmp_path)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "test_hidden.py").write_text(TWO_TESTS)
    (tmp_path / "sub" / "conftest.py").write_text('collect_ignore = ["test_hidden.py"]\n')
    result = proc.run("pytest", args, cwd=tmp_path)
    assert result.returncode != pytest.ExitCode.OK, result.stdout + result.stderr
    assert "sub/test_hidden.py" in result.stdout + result.stderr
