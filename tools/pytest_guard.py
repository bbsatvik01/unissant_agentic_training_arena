"""pytest plugin: a run with any skipped, xfailed or xpassed test fails (global hard gate: no skip/xfail).

Loaded for every test in the repo by the root conftest.py. The static no-rigging scan catches skip
markers in source; this catches every runtime path by outcome: a skip exception raised from a helper
or fixture, a conditional import skip, an expected-failure decorator, a missing optional dependency.

It also refuses a shadowed test module: under ``--import-mode=importlib`` two test files with the same
import name (``services/api/tests/test_main.py`` and ``services/subject/tests/test_main.py`` both become
``tests.test_main`` when their directories hold an ``__init__.py``) resolve to ONE module, so the second
file's tests silently run the first file's code. Each collected test must come from the file it is listed
under. Lifted from TechnoMile tools/pytest_guard.py (ATTRIBUTIONS.md); the shadowing check is this repo's.

Under ``--full-gate`` (the Makefile's ``test`` recipe) the run must collect every test the test roots hold: a
selection option (``-k``, ``-m``, ``--deselect``, ``--ignore``, ``--ignore-glob``, ``--last-failed``,
``--stepwise``), any deselected item, or a test file on disk under ``testpaths`` that no item came from (a
conftest ``collect_ignore``, a ``pytest_ignore_collect`` hook) fails the session. A narrowed local run without
the flag stays allowed.
"""

from pathlib import Path

import pytest

UNWANTED_OUTCOMES = ("skipped", "xfailed", "xpassed")
FULL_GATE = "--full-gate"
# Option dest -> the flag that narrows collection when it is set.
NARROWING_OPTIONS = {
    "keyword": "-k",
    "markexpr": "-m",
    "deselect": "--deselect",
    "ignore": "--ignore",
    "ignore_glob": "--ignore-glob",
    "lf": "--last-failed",
    "stepwise": "--stepwise",
    "stepwise_skip": "--stepwise-skip",
}
DESELECTED = pytest.StashKey[int]()


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(FULL_GATE, action="store_true", default=False, help="fail unless every test is collected and run")


def pytest_configure(config: pytest.Config) -> None:
    config.stash[DESELECTED] = 0


def pytest_deselected(items: list[pytest.Item]) -> None:
    if items:
        items[0].config.stash[DESELECTED] = items[0].config.stash.get(DESELECTED, 0) + len(items)


def narrowing(config: pytest.Config) -> list[str]:
    """The selection options this run was given."""
    return [flag for dest, flag in NARROWING_OPTIONS.items() if config.getoption(dest, default=None)]


def uncollected(config: pytest.Config, items: list[pytest.Item]) -> list[str]:
    """Test files under ``testpaths`` (``python_files`` patterns) that no collected item came from."""
    root = config.rootpath
    on_disk = {
        path.resolve()
        for testpath in config.getini("testpaths")
        for pattern in config.getini("python_files")
        for path in (root / testpath).rglob(pattern)
        if path.is_file() and not any(part.startswith((".", "__pycache__")) for part in path.relative_to(root).parts)
    }
    collected = {Path(item.path).resolve() for item in items}
    return sorted(str(path.relative_to(root.resolve())) for path in on_disk - collected)


def full_gate_problems(config: pytest.Config, items: list[pytest.Item]) -> list[str]:
    problems = [f"selection option {flag}" for flag in narrowing(config)]
    deselected = config.stash.get(DESELECTED, 0)
    if deselected:
        problems.append(f"{deselected} deselected test(s)")
    problems += [f"{path} was never collected" for path in uncollected(config, items)]
    return problems


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
def pytest_collection_finish(session: pytest.Session) -> None:
    if not session.config.getoption(FULL_GATE):
        return
    problems = full_gate_problems(session.config, session.items)
    if problems:
        msg = "pytest_guard: FAIL: the full gate runs every test; " + "; ".join(problems)
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
