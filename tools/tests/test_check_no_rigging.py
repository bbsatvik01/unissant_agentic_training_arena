"""Gate proofs for the no-rigging scan (global hard gate: never rig, soften or bypass CI/tests).

The seeded marker lines live in fixtures/suppressions.tsv (data, not scanned) so this module holds no
live suppression and needs no allowlist entry.

Adapted from TechnoMile tools/tests/test_check_no_rigging.py (ATTRIBUTIONS.md): only the
docs-archive-root assertions changed, to match this repo's single `docs/research/` archive root
instead of TechnoMile's two.
"""

import shutil
from collections.abc import Callable
from pathlib import Path

import pytest

from tools import check_no_rigging as nr
from tools.tests.conftest import REPO_ROOT, git_init

FIXTURES = Path(__file__).parent / "fixtures" / "suppressions.tsv"
SEEDED = [line.split("\t", 1) for line in FIXTURES.read_text().splitlines() if line]
FIRST = dict(reversed(SEEDED))  # first seeded line per marker id
NOQA = FIRST["noqa"]
TYPE_IGNORE = FIRST["type-ignore"]
CONTINUE = FIRST["continue-on-error"]
APPROVED = f"run(argv)  {NOQA.split('  ', 1)[1].replace('E501', 'S603')}"  # one allowlisted line


MARKERS = nr.load_markers((REPO_ROOT / nr.MARKERS_PATH).read_text())


def reader(root: Path) -> Callable[[str], bytes]:
    return lambda path: (root / path).read_bytes()


def test_fixture_covers_every_marker() -> None:
    assert {marker for marker, _ in SEEDED} == set(MARKERS)


@pytest.mark.gateproof
@pytest.mark.parametrize(("marker", "line"), SEEDED)
def test_each_forbidden_marker_is_caught(tmp_path: Path, marker: str, line: str) -> None:
    (tmp_path / "bad.py").write_text(line + "\n")
    errors = nr.check(["bad.py"], reader(tmp_path), [], MARKERS)
    assert any(f"[{marker}]" in e for e in errors), errors


def test_allowance_covers_only_its_file_marker_and_line(tmp_path: Path) -> None:
    body = f"if True:\n    {APPROVED}\n{NOQA}\n"
    for name in ("a.py", "b.py"):
        (tmp_path / name).write_text(body)
    errors = nr.check(["a.py", "b.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", APPROVED)], MARKERS)
    assert [e.split(": forbidden")[0] for e in errors] == ["a.py:3", "b.py:2", "b.py:3"]


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "edited",
    [
        APPROVED + ", F821",
        f"{APPROVED}  {TYPE_IGNORE.split('  ', 1)[1]}",
        APPROVED.replace(": S603", ""),
        "x = 0; " + APPROVED,
    ],
)
def test_an_allowance_covers_only_its_exact_line(tmp_path: Path, edited: str) -> None:
    """Codex round 3, finding 1: a substring match let `S603` widen to `S603, F821` (or gain a second
    directive) under the unchanged allowlist entry. The entry now names the whole line."""
    (tmp_path / "a.py").write_text(edited + "\n")
    errors = nr.check(["a.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", APPROVED)], MARKERS)
    assert any(e.startswith("a.py:1: forbidden suppression [noqa]") for e in errors), errors
    assert any("stale allowlist entry" in e for e in errors), errors
    (tmp_path / "a.py").write_text(APPROVED + "\n")
    assert nr.check(["a.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", APPROVED)], MARKERS) == []


@pytest.mark.gateproof
def test_stale_allowance_fails(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("x = 1\n")
    errors = nr.check(["a.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", APPROVED)], MARKERS)
    assert errors == [f"a.py: stale allowlist entry [noqa] {APPROVED!r} matches nothing"]


def test_makefile_and_hooks_are_scanned_but_images_are_not(tmp_path: Path) -> None:
    (tmp_path / "Makefile").write_text(f"{CONTINUE}\n")
    (tmp_path / "image.png").write_bytes(b"\x89PNG " + CONTINUE.encode())
    assert len(nr.check(["Makefile", "image.png"], reader(tmp_path), [], MARKERS)) == 1


