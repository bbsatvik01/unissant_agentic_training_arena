"""The Makefile gate recipes themselves fail on seeded defects.

macOS ships GNU make 3.81, which ignores .SHELLFLAGS, so a pipeline's failure can be masked by its
last command. These tests drive the real recipes (make -f <repo Makefile>) in scratch repositories.
Lifted from TechnoMile tools/tests/test_makefile.py (ATTRIBUTIONS.md); the gate-group lists are this
repo's (S5 11.1; db-test arrived with WP-03, web-check arrives with its tree).
"""

import re
import secrets
import shlex
import shutil
import string
import subprocess
from pathlib import Path

import pytest

from tools import proc
from tools.tests.conftest import REPO_ROOT, git_init

MAKEFILE = REPO_ROOT / "Makefile"
# Shell-quoted: the checkout path may contain spaces (the owner's does).
UV_RUN = f"uv run --project {shlex.quote(str(REPO_ROOT))} --locked"
SEMGREP = f"uv run --project {shlex.quote(str(REPO_ROOT / 'tools' / 'envs' / 'semgrep'))} --locked semgrep"


def recipe_lines(text: str) -> list[str]:
    """Recipe lines with backslash continuations joined."""
    lines: list[str] = []
    current = ""
    for raw in text.splitlines():
        if not raw.startswith("\t") and not current:
            continue
        current += raw.strip().removesuffix("\\")
        if raw.endswith("\\"):
            continue
        lines.append(current)
        current = ""
    return lines


def test_every_piped_or_looping_recipe_sets_pipefail() -> None:
    offenders = [
        line
        for line in recipe_lines(MAKEFILE.read_text())
        if (re.search(r"(?<!\|)\|(?!\|)", line) or re.search(r"\b(while|for)\b", line))
        and not line.startswith(("$(STRICT)", "set -euo pipefail;", "@#"))
    ]
    assert offenders == []


def test_gates_never_run_in_parallel_with_dependency_sync() -> None:
    assert re.search(r"^\.NOTPARALLEL:\s*$", MAKEFILE.read_text(), flags=re.MULTILINE)


def _prerequisites(text: str, target: str) -> list[str]:
    """The prerequisites of ``target``, with backslash-continued lines joined."""
    joined = re.sub(r"\\\n\s*", " ", text)
    match = re.search(rf"^{re.escape(target)}: (.+)$", joined, flags=re.MULTILINE)
    assert match is not None, target
    return match.group(1).split()


def test_check_runs_every_gate_group_after_syncing_dependencies() -> None:
    text = MAKEFILE.read_text()
    # The pinned binaries are synced before py-check: its gate proofs run CodeQL and gitleaks themselves.
    assert _prerequisites(text, "check") == ["deps-sync", "tools-sync", "py-check", "db-test", "sec-check"]
    assert re.search(r"^db-test:\n\tsupabase/tests/harness/db_test\.sh\n", text, flags=re.MULTILINE)
    required = {
        "py-check": [
            "lint",
            "format-check",
            "typecheck",
            "no-rigging",
            "silent-except",
            "roles",
            "cost-parity",
            "supabase-config",
            "ratchet",
            "deps-policy",
            "push-clean",
            "test",
            "scope-coverage",
            "diff-cover",
        ],
        "sec-check": [
            "tools-sync",
            "bandit",
            "semgrep",
            "codeql",
            "gitleaks",
            "trufflehog",
            "pip-audit",
            "osv-scanner",
            "licenses",
        ],
    }
    for group, targets in required.items():
        assert set(targets) <= set(_prerequisites(text, group)), group
    # tools-sync must run before the first gate that needs a pinned binary.
    sec = _prerequisites(text, "sec-check")
    assert sec[0] == "tools-sync"


def test_recipe_parser_joins_continuations() -> None:
    text = "target:\n\techo a | \\\n\t\tcat\n\n\tplain\n"
    assert recipe_lines(text) == ["echo a | cat", "plain"]


def make(target: str, cwd: Path, **overrides: str) -> subprocess.CompletedProcess[str]:
    args = ["-f", str(MAKEFILE), target, *(f"{k}={v}" for k, v in overrides.items())]
    return proc.run("make", args, cwd=cwd)


def fake_token() -> str:
    alphabet = string.ascii_letters + string.digits
    return "ghp_" + "".join(secrets.choice(alphabet) for _ in range(36))


