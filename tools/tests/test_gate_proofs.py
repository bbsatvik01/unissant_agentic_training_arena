"""Gate proofs (S5 11.1): each gate fails on the seeded defect it exists to catch.

Every proof runs the real, locked tool with the thresholds read from the live Makefile/pyproject,
so a loosened gate makes its proof fail. The raw-HTTP (Semgrep), silent-except, no-rigging, ratchet,
roles and dependency-policy proofs live in their own test modules. Lifted from TechnoMile
tools/tests/test_gate_proofs.py (ATTRIBUTIONS.md); the ESLint and tsc proofs return with web/ (WP-18).
"""

import re
import secrets
import string
import tomllib
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT, git_commit_all, git_init

pytestmark = pytest.mark.gateproof

MAKEFILE = (REPO_ROOT / "Makefile").read_text()
PYPROJECT = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())


def make_var(name: str) -> str:
    """The single assignment of a Makefile gate variable (a second assignment fails the proof)."""
    pattern = rf"^\s*(?:override\s+)?{name}\s*(?:::|:|\?|\+|!)?=\s*(.*?)\s*$"
    values = re.findall(pattern, MAKEFILE, flags=re.MULTILINE)
    assert len(values) == 1, f"{name} must be assigned exactly once in the Makefile, found {values}"
    return str(values[0])


def fake_github_token() -> str:
    """A key-shaped string generated at runtime so no secret-like literal lives in the repo."""
    alphabet = string.ascii_letters + string.digits
    return "ghp_" + "".join(secrets.choice(alphabet) for _ in range(36))


def test_mypy_strict_rejects_an_untyped_function(tmp_path: Path) -> None:
    (tmp_path / "untyped.py").write_text("def add(a, b):\n    return a + b\n")
    result = proc.run("mypy", ["--config-file", str(REPO_ROOT / "pyproject.toml"), "untyped.py"], cwd=tmp_path)
    assert result.returncode == 1, result.stdout
    assert "Function is missing a type annotation" in result.stdout


def test_mypy_typechecks_the_root_conftest(tmp_path: Path) -> None:
    """The configured file list is what `make typecheck` runs; a type error in conftest.py must fail it."""
    config_text = (REPO_ROOT / "pyproject.toml").read_text()
    configured = tomllib.loads(config_text)["tool"]["mypy"]["files"]
    assert "conftest.py" in configured
    (tmp_path / "pyproject.toml").write_text(config_text)
    for entry in configured:
        if entry.endswith(".py"):
            (tmp_path / entry).write_text('pytest_plugins: list[str] = "not a list"\n')
        else:
            (tmp_path / entry).mkdir()
            (tmp_path / entry / "ok.py").write_text("VALUE: int = 1\n")
    result = proc.run("mypy", ["--config-file", "pyproject.toml"], cwd=tmp_path)
    assert result.returncode == 1, result.stdout
    assert "conftest.py" in result.stdout
    assert "Incompatible types in assignment" in result.stdout


def test_gitleaks_rejects_a_key_shaped_string_in_history_and_staged(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "config.py").write_text(f'GITHUB_TOKEN = "{fake_github_token()}"\n')
    proc.run("git", ["-C", str(tmp_path), "add", "config.py"], check=True)
    staged = proc.run("gitleaks", ["git", "--no-banner", "--redact", "--pre-commit", "--staged", str(tmp_path)])
    assert staged.returncode == 1, staged.stderr
    git_commit_all(tmp_path, "leak")
    history = proc.run("gitleaks", ["git", "--no-banner", "--redact", str(tmp_path)])
    assert history.returncode == 1, history.stderr


def test_bandit_flags_shell_injection_at_the_gate_severity(tmp_path: Path) -> None:
    (tmp_path / "shell.py").write_text(
        "import subprocess\n\n\ndef run(cmd: str) -> None:\n    subprocess.call(cmd, shell=True)\n"
    )
    result = proc.run("bandit", ["-q", "-r", str(tmp_path), *make_var("BANDIT_FLAGS").split()])
    assert result.returncode == 1, result.stdout
    assert "B602" in result.stdout


def test_bandit_secret_pass_flags_a_hardcoded_password(tmp_path: Path) -> None:
    (tmp_path / "creds.py").write_text('db_password = "correct-horse-battery-staple"\n')
    gate = proc.run("bandit", ["-q", "-r", str(tmp_path), *make_var("BANDIT_FLAGS").split()])
    assert gate.returncode == 0, "the -ll -ii pass alone misses B105, which is why the secret pass exists"
    secret = proc.run("bandit", ["-q", "-r", str(tmp_path), "-t", make_var("BANDIT_SECRET_TESTS")])
    assert secret.returncode == 1, secret.stdout
    assert "B105" in secret.stdout


def _half_covered_project(root: Path) -> None:
    (root / "calc.py").write_text(
        "def covered(x: int) -> int:\n    return x + 1\n\n\n"
        "def uncovered(x: int) -> int:\n    if x > 0:\n        return x * 2\n    return -x\n"
    )
    (root / "test_calc.py").write_text(
        "from calc import covered\n\n\ndef test_covered() -> None:\n    assert covered(1) == 2\n"
    )


def test_coverage_gate_fails_below_the_configured_minimum(tmp_path: Path) -> None:
    _half_covered_project(tmp_path)
    fail_under = PYPROJECT["tool"]["coverage"]["report"]["fail_under"]
    result = proc.run(
        "pytest",
        [
            "-q",
            "-p",
            "no:cacheprovider",
            "--rootdir",
            str(tmp_path),
            "--cov=calc",
            "--cov-branch",
            f"--cov-fail-under={fail_under}",
        ],
        cwd=tmp_path,
    )
    assert result.returncode != 0, result.stdout
    assert f"Required test coverage of {fail_under}% not reached" in result.stdout


def test_diff_cover_fails_when_changed_lines_are_untested(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "calc.py").write_text("def covered(x: int) -> int:\n    return x + 1\n")
    (tmp_path / "test_calc.py").write_text(
        "from calc import covered\n\n\ndef test_covered() -> None:\n    assert covered(1) == 2\n"
    )
    git_commit_all(tmp_path, "base")
    proc.run("git", ["-C", str(tmp_path), "checkout", "-q", "-b", "feature"], check=True)
    _half_covered_project(tmp_path)
    git_commit_all(tmp_path, "add untested code")
    report = proc.run(
        "pytest",
        ["-q", "-p", "no:cacheprovider", "--rootdir", str(tmp_path), "--cov=calc", "--cov-branch", "--cov-report=xml"],
        cwd=tmp_path,
    )
    assert report.returncode == 0, report.stdout
    minimum = make_var("DIFF_COVER_MIN")
    result = proc.run(
        "diff-cover",
        ["coverage.xml", "--compare-branch=main", "--include-untracked", f"--fail-under={minimum}"],
        cwd=tmp_path,
    )
    assert result.returncode != 0, result.stdout
    assert f"Failure. Coverage is below {minimum}%" in result.stderr