def test_non_utf8_file_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "blob.py").write_bytes(b"\xff\xfe\x00bad")
    assert "not UTF-8" in nr.check(["blob.py"], reader(tmp_path), [], MARKERS)[0]


def test_allowlist_requires_match_reason_and_known_marker() -> None:
    good = '[[allow]]\npath="a"\nmarker="noqa"\nline="  run(argv)  "\nreason="verified"\n'
    assert nr.load_allowlist(good, MARKERS) == [nr.Allowance("a", "noqa", "run(argv)")]
    for bad, problem in (
        ('[[allow]]\npath="a"\nmarker="noqa"\nreason="verified"\n', "line"),
        ('[[allow]]\npath="a"\nmarker="noqa"\nmatch="x"\nreason="verified"\n', "line"),
        ('[[allow]]\npath="a"\nmarker="noqa"\nline="x"\nreason=" "\n', "reason"),
        ('[[allow]]\npath="a"\nmarker="whatever"\nline="x"\nreason="r"\n', "unknown marker"),
    ):
        with pytest.raises(ValueError, match=problem):
            nr.load_allowlist(bad, MARKERS)


def test_marker_policy_ids_must_match_patterns() -> None:
    with pytest.raises(ValueError, match="exactly the keys"):
        nr.load_markers("ids = ['a']\n[patterns]\nb = 'x'\n")


def _policy_files(root: Path) -> None:
    (root / "tools" / "gates").mkdir(parents=True)
    (root / nr.ALLOWLIST_PATH).write_text("")
    shutil.copy(REPO_ROOT / nr.MARKERS_PATH, root / nr.MARKERS_PATH)


