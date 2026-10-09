"""Push-safety proofs (global pre-push bar item 5). Lifted from TechnoMile (ATTRIBUTIONS.md); the
.env.local.example allowance and the hidden-case refusal (D-014) are this repo's additions."""

from pathlib import Path

import pytest

from tools import check_push_clean as pc
from tools import proc
from tools.tests.conftest import REPO_ROOT, git_commit_all, git_init


@pytest.mark.gateproof
@pytest.mark.parametrize(
    ("path", "problem"),
    [
        (".env", "environment file"),
        ("services/api/.env.local", "environment file"),
        ("deploy/server.pem", "private key"),
        ("keys/id_ed25519", "private key"),
        (".tools/bin/tool", "local tool"),
        ("web/coverage/index.json", "local tool"),
        ("debug.log", "local tool"),
        (".env.local", "environment file"),
        (".env.local.public", "environment file"),
        ("services/subject/.env.local.subject", "environment file"),
        (".env.local.example.bak", "environment file"),
        ("cases/hidden/F10/family.json", "hidden case families"),
        ("cases/hidden/.keep", "hidden case families"),
    ],
)
def test_forbidden_paths_fail(path: str, problem: str) -> None:
    assert any(problem in e for e in pc.path_errors(path, 10))


def test_allowed_paths_and_size_cap() -> None:
    assert pc.path_errors(".env.example", 10) == []
    assert pc.path_errors(".env.local.example", 10) == []
    assert pc.path_errors("cases/dev/seed-plan.json", 10) == []
    assert pc.path_errors("docs/spec/cases-hidden-notes.md", 10) == []
    assert pc.path_errors("packages/core/src/arena_core/config.py", 10) == []
    assert pc.path_errors("big.bin", pc.MAX_BYTES + 1) == [
        f"big.bin: {pc.MAX_BYTES + 1} bytes exceeds the {pc.MAX_BYTES}-byte cap for committed files"
    ]


@pytest.mark.gateproof
def test_home_paths_fail_in_code_but_not_in_docs() -> None:
    line = 'ROOT = "/' + 'Users/someone/project"\n'
    assert len(pc.content_errors("services/api/src/arena_api/cfg.py", line)) == 1
    assert len(pc.content_errors("Dockerfile", line)) == 1
    assert len(pc.content_errors(".env.local.example", line)) == 1
    assert pc.content_errors("docs/research/notes.md", line) == []
    assert pc.content_errors("web/public/logo.svg", line) == []


def test_main_on_scratch_repo(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    (tmp_path / "blob.bin").write_bytes(b"\xff\xfe")
    git_commit_all(tmp_path, "base")
    assert pc.main(["--root", str(tmp_path), "--base", "HEAD"]) == 0
    (tmp_path / ".env").write_text("TOKEN=\n")
    assert pc.main(["--root", str(tmp_path), "--base", "HEAD"]) == 1


@pytest.mark.gateproof
def test_index_entry_deleted_only_in_the_worktree_still_fails(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    git_commit_all(tmp_path, "base")
    (tmp_path / ".env").write_text("TOKEN=\n")
    proc.run("git", ["-C", str(tmp_path), "add", ".env"], check=True)
    (tmp_path / ".env").unlink()
    assert pc.main(["--root", str(tmp_path), "--base", "HEAD"]) == 1


@pytest.mark.gateproof
def test_file_committed_then_deleted_in_the_branch_fails(tmp_path: Path) -> None:
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    git_commit_all(tmp_path, "base")
    proc.run("git", ["-C", str(tmp_path), "checkout", "-q", "-b", "feature"], check=True)
    (tmp_path / "server.pem").write_text("not really a key\n")
    git_commit_all(tmp_path, "add key")
    (tmp_path / "server.pem").unlink()
    git_commit_all(tmp_path, "remove key")
    assert pc.main(["--root", str(tmp_path), "--base", "main"]) == 1
    assert pc.main(["--root", str(tmp_path), "--base", "feature"]) == 0


@pytest.mark.gateproof
def test_a_file_renamed_into_hidden_cases_then_deleted_fails(tmp_path: Path) -> None:
    """Codex round 2, finding 3: rename detection reported the move as R, which an A-only filter skipped."""
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    git_commit_all(tmp_path, "base")
    proc.run("git", ["-C", str(tmp_path), "checkout", "-q", "-b", "feature"], check=True)
    (tmp_path / "notes.json").write_text('{"family": "F10", "facts": "hidden"}\n')
    git_commit_all(tmp_path, "add notes")
    (tmp_path / "cases" / "hidden").mkdir(parents=True)
    proc.run("git", ["-C", str(tmp_path), "mv", "notes.json", "cases/hidden/F10.json"], check=True)
    git_commit_all(tmp_path, "move into hidden")
    (tmp_path / "cases" / "hidden" / "F10.json").unlink()
    git_commit_all(tmp_path, "delete")
    assert pc.history_paths(tmp_path, "main") == ["cases/hidden/F10.json", "notes.json"]
    assert pc.main(["--root", str(tmp_path), "--base", "main"]) == 1


@pytest.mark.gateproof
def test_a_non_ascii_path_in_history_is_read_unquoted(tmp_path: Path) -> None:
    """Without -z, git prints this path quoted and octal-escaped, so the cases/hidden/ check never matched."""
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    git_commit_all(tmp_path, "base")
    proc.run("git", ["-C", str(tmp_path), "checkout", "-q", "-b", "feature"], check=True)
    hidden = tmp_path / "cases" / "hidden" / "caf\u00e9.json"
    hidden.parent.mkdir(parents=True)
    hidden.write_text("{}\n")
    git_commit_all(tmp_path, "add")
    hidden.unlink()
    git_commit_all(tmp_path, "delete")
    assert pc.history_paths(tmp_path, "main") == ["cases/hidden/caf\u00e9.json"]
    assert pc.main(["--root", str(tmp_path), "--base", "main"]) == 1


def test_snapshot_mode(tmp_path: Path) -> None:
    (tmp_path / "ok.py").write_text("x = 1\n")
    assert pc.main(["--root", str(tmp_path), "--snapshot"]) == 0
    (tmp_path / "id_rsa").write_text("x\n")
    assert pc.main(["--root", str(tmp_path), "--snapshot"]) == 1


def test_main_fails_closed_outside_a_repo_or_on_a_bad_base(tmp_path: Path) -> None:
    assert pc.main(["--root", str(tmp_path / "missing")]) == 1
    git_init(tmp_path)
    (tmp_path / "ok.py").write_text("x = 1\n")
    git_commit_all(tmp_path, "base")
    assert pc.main(["--root", str(tmp_path), "--base", "no-such-ref"]) == 1


def test_this_repository_is_push_clean() -> None:
    assert pc.main(["--root", str(REPO_ROOT), "--base", "HEAD"]) == 0
