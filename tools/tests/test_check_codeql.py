"""CodeQL security-extended gate proofs (S5 11.1 sec-check). Lifted from TechnoMile
tools/tests/test_check_codeql.py (ATTRIBUTIONS.md)."""

import json
import shutil
from pathlib import Path

import pytest

from tools import check_codeql as cq
from tools.tests.conftest import REPO_ROOT

COMMAND_INJECTION = """import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/run")
def run(cmd: str) -> None:
    os.system(cmd)
"""


def _scratch_root(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "tools" / "codeql").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "tools" / "codeql" / "python.yml", root / "tools" / "codeql" / "python.yml")
    return root


@pytest.mark.gateproof
def test_codeql_finds_command_injection_in_a_fastapi_route(tmp_path: Path) -> None:
    root = _scratch_root(tmp_path)
    (root / "services").mkdir()
    (root / "services" / "app.py").write_text(COMMAND_INJECTION)
    findings = cq.analyze(cq.LANGUAGES[0], root, tmp_path / "out")
    assert any(f.startswith("py/command-line-injection") for f in findings), findings


def test_missing_or_empty_sarif_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(cq.CodeQLError, match="no SARIF"):
        cq.sarif_findings(tmp_path / "absent.sarif")
    empty = tmp_path / "empty.sarif"
    empty.write_text(json.dumps({"runs": []}))
    with pytest.raises(cq.CodeQLError, match="no runs"):
        cq.sarif_findings(empty)


def test_sarif_results_are_listed(tmp_path: Path) -> None:
    sarif = tmp_path / "r.sarif"
    result = {
        "ruleId": "py/x",
        "message": {"text": "bad"},
        "locations": [{"physicalLocation": {"artifactLocation": {"uri": "a.py"}, "region": {"startLine": 3}}}],
    }
    sarif.write_text(json.dumps({"runs": [{"results": [result]}, {"results": []}]}))
    assert cq.sarif_findings(sarif) == ["py/x a.py:3 bad"]


def test_database_create_failure_fails_the_gate(tmp_path: Path) -> None:
    root = _scratch_root(tmp_path)  # no Python sources at all: CodeQL refuses to build a database
    assert cq.main(["--root", str(root), "--out", str(tmp_path / "out"), "--language", "python"]) == 1


def test_main_passes_on_clean_scratch_code(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _scratch_root(tmp_path)
    (root / "ok.py").write_text("VALUE = 1\n")
    assert cq.main(["--root", str(root), "--out", str(tmp_path / "out"), "--language", "python"]) == 0
    assert "python: 0 security-extended findings" in capsys.readouterr().out


def test_main_fails_on_a_finding(tmp_path: Path) -> None:
    root = _scratch_root(tmp_path)
    (root / "app.py").write_text(COMMAND_INJECTION)
    assert cq.main(["--root", str(root), "--out", str(tmp_path / "out"), "--language", "python"]) == 1


# ---------------------------------------------------------------- --sarif: validate an existing report
# CodeQL runs only locally (`make codeql`, inside `make sec-check`); there is no CI workflow producing a
# codeql-action SARIF to validate. --sarif stays as a standalone capability, proven here, for a report
# produced any other way -- it rejects anything the local gate itself would reject.
def _write(tmp_path: Path, name: str, body: object) -> Path:
    path = tmp_path / name
    path.write_text(body if isinstance(body, str) else json.dumps(body))
    return path


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("body", "problem"),
    [
        ({"runs": []}, "no runs"),
        ({}, "no runs"),
        ([], "not a SARIF object"),
        ("{not json", "not valid JSON"),
        ({"runs": [{"tool": {}}]}, "has no results array"),
        ({"runs": [{"results": "x"}]}, "has no results array"),
        ({"runs": ["x"]}, "is not an object"),
    ],
)
def test_sarif_mode_fails_closed_on_an_empty_or_malformed_report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], body: object, problem: str
) -> None:
    sarif = _write(tmp_path, "python.sarif", body)
    assert cq.main(["--sarif", str(sarif)]) == 1
    assert problem in capsys.readouterr().err


@pytest.mark.gateproof
@pytest.mark.parametrize("result", ["not-an-object", {}, {"locations": []}, {"locations": ["x"], "message": 3}])
def test_a_malformed_result_still_counts_as_a_finding(tmp_path: Path, result: object) -> None:
    sarif = _write(tmp_path, "odd.sarif", {"runs": [{"results": [result]}]})
    assert cq.sarif_findings(sarif) == ["? ?:? ?"]
    assert cq.main(["--sarif", str(sarif)]) == 1


@pytest.mark.gateproof
def test_sarif_mode_fails_on_a_finding_and_on_a_missing_file(tmp_path: Path) -> None:
    result = {
        "ruleId": "py/x",
        "message": {"text": "bad"},
        "locations": [{"physicalLocation": {"artifactLocation": {"uri": "a.py"}, "region": {"startLine": 3}}}],
    }
    clean = _write(tmp_path, "clean.sarif", {"runs": [{"results": []}]})
    dirty = _write(tmp_path, "dirty.sarif", {"runs": [{"results": [result]}]})
    assert cq.main(["--sarif", str(clean)]) == 0
    assert cq.main(["--sarif", str(clean), str(dirty)]) == 1
    assert cq.main(["--sarif", str(tmp_path / "codeql-results" / "*.sarif")]) == 1
