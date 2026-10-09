"""Licence gate proofs (S5 11.1): AGPL/SSPL and undeclared licences fail. Lifted from TechnoMile
tools/tests/test_check_licenses.py (ATTRIBUTIONS.md)."""

import json
from pathlib import Path

import pytest

from tools import check_licenses as cl

POLICY = cl.load_policy(
    '[licenses]\ndenied = ["agpl", "sspl", "affero"]\nworkspace = ["arena-core"]\n'
    '[[licenses.override]]\npackage = "face"\nversion = "1.0"\nlicense = "BSD-3-Clause"\nevidence = "LICENSE file"\n'
)


@pytest.mark.gateproof
@pytest.mark.parametrize(
    "declared", ["AGPL-3.0-only", "SSPL-1.0", "License :: OSI Approved :: GNU Affero General Public License v3"]
)
def test_denied_licenses_fail(declared: str) -> None:
    assert "denied license" in str(cl.verdict("pkg", "1.0", declared, POLICY))


@pytest.mark.gateproof
def test_undeclared_license_fails_unless_overridden() -> None:
    assert "no declared license" in str(cl.verdict("mystery", "1.0", "", POLICY))
    assert cl.verdict("face", "1.0", "", POLICY) is None
    assert "no declared license" in str(cl.verdict("face", "2.0", "", POLICY))
    assert cl.verdict("pkg", "1.0", "MIT", POLICY) is None


@pytest.mark.gateproof
@pytest.mark.parametrize("placeholder", ["UNKNOWN", "License :: OSI Approved", "see LICENSE file", "  "])
def test_placeholder_licenses_count_as_undeclared(placeholder: str) -> None:
    assert "no declared license" in str(cl.verdict("mystery", "1.0", placeholder, POLICY))
    assert "no declared license" in str(cl.verdict("mystery", "1.0", cl.meaningful([placeholder, "UNKNOWN"]), POLICY))


def test_node_report(tmp_path: Path) -> None:
    report = {"MIT": [{"name": "a", "versions": ["1.0.0"]}], "AGPL-3.0": [{"name": "b", "versions": ["2.0.0"]}]}
    assert cl.node_errors(report, POLICY) == ["b 2.0.0: denied license 'AGPL-3.0' (matches 'agpl')"]
    unknown = {"Unknown": [{"name": "c", "versions": ["1.0.0"]}]}
    assert "no declared license" in cl.node_errors(unknown, POLICY)[0]
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    assert cl.main(["node", str(path)]) == 1
    path.write_text(json.dumps({"MIT": [{"name": "a", "versions": ["1.0.0"]}]}))
    assert cl.main(["node", str(path)]) == 0


def test_python_environment_passes_the_repository_policy() -> None:
    assert cl.main(["python"]) == 0


def test_policy_validation() -> None:
    with pytest.raises(TypeError, match=r"\[licenses\]"):
        cl.load_policy("")
    with pytest.raises(ValueError, match="denied"):
        cl.load_policy("[licenses]\ndenied = []\n")
    with pytest.raises(ValueError, match="evidence"):
        cl.load_policy('[licenses]\ndenied = ["agpl"]\n[[licenses.override]]\npackage = "x"\n')


def test_node_mode_requires_a_report() -> None:
    with pytest.raises(SystemExit):
        cl.main(["node"])