@pytest.mark.gateproof
def test_main_fails_on_new_untracked_suppression_and_passes_when_clean(tmp_path: Path) -> None:
    git_init(tmp_path)
    _policy_files(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    assert nr.main(["--root", str(tmp_path)]) == 0
    (tmp_path / "new.py").write_text(TYPE_IGNORE + "\n")
    assert nr.main(["--root", str(tmp_path)]) == 1
    (tmp_path / ".gitignore").write_text("new.py\n")
    assert nr.main(["--root", str(tmp_path)]) == 0


@pytest.mark.gateproof
def test_snapshot_mode_uses_the_snapshot_policy_not_the_worktree(tmp_path: Path) -> None:
    snap = tmp_path / "snap"
    _policy_files(snap)
    (snap / "mod.py").write_text(TYPE_IGNORE + "\n")
    assert nr.main(["--root", str(snap), "--snapshot"]) == 1
    (snap / "mod.py").write_text("y = 1\n")
    assert nr.main(["--root", str(snap), "--snapshot"]) == 0


def test_main_fails_closed_without_policy_files(tmp_path: Path) -> None:
    git_init(tmp_path)
    assert nr.main(["--root", str(tmp_path)]) == 1


def test_this_repository_is_clean() -> None:
    assert nr.main(["--root", str(REPO_ROOT)]) == 0


def test_docs_python_outside_the_archive_fails() -> None:
    paths = ["docs/research/r.py", "docs/notes.md", "docs/sneaky.py"]
    assert nr.docs_python_errors(paths) == [
        f"docs/sneaky.py: Python under docs/ outside {nr.DOCS_PY_ARCHIVES} escapes the linters"
    ]


@pytest.mark.parametrize(
    "line",
    [
        'export const defaults = { tracing: "off" };',
        'DEFAULTS = {"tracing": "off", "retries": 0}',
        "skip = True",
        "logger.info('ignore: this is a message')",
        "# type annotations are ignored at runtime",
        "ignore_errors = false",
        "    continue-on-error: false",
        "      - continue-on-error: ${ false }",
        "# mypy strict mode is on for every package",
        'filterwarnings = ["error"]',
        "warnings.simplefilter('error')",
        "pytest -W error --cov",
        "gcc -Wall -Wextra main.c",
        "pytest -W $(PYTEST_WARNINGS) --cov",
        "from typing import cast, no_type_check_helper_name_is_not_used",
        "pip-audit --strict --require-hashes",
        "# isort is ruff's I rule here",
    ],
)
def test_ordinary_code_and_data_never_match(tmp_path: Path, line: str) -> None:
    (tmp_path / "app.ts").write_text(line + "\n")
    assert nr.check(["app.ts"], reader(tmp_path), [], MARKERS) == []


# ---------------------------------------------------------------- Python read as Python (Codex round 4)
# A warning filter or a skip written with a keyword argument, across lines, through an import alias, as a
# value or through getattr is the same suppression a line scan cannot see. Python files are parsed and these
# are judged on the syntax tree. The fixtures use a suffix the scan skips, so this module holds no live one.
SUPPRESSED_PYTHON = sorted((Path(__file__).parent / "fixtures" / "suppressed-python").glob("*.fixture"))


def test_the_python_fixtures_exist() -> None:
    assert {p.stem for p in SUPPRESSED_PYTHON} == {
        "pytest-skip--from-import",
        "pytest-skip--mark-assigned",
        "pytest-skip--mark-import",
        "pytest-skip--module-alias",
        "pytest-skip--module-dict",
        "unittest-skip--from-import",
        "unittest-skip--module-alias",
        "warnings-ignore--abbreviated-action",
        "warnings-ignore--always-action",
        "warnings-ignore--catch-warnings-action",
        "warnings-ignore--catch-warnings-default",
        "warnings-ignore--computed-action",
        "warnings-ignore--default-action-mark",
        "warnings-ignore--dunder-import",
        "warnings-ignore--filters-list",
        "warnings-ignore--function-as-value",
        "warnings-ignore--getattr",
        "warnings-ignore--getattr-reset",
        "warnings-ignore--import-alias",
        "warnings-ignore--import-module",
        "warnings-ignore--keyword-action",
        "warnings-ignore--keyword-always",
        "warnings-ignore--kwargs-action",
        "warnings-ignore--local-rebinding",
        "warnings-ignore--module-alias",
        "warnings-ignore--module-assigned",
        "warnings-ignore--module-dict",
        "warnings-ignore--module-passed",
        "warnings-ignore--multiline-abbreviated-mark",
        "warnings-ignore--multiline-positional",
        "warnings-ignore--pytest-mark-multiline",
        "warnings-ignore--pytest-mark-second-filter",
        "warnings-ignore--recwarn-fixture",
        "warnings-ignore--resetwarnings",
        "warnings-ignore--showwarning-replaced",
        "warnings-ignore--submodule-path",
        "warnings-ignore--sys-modules",
        "warnings-ignore--vars-of-module",
    }


@pytest.mark.gateproof
@pytest.mark.parametrize("fixture", SUPPRESSED_PYTHON, ids=lambda p: p.stem)
def test_python_suppressions_are_found_on_the_syntax_tree(tmp_path: Path, fixture: Path) -> None:
    shutil.copy(fixture, tmp_path / "test_x.py")
    errors = nr.check(["test_x.py"], reader(tmp_path), [], MARKERS)
    assert any(f"[{fixture.stem.split('--')[0]}]" in e for e in errors), (fixture.name, errors)


@pytest.mark.parametrize(
    "source",
    [
        'import warnings\n\nwarnings.simplefilter("error")\n',
        'import warnings\n\nwarnings.filterwarnings(action="error", category=DeprecationWarning)\n',
        'import warnings\n\nwarnings.filterwarnings("error", "ignore this message text")\n',
        "import warnings\n\nwith warnings.catch_warnings(record=True) as seen:\n    assert seen == []\n",
        'import pytest\n\n\n@pytest.mark.filterwarnings("error::DeprecationWarning")\ndef test_x() -> None:\n    ...\n',
        "import pytest\n\n\ndef test_x() -> None:\n    with pytest.warns(UserWarning):\n        pass\n",
        "import argparse\n\nparser = argparse.ArgumentParser()\nparser.skip = 1\nfilters = [1]\n",
        "import pytest\n\n\ndef test_x() -> None:\n    with pytest.raises(ValueError):\n        int('x')\n",
        'import warnings\n\nwarnings.warn("deprecated", DeprecationWarning, stacklevel=2)\n',
        'import pytest\n\nraises = getattr(pytest, "raises")\n',
    ],
)
def test_ordinary_python_passes_the_syntax_tree_scan(tmp_path: Path, source: str) -> None:
    (tmp_path / "test_x.py").write_text(source)
    assert nr.check(["test_x.py"], reader(tmp_path), [], MARKERS) == []


def test_unparseable_python_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "broken.py").write_text("def f(:\n")
    assert "not valid Python" in nr.check(["broken.py"], reader(tmp_path), [], MARKERS)[0]


