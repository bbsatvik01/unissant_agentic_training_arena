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
