"""pytest plugin: a run with any skipped, xfailed or xpassed test fails (global hard gate: no skip/xfail).

Loaded for every test in the repo by the root conftest.py. The static no-rigging scan catches skip
markers in source; this catches every runtime path by outcome: a skip exception raised from a helper
or fixture, a conditional import skip, an expected-failure decorator, a missing optional dependency.

It also refuses a shadowed test module: under ``--import-mode=importlib`` two test files with the same
import name (``services/api/tests/test_main.py`` and ``services/subject/tests/test_main.py`` both become
``tests.test_main`` when their directories hold an ``__init__.py``) resolve to ONE module, so the second
file's tests silently run the first file's code. Each collected test must come from the file it is listed
under. Lifted from TechnoMile tools/pytest_guard.py (ATTRIBUTIONS.md); the shadowing check is this repo's.
"""

from pathlib import Path

import pytest

UNWANTED_OUTCOMES = ("skipped", "xfailed", "xpassed")


def unwanted(stats: dict[str, list[object]]) -> dict[str, int]:
    return {outcome: len(stats.get(outcome, [])) for outcome in UNWANTED_OUTCOMES if stats.get(outcome)}


def shadowed(items: list[pytest.Item]) -> list[str]:
    """Test files whose collected functions were defined in a different file (a module-name collision)."""
    found: set[str] = set()
    for item in items:
        module = getattr(item, "module", None)
        source = getattr(module, "__file__", None)
        if source is not None and Path(source).resolve() != Path(item.path).resolve():
            found.add(f"{item.path} ran the tests of {source}")
    return sorted(found)


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    problems = shadowed(items)
    if problems:
        msg = "pytest_guard: FAIL: shadowed test module(s), give each test file a unique import name: " + "; ".join(
            problems
        )
        raise pytest.UsageError(msg)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    stats: dict[str, list[object]] = getattr(reporter, "stats", {})
    found = unwanted(stats)
    if found and exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        if reporter is not None:
            reporter.write_line(
                f"pytest_guard: FAIL: {found}; skipped or expected-failure tests are not allowed", red=True
            )
