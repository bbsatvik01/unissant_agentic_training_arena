"""Gate scope is pinned (global hard gate: never rig, soften or bypass CI/tests): the ratchet guards numeric
thresholds, and this module guards what each gate looks at. Narrowing a scope (a broader exclude, an ignored
rule, a coverage omit, a mypy override, a Semgrep or CodeQL ignore) fails here, so it can only land as a
visible, reviewed change to this test. Widening a scope is always allowed by updating the expected sets.
"""

import re
import tomllib

from tools.tests.conftest import REPO_ROOT

PYPROJECT = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
TOOL = PYPROJECT["tool"]
PACKAGES = ["arena_core", "arena_api", "arena_subject", "arena_referee", "arena_tournament"]


def test_ruff_ignores_nothing_beyond_assert_in_tests() -> None:
    ruff = TOOL["ruff"]
    assert ruff["extend-exclude"] == ["web", "supabase", "docs"]
    assert "exclude" not in ruff
    lint = ruff["lint"]
    assert {"ignore", "extend-ignore", "unfixable", "exclude"}.isdisjoint(lint)
    assert lint["per-file-ignores"] == {"**/tests/**/*.py": ["S101"]}
    lifted = ["E", "F", "I", "W", "UP", "B", "S", "BLE", "TRY", "ASYNC", "SIM", "RUF", "PT", "C4", "DTZ", "T20"]
    lifted += ["PTH", "ANN", "ARG", "ERA", "PIE", "PL", "RET", "N"]
    assert set(lifted) <= set(lint["select"])


def test_mypy_checks_every_python_root_with_no_per_module_escape() -> None:
    mypy = TOOL["mypy"]
    assert {"packages", "services", "tools"} <= set(mypy["files"])
    assert "overrides" not in mypy
    assert "exclude" not in mypy
    assert mypy["strict"] is True


def test_coverage_measures_every_package_and_excludes_no_lines() -> None:
    run, report = TOOL["coverage"]["run"], TOOL["coverage"]["report"]
    assert {*PACKAGES, "tools"} <= set(run["source"])
    assert run["omit"] == ["tools/tests/*", "tools/envs/*"]
    assert run["branch"] is True
    assert {"exclude_lines", "exclude_also", "omit", "partial_branches"}.isdisjoint(report)


def test_pytest_collects_every_test_root_strictly() -> None:
    ini = TOOL["pytest"]["ini_options"]
    assert {"packages", "services", "tools/tests"} <= set(ini["testpaths"])
    assert {"--strict-markers", "--strict-config"} <= set(ini["addopts"])
    assert ini["filterwarnings"] == ["error"]


def test_bandit_scans_every_python_root() -> None:
    match = re.search(r"^PY_SOURCES := (.+)$", (REPO_ROOT / "Makefile").read_text(), flags=re.MULTILINE)
    assert match is not None
    assert match.group(1).split() == ["packages", "services", "tools", "scripts"]


def test_semgrep_ignores_only_generated_vendored_and_data_trees() -> None:
    lines = (REPO_ROOT / ".semgrepignore").read_text().splitlines()
    entries = {line.strip() for line in lines if line.strip() and not line.startswith("#")}
    assert entries == {
        ".git/",
        ".venv/",
        ".tools/",
        ".gates/",
        "node_modules/",
        "web/dist/",
        "web/coverage/",
        "tools/envs/*/.venv/",
        "docs/",
        "cases/",
    }


def test_codeql_ignores_only_generated_vendored_and_data_trees() -> None:
    text = (REPO_ROOT / "tools" / "codeql" / "python.yml").read_text()
    entries = [line.strip()[2:] for line in text.splitlines() if line.strip().startswith("- ")]
    assert entries == [".venv", "tools/envs", "web", "docs", "cases"]
