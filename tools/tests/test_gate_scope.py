"""Gate scope is pinned (global hard gate: never rig, soften or bypass CI/tests): the ratchet guards numeric
thresholds, and this module guards what each gate looks at. Narrowing a scope (a broader exclude, an ignored
rule, a coverage omit, a mypy override, a Semgrep or CodeQL ignore) fails here, so it can only land as a
visible, reviewed change to this test. Widening a scope is always allowed by updating the expected sets.
"""

import copy
import re
import tomllib

import pytest

from tools import check_no_rigging as nr
from tools.tests.conftest import REPO_ROOT

PYPROJECT = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
TOOL = PYPROJECT["tool"]
PACKAGES = ["arena_core", "arena_api", "arena_subject", "arena_referee", "arena_tournament"]


# Every gate table in pyproject.toml, exactly (an allow-list, not a list of forbidden keys). Any key added,
# removed or changed (a ruff per-file ignore or extend-ignore, a mypy disable_error_code or strict override,
# a pytest addopts selection such as --deselect, -k or --ignore, a coverage exclusion) fails until this pin
# changes in the same reviewed diff. Tightening a gate updates the pin too; it is never relaxed silently.
RUFF_SELECT = ["E", "F", "I", "W", "UP", "B", "S", "BLE", "TRY", "ASYNC", "SIM", "RUF", "PT", "C4", "DTZ", "T20"]
RUFF_SELECT += ["PTH", "ANN", "ARG", "ERA", "PIE", "PL", "RET", "N"]
SERVICE_SRC = [f"services/{name}/src" for name in ("api", "subject", "referee", "tournament")]
PINNED_TABLES: dict[str, object] = {
    "ruff": {
        "target-version": "py312",
        "line-length": 120,
        "extend-exclude": ["web", "supabase", "docs"],
        "lint": {
            "select": RUFF_SELECT,
            "isort": {"known-first-party": [*PACKAGES, "tools"]},
            "per-file-ignores": {"**/tests/**/*.py": ["S101"]},  # tests assert by design; nothing else relaxed
        },
        "format": {"quote-style": "double"},
    },
    "mypy": {
        "python_version": "3.12",
        "strict": True,
        "warn_unused_ignores": True,
        "warn_unreachable": True,
        "enable_error_code": ["ignore-without-code", "redundant-expr", "truthy-bool"],
        # scripts/ joined with its first file (WP-05, scripts/budget_plan.py): type-checked and measured like the rest.
        "files": ["packages", "services", "tools", "scripts", "conftest.py"],
        "explicit_package_bases": True,
        "mypy_path": ["packages/core/src", *SERVICE_SRC],
    },
    "pytest": {
        "ini_options": {
            "minversion": "9.0",
            "pythonpath": ["."],
            "addopts": ["--strict-markers", "--strict-config", "--import-mode=importlib", "-ra"],
            "testpaths": ["packages", "services", "tools/tests"],
            "filterwarnings": ["error"],
            "markers": ["gateproof: seeded-violation proofs that a gate fails on the defect it exists for"],
        }
    },
    "coverage": {
        "run": {
            "branch": True,
            "source": [*PACKAGES, "tools", "scripts"],
            "omit": ["tools/tests/*", "tools/envs/*"],
            "relative_files": True,
        },
        "report": {"fail_under": 90, "include_namespace_packages": True, "show_missing": True, "skip_covered": False},
        "xml": {"output": "coverage.xml"},
    },
}


def _differences(actual: object, expected: object, where: str) -> list[str]:
    if isinstance(actual, dict) and isinstance(expected, dict):
        keys = sorted(set(actual) | set(expected))
        return [d for k in keys for d in _differences(actual.get(k, MISSING), expected.get(k, MISSING), f"{where}.{k}")]
    return [] if actual == expected else [f"{where}: {actual!r} (pinned: {expected!r})"]


MISSING = "<absent>"


def table_drift(tool: dict[str, object]) -> list[str]:
    """Every difference between the gate tables and their pins, plus any unpinned gate table."""
    drift = [d for name, pin in PINNED_TABLES.items() for d in _differences(tool.get(name, MISSING), pin, name)]
    drift += [
        f"{name}: gate table with no pin" for name in sorted(nr.GATE_TOOL_TABLES - PINNED_TABLES.keys()) if name in tool
    ]
    return drift


def test_every_gate_table_matches_its_pin() -> None:
    assert table_drift(TOOL) == []


def test_every_gate_table_is_pinned_or_refused() -> None:
    assert set(PINNED_TABLES) <= nr.GATE_TOOL_TABLES


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("ruff", "lint", "extend-per-file-ignores"), {"packages/**/*.py": ["F821"]}),
        (("ruff", "lint", "per-file-ignores"), {"**/tests/**/*.py": ["S101"], "packages/**": ["F821"]}),
        (("ruff", "lint", "extend-ignore"), ["F821"]),
        (("ruff", "lint", "select"), RUFF_SELECT[:-1]),
        (("ruff", "extend-exclude"), ["web", "supabase", "docs", "packages"]),
        (("mypy", "disable_error_code"), ["return-value"]),
        (("mypy", "strict"), False),
        (("mypy", "overrides"), [{"module": "arena_core.*", "ignore_errors": True}]),
        (("pytest", "ini_options", "addopts"), ["--strict-markers", "--strict-config", "--deselect=tools/tests/x.py"]),
        (("pytest", "ini_options", "python_files"), ["check_*.py"]),
        (("coverage", "report", "exclude_also"), ["def main"]),
        (("coverage", "run", "omit"), ["tools/tests/*", "tools/envs/*", "tools/check_*.py"]),
        (("bandit",), {"skips": ["B602"]}),
    ],
)
def test_a_loosened_gate_table_fails_its_pin(path: tuple[str, ...], value: object) -> None:
    tool = copy.deepcopy(TOOL)
    table = tool
    for key in path[:-1]:
        table = table.setdefault(key, {})
    table[path[-1]] = value
    assert table_drift(tool), path


def test_bandit_scans_every_python_root() -> None:
    match = re.search(r"^PY_SOURCES := (.+)$", (REPO_ROOT / "Makefile").read_text(), flags=re.MULTILINE)
    assert match is not None
    assert match.group(1).split() == ["packages", "services", "tools", "scripts"]
    root_files = re.search(r"^PY_ROOT_FILES := (.+)$", (REPO_ROOT / "Makefile").read_text(), flags=re.MULTILINE)
    assert root_files is not None
    assert root_files.group(1).split() == ["conftest.py"]


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
