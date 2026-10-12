"""`make isolation-reports` (S3 9; D-022): runs IG-1, IG-2 and IG-3's own REAL suites against this checkout
and posts their real report text to the already-running local arena-referee's `POST /api/admin/isolation-gate/run`
(S5 5.5; `arena_referee.routes.admin`, unchanged here -- IG-4, IG-5 and IG-6 are computed there, live, from
the database). Never fabricates a pass: each suite's own exit code is `passed`; its captured stdout and
stderr, verbatim, is `report_text`.

IG-1 the pgTAP privilege suite (`tools/isolation_gate_pgtap.sh`: `supabase/tests/harness/db_test.sh`'s own
    "plain path" duplicated into its own tool, never a second caller added to that proven gate script -- one
    disposable plain PostgreSQL 17 + pgTAP container, every `supabase/tests/*.sql` file through
    `run_pgtap.sh`). Its own per-property files, picked from `docs/spec/sql/TESTS.md` section 0's harness
    (S3 9: "forged turn, cross-trial call, duplicate and replayed work items, stale transcript version,
    concurrent calls, wrong role, wrong state"):
      001_capability_matrix.sql      per-role, per-function privilege matrix (wrong role)
      003_role_reads.sql             "role cannot read X" (wrong role)
      004_turns_and_versions.sql     stale transcript version (SV-01..04); wrong state (SV-06, SV-12)
      005_release_evidence.sql       cross-trial, duplicate and replayed release work items (RE-08..12)
      006_record_subject_turn.sql    forged turn (ST-02..04); cross-trial (ST-06); replayed (ST-05)
      007_coaching_events_caller.sql duplicate work item (CC-03); caller separation (CC-14..17)
      008_finalize_commitment.sql    duplicate and replayed work items (FC-02/03); wrong state (FC-05/13)
      009_execution_failures.sql     wrong state (EF-02, 04, 06, 08, 10, 11)
      010_concurrency.sql            concurrent calls (CO-01..09)
    The whole suite runs every time (`run_pgtap.sh`'s own all-or-nothing per-file TAP verdict, never a
    narrowed run); the list above documents which file proves which property S3 9 names.
IG-2 the capability-matrix route tests (S3 9: every investigator route, SSE, reconnect and export with an
    investigator account; direct calls to arena-subject and arena-referee without the per-run service token
    refused): `services/api/tests/test_app.py`, `services/subject/tests/test_app.py`,
    `services/subject/tests/test_internal_auth.py`, `services/referee/tests/test_app.py`.
IG-3 the assistant-context type test (S3 9; S5 1.2 item 3: "mypy and a runtime check"): the static check
    (`typing.get_type_hints` on `build_coach_prompt`, every Pydantic model reachable from `PublicTrialView`)
    and the runtime assertion (`arena_core.agents.templates.require` refuses any other type) are both already
    proved in `packages/core/tests/agents/test_coach_prompts.py` (S8-build-plan.md line 620's own acceptance
    line); this runs exactly those two tests, never adds a new one.

Needs the local stack's arena-referee already running (`scripts/dev.sh up`) and, for IG-1, Docker.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence
from pathlib import Path

from scripts.referee_admin_client import DEFAULT_BASE_URL, AdminCallError, admin_post
from tools import proc

ROOT = Path(__file__).resolve().parents[1]
IG1_SCRIPT = ROOT / "tools" / "isolation_gate_pgtap.sh"
IG2_FILES = (
    "services/api/tests/test_app.py",
    "services/subject/tests/test_app.py",
    "services/subject/tests/test_internal_auth.py",
    "services/referee/tests/test_app.py",
)
IG3_SELECT = (
    "packages/core/tests/agents/test_coach_prompts.py"
    "::test_at_coach_1_builder_types_reach_no_private_or_evaluator_type",
    "packages/core/tests/agents/test_coach_prompts.py::test_at_coach_1_the_builder_refuses_any_other_input_type_at_runtime",
)
HEX_DIGITS = frozenset("0123456789abcdef")
GIT_SHA_LEN = 40


def current_git_sha() -> str:
    return proc.run("git", ["rev-parse", "HEAD"], cwd=ROOT).stdout.strip()


def is_commit_sha(value: str) -> bool:
    """A full, lowercase 40-hex commit sha (the referee's own `commit_sha` column pattern): checked here
    too, whether `value` came from `git rev-parse HEAD` or an operator's `--git-sha` override, so a bad
    override fails fast rather than reaching the referee as some other string."""
    return len(value) == GIT_SHA_LEN and set(value) <= HEX_DIGITS


def run_ig1() -> tuple[bool, str]:
    """The real pgTAP suite (`tools/isolation_gate_pgtap.sh`); needs Docker."""
    result = proc.run("bash", [str(IG1_SCRIPT)], cwd=ROOT)
    return result.returncode == 0, result.stdout + result.stderr


def _run_pytest(args: Sequence[str]) -> tuple[bool, str]:
    result = proc.run(
        "uv",
        [
            "run",
            "--locked",
            "pytest",
            "-c",
            "pyproject.toml",
            "--rootdir",
            ".",
            "-p",
            "no:cacheprovider",
            "-W",
            "error",
            *args,
        ],
        cwd=ROOT,
    )
    return result.returncode == 0, result.stdout + result.stderr


def run_ig2() -> tuple[bool, str]:
    """The capability-matrix route tests."""
    return _run_pytest(IG2_FILES)


def run_ig3() -> tuple[bool, str]:
    """The assistant-context type test (the static check and the runtime assertion, both already written)."""
    return _run_pytest(IG3_SELECT)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--git-sha", default=None, help="defaults to git rev-parse HEAD")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="the local arena-referee origin")
    args = parser.parse_args(argv)

    git_sha = args.git_sha or current_git_sha()
    if not is_commit_sha(git_sha):
        sys.stderr.write(f"isolation_reports: not a 40-hex commit sha: {git_sha!r}\n")
        return 1
    ig1 = run_ig1()
    ig2 = run_ig2()
    ig3 = run_ig3()
    for name, (passed, _report) in (("IG-1", ig1), ("IG-2", ig2), ("IG-3", ig3)):
        sys.stdout.write(f"isolation_reports: {name} {'PASS' if passed else 'FAIL'}\n")

    body = {
        "ig1": {"passed": ig1[0], "report_text": ig1[1]},
        "ig2": {"passed": ig2[0], "report_text": ig2[1]},
        "ig3": {"passed": ig3[0], "report_text": ig3[1]},
    }
    try:
        result = asyncio.run(admin_post("/api/admin/isolation-gate/run", body, base_url=args.base_url))
    except AdminCallError as exc:
        sys.stderr.write(f"isolation_reports: the referee refused the run (commit {git_sha}): {exc}\n")
        return 1
    sys.stdout.write(f"isolation_reports: referee recorded, commit {git_sha}: {result}\n")
    return 0 if (ig1[0] and ig2[0] and ig3[0]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
