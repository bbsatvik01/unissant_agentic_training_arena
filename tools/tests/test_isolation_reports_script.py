"""`scripts.isolation_reports` (S3 9; `make isolation-reports`): IG-1..3 run through `tools.proc.run` (mocked
here, never a real Docker container or pytest subprocess) and their real pass/fail and report text posted to
the referee's admin route (mocked too, `scripts.referee_admin_client`)."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from scripts import isolation_reports as ig
from scripts.referee_admin_client import AdminCallError

SHA = "a" * 40


def completed(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["x"], returncode, stdout, stderr)


def test_current_git_sha_strips_the_output(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tools.proc.run", lambda *_a, **_k: completed(f"{SHA}\n"))
    assert ig.current_git_sha() == SHA


@pytest.mark.parametrize(
    ("value", "valid"), [(SHA, True), (SHA.upper(), False), ("short", False), (SHA[:-1] + "g", False)]
)
def test_is_commit_sha(value: str, valid: bool) -> None:
    assert ig.is_commit_sha(value) is valid


def test_run_ig1_runs_the_pgtap_script(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, list[str]]] = []

    def fake_run(tool: str, args: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
        calls.append((tool, list(args)))
        return completed("ok tap output", returncode=0)

    monkeypatch.setattr("tools.proc.run", fake_run)
    passed, report = ig.run_ig1()
    assert (passed, report) == (True, "ok tap output")
    [(tool, args)] = calls
    assert tool == "bash"
    assert args == [str(ig.IG1_SCRIPT)]


def test_run_ig1_reports_a_real_failure_never_fabricating_a_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tools.proc.run", lambda *_a, **_k: completed("", "not ok 3 - SV-04\n", returncode=1))
    passed, report = ig.run_ig1()
    assert passed is False
    assert "not ok 3" in report


def test_run_ig2_runs_pytest_on_the_capability_matrix_route_files(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, list[str]]] = []

    def fake_run(tool: str, args: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
        calls.append((tool, list(args)))
        return completed("4 passed")

    monkeypatch.setattr("tools.proc.run", fake_run)
    passed, report = ig.run_ig2()
    assert (passed, report) == (True, "4 passed")
    [(tool, args)] = calls
    assert tool == "uv"
    assert args[:2] == ["run", "--locked"]
    for f in ig.IG2_FILES:
        assert f in args


def test_run_ig3_selects_exactly_the_two_type_test_node_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run(_tool: str, args: list[str], **_kw: object) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        return completed("2 passed")

    monkeypatch.setattr("tools.proc.run", fake_run)
    passed, _report = ig.run_ig3()
    assert passed is True
    [args] = calls
    assert set(ig.IG3_SELECT) <= set(args)
    assert all("test_coach_prompts.py" in n for n in ig.IG3_SELECT)


def _patch_suites(
    monkeypatch: pytest.MonkeyPatch, *, ig1: bool = True, ig2: bool = True, ig3: bool = True, referee_sha: str = SHA
) -> None:
    monkeypatch.setattr(ig, "current_git_sha", lambda: SHA)

    async def fake_admin_get(*_a: object, **_kw: object) -> dict[str, Any]:
        return {"commit_sha": referee_sha}

    monkeypatch.setattr(ig, "admin_get", fake_admin_get)
    monkeypatch.setattr(ig, "run_ig1", lambda: (ig1, "ig1 report"))
    monkeypatch.setattr(ig, "run_ig2", lambda: (ig2, "ig2 report"))
    monkeypatch.setattr(ig, "run_ig3", lambda: (ig3, "ig3 report"))


def test_main_posts_the_real_reports_and_exits_zero_when_every_suite_passes(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _patch_suites(monkeypatch)
    posted: dict[str, Any] = {}

    async def fake_admin_post(path: str, body: dict[str, Any] | None = None, **_kw: object) -> dict[str, Any]:
        posted["path"] = path
        posted["body"] = body
        return {"passed": True, "evidence_hash": "h", "items": {}}

    monkeypatch.setattr(ig, "admin_post", fake_admin_post)
    assert ig.main([]) == 0
    assert posted["path"] == "/api/admin/isolation-gate/run"
    assert posted["body"] == {
        "ig1": {"passed": True, "report_text": "ig1 report"},
        "ig2": {"passed": True, "report_text": "ig2 report"},
        "ig3": {"passed": True, "report_text": "ig3 report"},
    }
    out = capsys.readouterr().out
    assert "IG-1 PASS" in out
    assert "IG-2 PASS" in out
    assert "IG-3 PASS" in out


def test_main_still_posts_a_real_failure_and_exits_nonzero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Never fabricates a pass: a failing suite is still posted as `passed: false`, verbatim."""
    _patch_suites(monkeypatch, ig2=False)
    posted: dict[str, Any] = {}

    async def fake_admin_post(_path: str, body: dict[str, Any] | None = None, **_kw: object) -> dict[str, Any]:
        posted["body"] = body
        return {"passed": False}

    monkeypatch.setattr(ig, "admin_post", fake_admin_post)
    assert ig.main([]) == 1
    assert posted["body"]["ig2"] == {"passed": False, "report_text": "ig2 report"}
    assert "IG-2 FAIL" in capsys.readouterr().out