@pytest.mark.gateproof
def test_gitleaks_recipe_fails_on_a_new_file_that_is_not_scanned_last(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "a_leak.py").write_text(f'TOKEN = "{fake_token()}"\n')
    (tmp_path / "z_clean.txt").write_text("nothing here\n")
    gitleaks = str(proc.resolve("gitleaks"))
    assert make("gitleaks", tmp_path, GITLEAKS=gitleaks).returncode != 0
    (tmp_path / "a_leak.py").unlink()
    clean = make("gitleaks", tmp_path, GITLEAKS=gitleaks)
    assert clean.returncode == 0, clean.stdout + clean.stderr


@pytest.mark.gateproof
def test_bandit_recipe_fails_when_the_bad_file_is_not_last(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "packages").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "packages" / "a_bad.py").write_text("import subprocess\n\nsubprocess.call(input(), shell=True)\n")
    (tmp_path / "scripts" / "z_ok.py").write_text("VALUE = 1\n")
    assert make("bandit", tmp_path, UV_RUN=UV_RUN).returncode != 0
    (tmp_path / "packages" / "a_bad.py").write_text("VALUE = 2\n")
    clean = make("bandit", tmp_path, UV_RUN=UV_RUN)
    assert clean.returncode == 0, clean.stdout + clean.stderr


@pytest.mark.gateproof
def test_bandit_recipe_secret_pass_fails_on_a_hardcoded_password_the_first_pass_misses(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "services").mkdir()
    (tmp_path / "services" / "creds.py").write_text('db_password = "correct-horse-battery-staple"\n')
    seeded = make("bandit", tmp_path, UV_RUN=UV_RUN)
    assert seeded.returncode != 0, seeded.stdout + seeded.stderr
    assert "B105" in seeded.stdout


@pytest.mark.gateproof
def test_semgrep_recipe_fails_on_raw_http_in_a_service(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "tools" / "semgrep").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "tools" / "semgrep" / "rules.yml", tmp_path / "tools" / "semgrep" / "rules.yml")
    (tmp_path / "services" / "api").mkdir(parents=True)
    (tmp_path / "services" / "api" / "leak.py").write_text("import httpx\n\nhttpx.get('https://example.com')\n")
    assert make("semgrep", tmp_path, SEMGREP=SEMGREP).returncode != 0
    (tmp_path / "services" / "api" / "leak.py").write_text("VALUE = 1\n")
    clean = make("semgrep", tmp_path, SEMGREP=SEMGREP)
    assert clean.returncode == 0, clean.stdout + clean.stderr


# ---------------------------------------------------------------- explicit gate configuration (Codex round 6)
def _dry_run(target: str) -> str:
    result = proc.run("make", ["-n", "-f", str(MAKEFILE), target], cwd=REPO_ROOT)
    assert result.returncode == 0, result.stderr
    return result.stdout


@pytest.mark.parametrize(
    ("target", "tool", "flag"),
    [
        ("lint", "ruff check", "--config pyproject.toml"),
        ("format-check", "ruff format", "--config pyproject.toml"),
        ("typecheck", "mypy", "--config-file pyproject.toml"),
        ("test", "pytest", "-c pyproject.toml"),
        ("test", "pytest", "--cov-config=pyproject.toml"),
        ("test", "pytest", "--full-gate"),
    ],
)
def test_each_python_gate_names_its_configuration(target: str, tool: str, flag: str) -> None:
    lines = [line for line in _dry_run(target).splitlines() if f" {tool} " in f" {line} "]
    assert lines, (target, tool)
    assert all(flag in line for line in lines), lines


@pytest.mark.gateproof
def test_the_real_typecheck_recipe_ignores_a_competing_mypy_ini(tmp_path: Path) -> None:
    """A mypy.ini that narrows checking to one clean file must not change what the recipe checks."""
    shutil.copy(REPO_ROOT / "pyproject.toml", tmp_path / "pyproject.toml")
    for directory in ("packages", "services", "tools"):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / f"{directory}_ok.py").write_text("X = 1\n")
    (tmp_path / "tools" / "ok.py").write_text("X = 1\n")
    (tmp_path / "conftest.py").write_text("X = 1\n")
    (tmp_path / "packages" / "untyped.py").write_text("def add(a, b):\n    return a + b\n")
    (tmp_path / "mypy.ini").write_text("[mypy]\nfiles = tools/ok.py\n")
    recipe = next(line for line in _dry_run("typecheck").splitlines() if " mypy" in f" {line}")
    args = shlex.split(recipe.split(" mypy", 1)[1])
    result = proc.run("mypy", args, cwd=tmp_path)
    assert result.returncode == 1, result.stdout
    assert "packages/untyped.py" in result.stdout
