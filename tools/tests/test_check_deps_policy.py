"""Dependency-policy gate proofs: banned packages/extras, exact pins and armed floors fail.

Lifted from TechnoMile tools/tests/test_check_deps_policy.py (ATTRIBUTIONS.md); the empty-node-list cases
are this repo's addition (no web/package.json until WP-18).
"""

import json
from pathlib import Path

import pytest

from tools import check_deps_policy as dp
from tools.tests.conftest import REPO_ROOT, git_init

POLICY = """
python_locks = ["uv.lock"]
python_projects = ["pyproject.toml", "core/pyproject.toml"]
node_manifests = ["package.json"]

[python]
banned = ["litellm", "PyMuPDF"]
banned_extras = [{ package = "google-adk", extra = "extensions" }]

[python.exact]
langgraph = "1.2.12"

[node]
banned = ["xlsx"]

[[node.floor]]
package = "next"
minimum = "16.3.6"
origin = "now"
"""


def _lock(*packages: str) -> str:
    return "version = 1\n\n" + "\n".join(packages)


GOOD_LOCK = _lock(
    '[[package]]\nname = "langgraph"\nversion = "1.2.12"\n', '[[package]]\nname = "httpx"\nversion = "0.28.1"\n'
)
GOOD_PROJECT = (
    '[project]\nname = "arena-x"\ndependencies = ["arena-core", "httpx==0.28.1"]\n\n'
    '[dependency-groups]\ndev = ["ruff==0.16.8"]\n'
)


def _write(
    root: Path, *, lock: str = GOOD_LOCK, project: str = GOOD_PROJECT, node: dict[str, object] | None = None
) -> None:
    if not (root / ".git").exists():
        git_init(root)
    (root / "tools" / "gates").mkdir(parents=True, exist_ok=True)
    (root / dp.POLICY_PATH).write_text(POLICY)
    (root / "uv.lock").write_text(lock)
    (root / "pyproject.toml").write_text(project)
    (root / "core").mkdir(exist_ok=True)
    (root / "core" / "pyproject.toml").write_text('[project]\nname = "arena-core"\ndependencies = []\n')
    manifest = node if node is not None else {"dependencies": {"next": "16.3.6", "react": "19.3.0"}}
    (root / "package.json").write_text(json.dumps(manifest))


def _errors(root: Path) -> list[str]:
    policy = dp.parse_policy((root / dp.POLICY_PATH).read_text())
    return dp.run_checks(root, policy)


def test_clean_tree_passes(tmp_path: Path) -> None:
    _write(tmp_path)
    assert _errors(tmp_path) == []
    assert dp.main(["--root", str(tmp_path)]) == 0


@pytest.mark.gateproof
def test_banned_python_package_fails(tmp_path: Path) -> None:
    _write(tmp_path, lock=_lock('[[package]]\nname = "pymupdf"\nversion = "1.24.0"\n'))
    assert _errors(tmp_path) == ["uv.lock: banned package pymupdf 1.24.0"]


@pytest.mark.gateproof
def test_banned_extra_fails(tmp_path: Path) -> None:
    lock = _lock(
        '[[package]]\nname = "arena-referee"\nversion = "0.1.0"\n'
        'dependencies = [{ name = "google-adk", extra = ["extensions"] }]\n'
    )
    _write(tmp_path, lock=lock)
    assert _errors(tmp_path) == ["uv.lock: banned extra google-adk[extensions] required by arena-referee"]


@pytest.mark.gateproof
def test_wrong_framework_pin_fails(tmp_path: Path) -> None:
    _write(tmp_path, lock=_lock('[[package]]\nname = "langgraph"\nversion = "1.3.0"\n'))
    assert _errors(tmp_path) == ["uv.lock: langgraph must be exactly 1.2.12, lock has 1.3.0"]


@pytest.mark.gateproof
def test_unpinned_python_dependency_fails(tmp_path: Path) -> None:
    _write(tmp_path, project='[project]\nname = "arena-x"\ndependencies = ["httpx>=0.28"]\n')
    assert _errors(tmp_path) == ["pyproject.toml: dependency 'httpx>=0.28' is not an exact pin (name==x.y.z)"]


