"""Scope gate proofs: an unimported module or an uncollected test file cannot pass unnoticed."""

import json
from pathlib import Path

import pytest

from tools import check_scope as cs
from tools.tests.conftest import git_init


def _repo(root: Path, files: list[str]) -> None:
    git_init(root)
    for name in files:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("x = 1\n")


def test_required_sets() -> None:
    files = [
        "packages/core/src/bh_core/a.py",
        "packages/core/tests/test_a.py",
        "tools/check_x.py",
        "tools/tests/test_x.py",
        "tools/envs/semgrep/x.py",
        "scripts/s.py",
        "docs/research/r.py",
        "web/src/lib/a.ts",
        "web/src/lib/a.test.ts",
        "web/src/app/page.spec.tsx",
    ]
    assert cs.python_required(files) == {"packages/core/src/bh_core/a.py", "tools/check_x.py", "scripts/s.py"}
    assert cs.web_tests_required(files) == {"web/src/lib/a.test.ts", "web/src/app/page.spec.tsx"}


@pytest.mark.gateproof
def test_coverage_report_missing_a_module_fails(tmp_path: Path) -> None:
    files = ["packages/core/src/bh_core/a.py", "packages/core/src/bh_core/newarea/b.py"]
    _repo(tmp_path, files)
    report = tmp_path / "coverage.json"
    report.write_text(json.dumps({"files": {files[0]: {}}}))
    assert cs.main(["coverage", str(report), "--root", str(tmp_path)]) == 1
    report.write_text(json.dumps({"files": {f: {} for f in files}}))
    assert cs.main(["coverage", str(report), "--root", str(tmp_path)]) == 0


def _suite(root: Path, name: str, status: str = "passed") -> dict[str, object]:
    return {"name": str(root / name), "assertionResults": [{"fullName": name, "status": status}]}


@pytest.mark.gateproof
def test_uncollected_spec_file_fails(tmp_path: Path) -> None:
    _repo(tmp_path, ["web/src/lib/a.test.ts", "web/src/app/page.spec.tsx"])
    path = tmp_path / "vitest.json"
    path.write_text(json.dumps({"numTotalTests": 1, "testResults": [_suite(tmp_path, "web/src/lib/a.test.ts")]}))
    assert cs.main(["vitest", str(path), "--root", str(tmp_path)]) == 1
    both = [_suite(tmp_path, "web/src/lib/a.test.ts"), _suite(tmp_path, "web/src/app/page.spec.tsx")]
    path.write_text(json.dumps({"numTotalTests": 2, "testResults": both}))
    assert cs.main(["vitest", str(path), "--root", str(tmp_path)]) == 0


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "report",
    [
        {"numTotalTests": 2, "numPendingTests": 1, "testResults": []},
        {"numTotalTests": 1, "numTodoTests": 1, "testResults": []},
        {"numTotalTests": 0, "testResults": []},
    ],
)
def test_vitest_skipped_todo_or_empty_fails(tmp_path: Path, report: dict[str, object]) -> None:
    git_init(tmp_path)
    path = tmp_path / "vitest.json"
    path.write_text(json.dumps(report))
    assert cs.main(["vitest", str(path), "--root", str(tmp_path)]) == 1


def test_vitest_non_passed_status_fails(tmp_path: Path) -> None:
    _repo(tmp_path, ["web/src/lib/a.test.ts"])
    path = tmp_path / "vitest.json"
    path.write_text(
        json.dumps({"numTotalTests": 1, "testResults": [_suite(tmp_path, "web/src/lib/a.test.ts", "skipped")]})
    )
    assert cs.main(["vitest", str(path), "--root", str(tmp_path)]) == 1


def test_nothing_to_require_or_unreadable_report_fails(tmp_path: Path) -> None:
    _repo(tmp_path, ["README.txt"])
    report = tmp_path / "coverage.json"
    report.write_text(json.dumps({"files": {}}))
    assert cs.main(["coverage", str(report), "--root", str(tmp_path)]) == 1
    assert cs.main(["coverage", str(tmp_path / "absent.json"), "--root", str(tmp_path)]) == 1
