"""pytest plugin: a run with any skipped, xfailed or xpassed test fails (global hard gate: no skip/xfail).

Loaded for every test in the repo by the root conftest.py. The static no-rigging scan catches skip
markers in source; this catches every runtime path by outcome: a skip exception raised from a helper
or fixture, a conditional import skip, an expected-failure decorator, a missing optional dependency.
"""

import pytest

UNWANTED_OUTCOMES = ("skipped", "xfailed", "xpassed")


def unwanted(stats: dict[str, list[object]]) -> dict[str, int]:
    return {outcome: len(stats.get(outcome, [])) for outcome in UNWANTED_OUTCOMES if stats.get(outcome)}


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