# ---------------------------------------------------------------- competing tool configuration (Codex round 6)
# Each Python gate reads pyproject.toml, named explicitly in the Makefile; a file that a tool's own discovery
# would prefer (or a [tool.*] table in a nested pyproject.toml) is refused, so the gate config cannot be
# swapped out from beside it.
@pytest.mark.gateproof
@pytest.mark.parametrize(
    "path",
    [
        "mypy.ini",
        ".mypy.ini",
        "setup.cfg",
        "tox.ini",
        "pytest.ini",
        ".pytest.ini",
        "ruff.toml",
        ".ruff.toml",
        ".coveragerc",
        "services/api/ruff.toml",
        "packages/core/.coveragerc",
    ],
)
def test_a_competing_tool_config_fails(tmp_path: Path, path: str) -> None:
    target = tmp_path / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("[mypy]\nfiles = packages/core/src/arena_core/config.py\n")
    errors = nr.check([path], reader(tmp_path), [], MARKERS)
    assert errors == [f"{path}: competing gate configuration; the gates read only {nr.ROOT_CONFIG}"], errors


@pytest.mark.gateproof
@pytest.mark.parametrize("table", ["ruff", "mypy", "pytest.ini_options", "coverage.run", "bandit", "ruff.lint"])
def test_a_tool_table_in_a_nested_pyproject_fails(tmp_path: Path, table: str) -> None:
    (tmp_path / "services" / "api").mkdir(parents=True)
    (tmp_path / "services" / "api" / "pyproject.toml").write_text(f'[project]\nname = "x"\n\n[tool.{table}]\nx = 1\n')
    errors = nr.check(["services/api/pyproject.toml"], reader(tmp_path), [], MARKERS)
    assert errors == [
        f"services/api/pyproject.toml: [tool.{table.partition('.')[0]}] in a nested pyproject.toml; gate configuration"
        f" lives only in {nr.ROOT_CONFIG}"
    ], errors


def test_the_root_pyproject_and_a_plain_nested_one_pass(tmp_path: Path) -> None:
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pyproject.toml").write_text("[tool.mypy]\nstrict = true\n")
    (tmp_path / "pkg" / "pyproject.toml").write_text('[project]\nname = "x"\n\n[tool.uv]\npackage = false\n')
    assert nr.check(["pyproject.toml", "pkg/pyproject.toml"], reader(tmp_path), [], MARKERS) == []


# ---------------------------------------------------------------- YAML read as YAML (Codex round 2, finding 2)
# continue-on-error is judged on the parsed document, so a value on the next line, a block scalar, an alias
# or a flow mapping is seen exactly as GitHub's parser sees it; anything but a plain boolean false is a
# suppression.
WORKFLOW_HEAD = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n"
# Whole workflows that enable continue-on-error in a form a line scan cannot see. They live in fixture files
# with a suffix the scan skips, so this module holds no live suppression.
SUPPRESSED_WORKFLOWS = sorted((Path(__file__).parent / "fixtures" / "suppressed-workflows").glob("*.fixture"))


def test_the_workflow_fixtures_exist() -> None:
    assert {p.stem for p in SUPPRESSED_WORKFLOWS} == {
        "alias-to-true",
        "block-scalar-expression",
        "next-line-true",
        "quoted-true",
        "step-next-line-capital-true",
        "yaml-1-1-no",
    }


@pytest.mark.gateproof
@pytest.mark.parametrize("fixture", SUPPRESSED_WORKFLOWS, ids=lambda p: p.stem)
def test_continue_on_error_is_found_on_the_parsed_yaml(tmp_path: Path, fixture: Path) -> None:
    shutil.copy(fixture, tmp_path / "ci.yml")
    errors = nr.check(["ci.yml"], reader(tmp_path), [], MARKERS)
    assert any("[continue-on-error]" in e for e in errors), (fixture.name, errors)


