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
    body = f"run(argv)  {NOQA.split('  ', 1)[1].replace('E501', 'S603')}\n{NOQA}\n"
    for name in ("a.py", "b.py"):
        (tmp_path / name).write_text(body)
    errors = nr.check(["a.py", "b.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", "S603")], MARKERS)
    assert [e.split(": forbidden")[0] for e in errors] == ["a.py:2", "b.py:1", "b.py:2"]


@pytest.mark.gateproof
def test_stale_allowance_fails(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("x = 1\n")
    errors = nr.check(["a.py"], reader(tmp_path), [nr.Allowance("a.py", "noqa", "S603")], MARKERS)
    assert errors == ["a.py: stale allowlist entry [noqa] 'S603' matches nothing"]


def test_makefile_and_hooks_are_scanned_but_images_are_not(tmp_path: Path) -> None:
    (tmp_path / "Makefile").write_text(f"{CONTINUE}\n")
    (tmp_path / "image.png").write_bytes(b"\x89PNG " + CONTINUE.encode())
    assert len(nr.check(["Makefile", "image.png"], reader(tmp_path), [], MARKERS)) == 1


def test_non_utf8_file_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "blob.py").write_bytes(b"\xff\xfe\x00bad")
    assert "not UTF-8" in nr.check(["blob.py"], reader(tmp_path), [], MARKERS)[0]


def test_allowlist_requires_match_reason_and_known_marker() -> None:
    good = '[[allow]]\npath="a"\nmarker="noqa"\nmatch="S603"\nreason="verified"\n'
    assert nr.load_allowlist(good, MARKERS) == [nr.Allowance("a", "noqa", "S603")]
    for bad, problem in (
        ('[[allow]]\npath="a"\nmarker="noqa"\nreason="verified"\n', "match"),
        ('[[allow]]\npath="a"\nmarker="noqa"\nmatch="x"\nreason=" "\n', "reason"),
        ('[[allow]]\npath="a"\nmarker="whatever"\nmatch="x"\nreason="r"\n', "unknown marker"),
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
    ],
)
def test_ordinary_code_and_data_never_match(tmp_path: Path, line: str) -> None:
    (tmp_path / "app.ts").write_text(line + "\n")
    assert nr.check(["app.ts"], reader(tmp_path), [], MARKERS) == []