def test_main_exits_nonzero_when_ig1_3_pass_but_the_referees_own_verdict_is_false(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Never fabricates a pass: IG-1..3 passing locally is not the gate -- a real IG-4, 5 or 6 failure at the
    referee (S3 9's full six-item verdict) must still fail the command, not just a suite failing locally or
    the referee refusing the call outright."""
    _patch_suites(monkeypatch)

    async def fake_admin_post(*_a: object, **_kw: object) -> dict[str, Any]:
        return {
            "passed": False,
            "evidence_hash": "h",
            "items": {"IG-1": True, "IG-2": True, "IG-3": True, "IG-4": False},
        }

    monkeypatch.setattr(ig, "admin_post", fake_admin_post)
    assert ig.main([]) == 1
    out = capsys.readouterr().out
    assert "IG-1 PASS" in out
    assert "IG-2 PASS" in out
    assert "IG-3 PASS" in out


def test_main_refuses_when_the_referee_is_on_a_different_commit(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """S3 9: results are scoped to the running processes' own commit. Testing checkout A against a referee
    still on commit B must refuse before running anything -- never mind recording evidence -- or B would be
    certified using A's results."""
    other_sha = "b" * 40
    calls: list[str] = []
    _patch_suites(monkeypatch, referee_sha=other_sha)

    def fake_run_ig1() -> tuple[bool, str]:
        calls.append("ig1")
        return True, ""

    monkeypatch.setattr(ig, "run_ig1", fake_run_ig1)

    async def fake_admin_post(*_a: object, **_kw: object) -> dict[str, Any]:
        calls.append("posted")
        return {"passed": True}

    monkeypatch.setattr(ig, "admin_post", fake_admin_post)
    assert ig.main([]) == 1
    assert calls == []  # neither IG-1 nor the post ever ran
    err = capsys.readouterr().err
    assert SHA in err
    assert other_sha in err


def test_main_fails_when_the_referee_commit_check_itself_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_suites(monkeypatch)

    async def fake_admin_get(*_a: object, **_kw: object) -> dict[str, Any]:
        raise AdminCallError(403, "admin role required")

    monkeypatch.setattr(ig, "admin_get", fake_admin_get)
    assert ig.main([]) == 1


def test_main_fails_when_the_referee_refuses_the_post(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _patch_suites(monkeypatch)

    async def fake_admin_post(*_a: object, **_kw: object) -> dict[str, Any]:
        raise AdminCallError(403, "admin role required")

    monkeypatch.setattr(ig, "admin_post", fake_admin_post)
    assert ig.main([]) == 1
    assert "admin role required" in capsys.readouterr().err


def test_main_refuses_a_malformed_git_sha_override_before_running_anything(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_run_ig1() -> tuple[bool, str]:
        calls.append("ig1")
        return True, ""

    monkeypatch.setattr(ig, "run_ig1", fake_run_ig1)
    assert ig.main(["--git-sha", "not-a-sha"]) == 1
    assert calls == []


def test_the_pgtap_script_file_exists_and_is_executable() -> None:
    assert ig.IG1_SCRIPT.is_file()
    assert Path(ig.IG1_SCRIPT).stat().st_mode & 0o111