@pytest.mark.parametrize("value", ["false", "False", "FALSE"])
def test_continue_on_error_false_passes(tmp_path: Path, value: str) -> None:
    (tmp_path / "ci.yml").write_text(WORKFLOW_HEAD + f"    continue-on-error: {value}\n    steps: []\n")
    assert nr.check(["ci.yml"], reader(tmp_path), [], MARKERS) == []


@pytest.mark.gateproof
def test_unparseable_yaml_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "ci.yml").write_text("jobs: [unclosed\n")
    errors = nr.check(["ci.yml"], reader(tmp_path), [], MARKERS)
    assert len(errors) == 1
    assert "not valid YAML" in errors[0]


def test_one_finding_per_line_when_the_line_scan_and_the_yaml_scan_agree(tmp_path: Path) -> None:
    (tmp_path / "ci.yml").write_text(WORKFLOW_HEAD + CONTINUE + "\n    steps: []\n")
    errors = nr.check(["ci.yml"], reader(tmp_path), [], MARKERS)
    assert len(errors) == 1, errors


# ---------------------------------------------------------------- suppression-list files
@pytest.mark.gateproof
def test_every_gitleaksignore_entry_is_a_suppression(tmp_path: Path) -> None:
    (tmp_path / ".gitleaksignore").write_text("# a comment\n\n0123abcd:services/api/x.py:generic-api-key:3\n")
    errors = nr.check([".gitleaksignore"], reader(tmp_path), [], MARKERS)
    assert errors == [
        ".gitleaksignore:3: forbidden suppression [gitleaks-allow] 0123abcd:services/api/x.py:generic-api-key:3"
    ]


@pytest.mark.gateproof
@pytest.mark.parametrize("name", [".gitleaks.toml", "gitleaks.toml"])
def test_a_gitleaks_config_is_a_suppression_list(tmp_path: Path, name: str) -> None:
    (tmp_path / name).write_text("# replaces the default rules\n[extend]\nuseDefault = false\n")
    errors = nr.check([name], reader(tmp_path), [], MARKERS)
    assert [e.split(": forbidden")[0] for e in errors] == [f"{name}:2", f"{name}:3"]
    assert all("[gitleaks-allow]" in e for e in errors)


def test_a_gitleaksignore_with_only_comments_is_clean_and_an_allowed_entry_passes(tmp_path: Path) -> None:
    (tmp_path / ".gitleaksignore").write_text("# verified false positives only\n")
    assert nr.check([".gitleaksignore"], reader(tmp_path), [], MARKERS) == []
    (tmp_path / ".gitleaksignore").write_text("abc:docs/x.md:generic-api-key:9\n")
    allowed = [nr.Allowance(".gitleaksignore", "gitleaks-allow", "abc:docs/x.md:generic-api-key:9")]
    assert nr.check([".gitleaksignore"], reader(tmp_path), allowed, MARKERS) == []


# ---------------------------------------------------------------- S5 11.3 against this repo's real files
def _tracked_copy(tmp_path: Path, rel: str) -> Path:
    target = tmp_path / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(REPO_ROOT / rel, target)
    return target


@pytest.mark.gateproof
@pytest.mark.parametrize("workflow", [".github/workflows/ci.yml", ".github/workflows/security.yml"])
def test_continue_on_error_added_to_a_real_workflow_fails(tmp_path: Path, workflow: str) -> None:
    git_init(tmp_path)
    _policy_files(tmp_path)
    target = _tracked_copy(tmp_path, workflow)
    assert nr.main(["--root", str(tmp_path)]) == 0
    text = target.read_text()
    marker = "    steps:\n"
    assert marker in text
    target.write_text(text.replace(marker, CONTINUE + "\n" + marker, 1))
    assert nr.main(["--root", str(tmp_path)]) == 1


@pytest.mark.gateproof
def test_type_ignore_added_to_a_real_module_fails(tmp_path: Path) -> None:
    git_init(tmp_path)
    _policy_files(tmp_path)
    target = _tracked_copy(tmp_path, "packages/core/src/arena_core/config.py")
    assert nr.main(["--root", str(tmp_path)]) == 0
    target.write_text(target.read_text() + "\n" + TYPE_IGNORE + "\n")
    assert nr.main(["--root", str(tmp_path)]) == 1