@pytest.mark.gateproof
def test_node_range_banned_package_and_floor_fail(tmp_path: Path) -> None:
    _write(
        tmp_path, node={"dependencies": {"next": "16.3.5", "xlsx": "0.18.5"}, "devDependencies": {"vitest": "^4.1.0"}}
    )
    assert _errors(tmp_path) == [
        "package.json: vitest '^4.1.0' is not an exact pin (x.y.z)",
        "package.json: banned package xlsx",
        "package.json: next 16.3.5 is below the floor 16.3.6 (now)",
    ]


@pytest.mark.gateproof
def test_unlisted_manifest_fails(tmp_path: Path) -> None:
    _write(tmp_path)
    (tmp_path / "services" / "new").mkdir(parents=True)
    (tmp_path / "services" / "new" / "pyproject.toml").write_text(
        '[project]\nname = "x"\ndependencies = ["requests"]\n'
    )
    assert _errors(tmp_path) == [f"services/new/pyproject.toml is not listed in {dp.POLICY_PATH} python_projects"]


@pytest.mark.gateproof
def test_empty_policy_lists_fail(tmp_path: Path) -> None:
    _write(tmp_path)
    (tmp_path / dp.POLICY_PATH).write_text("")
    assert dp.main(["--root", str(tmp_path)]) == 1
    policy = dp.parse_policy("")
    errors = dp.coverage_errors(tmp_path, policy)
    assert "policy list python_projects is empty" in errors
    assert "policy list python_locks is empty" in errors


def test_an_empty_node_list_passes_while_the_repo_has_no_package_json(tmp_path: Path) -> None:
    _write(tmp_path)
    (tmp_path / "package.json").unlink()
    (tmp_path / dp.POLICY_PATH).write_text(POLICY.replace('node_manifests = ["package.json"]', "node_manifests = []"))
    assert dp.main(["--root", str(tmp_path)]) == 0


@pytest.mark.gateproof
def test_a_package_json_the_empty_node_list_does_not_name_fails(tmp_path: Path) -> None:
    _write(tmp_path)
    (tmp_path / dp.POLICY_PATH).write_text(POLICY.replace('node_manifests = ["package.json"]', "node_manifests = []"))
    assert _errors(tmp_path) == [f"package.json is not listed in {dp.POLICY_PATH} node_manifests"]


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "project",
    [
        '[project]\nname = "arena-x"\ndependencies = []\n[project.optional-dependencies]\nextra = ["httpx>=0.1"]\n',
        '[project]\nname = "arena-x"\ndependencies = []\n[build-system]\nrequires = ["hatchling"]\n',
    ],
)
def test_optional_and_build_requirements_must_be_pinned(tmp_path: Path, project: str) -> None:
    _write(tmp_path, project=project)
    errors = _errors(tmp_path)
    assert len(errors) == 1
    assert "is not an exact pin" in errors[0]


def test_missing_files_and_empty_lock_fail_closed(tmp_path: Path) -> None:
    assert dp.main(["--root", str(tmp_path)]) == 1
    _write(tmp_path, lock="version = 1\n")
    assert _errors(tmp_path) == ["uv.lock: no [[package]] entries"]


@pytest.mark.parametrize(
    ("snippet", "problem"),
    [
        ('python_locks = "uv.lock"\n', "list of strings"),
        ("python = 3\n", "must be a table"),
        ("[python]\nbanned_extras = 3\n", "must be a list"),
        ("[python]\nbanned_extras = [{ package = 'x' }]\n", "package and extra"),
        ("[python.exact]\nx = 1\n", "version strings"),
        ("[node]\nfloor = 3\n", "array of tables"),
        ("[node]\nfloor = [3]\n", "must be tables"),
        ("[[node.floor]]\npackage = 'next'\nminimum = '16'\n", "origin"),
        ("[[node.floor]]\npackage = 'n'\nminimum = '16.x'\norigin = 'o'\n", "release versions only"),
    ],
)
def test_malformed_policy_is_rejected(snippet: str, problem: str) -> None:
    with pytest.raises(dp.PolicyError, match=problem):
        dp.parse_policy(snippet)


def test_repository_policy_passes_today() -> None:
    assert dp.main(["--root", str(REPO_ROOT)]) == 0
