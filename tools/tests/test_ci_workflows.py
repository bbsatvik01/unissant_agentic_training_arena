"""The GitHub workflows run the same gates as `make check` (S5 11.3: no separately softened CI path), on
every change, against the state before the change, with every action pinned to a full commit SHA and the
same scanner versions tools/ensure_tools.sh pins. Pins the fixes for Codex round 1 findings 3 to 6."""

import re

from tools.tests.conftest import REPO_ROOT

WORKFLOWS = {p.name: p.read_text() for p in sorted((REPO_ROOT / ".github" / "workflows").glob("*.yml"))}
ENSURE_TOOLS = (REPO_ROOT / "tools" / "ensure_tools.sh").read_text()


def pinned(variable: str) -> str:
    match = re.search(rf"^{variable}=(\S+)$", ENSURE_TOOLS, flags=re.MULTILINE)
    assert match is not None, variable
    return match.group(1)


def test_the_three_workflows_exist() -> None:
    # CodeQL (security-extended) runs only locally, inside `make sec-check` (tools/check_codeql.py):
    # code-scanning upload needs a GitHub Advanced Security license this private repo does not carry,
    # so there is no codeql.yml workflow (owner decision, 2026-10-15).
    assert set(WORKFLOWS) == {"ci.yml", "pr-title.yml", "security.yml"}


def test_no_workflow_filters_paths() -> None:
    """A path filter lets a change skip push-clean, the secret scans or CodeQL (finding 4)."""
    for name, text in WORKFLOWS.items():
        assert not re.search(r"^\s*paths(-ignore)?\s*:", text, flags=re.MULTILINE), name


def test_every_action_is_pinned_to_a_full_commit_sha_and_names_its_release() -> None:
    for name, text in WORKFLOWS.items():
        for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(.+?)\s*$", text, flags=re.MULTILINE):
            assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)+", ref), (name, ref)


def test_ci_runs_the_python_gate_through_make_against_the_pre_change_base() -> None:
    ci = WORKFLOWS["ci.yml"]
    assert 'base="$(tools/ci_base_ref.sh)"' in ci
    assert 'make deps-sync tools-sync py-check BASE_REF="$base"' in ci
    assert "origin/main" not in ci


def test_ci_runs_the_database_gate_through_make() -> None:
    """db-test (WP-03) runs in CI through the same make target as locally, never a softened copy."""
    ci = WORKFLOWS["ci.yml"]
    assert "run: make deps-sync db-test" in ci


def test_security_runs_the_python_scans_and_the_complete_gitleaks_scan_through_make() -> None:
    security = WORKFLOWS["security.yml"]
    assert "run: make deps-sync bandit semgrep pip-audit licenses" in security
    assert "run: make tools-sync gitleaks SYNC_TOOLS=gitleaks" in security


def test_ci_scanners_run_the_versions_ensure_tools_pins() -> None:
    security = WORKFLOWS["security.yml"]
    assert f'GITLEAKS_VERSION: "{pinned("GL")}"' in security
    assert f'version: "{pinned("TH")}"' in security
    assert f"trufflesecurity/trufflehog@f714bf454f350590f4a24c3ddb1aef02c35bf5b6 # v{pinned('TH')}" in security
    osv = rf"osv-scanner-reusable\.yml@[0-9a-f]{{40}} # v{re.escape(pinned('OSV'))}$"
    assert re.search(osv, security, flags=re.MULTILINE)
    assert "fail-on-vuln: true" in security
