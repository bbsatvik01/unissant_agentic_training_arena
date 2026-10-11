"""scripts/dev.sh (WP-13): the disposable local database never writes or deletes the repository root's
`.env.local*` files (the owner's Supabase role files), refuses to overwrite its own, and `up` generates a root
`.env.local` only when one is absent. Docker, psql and uv are stubs; the root files are sentinels compared by
hash, never printed."""

from __future__ import annotations

import hashlib
import shlex
import shutil
import stat
import sys
from pathlib import Path

import pytest

from tools import proc

REPO_ROOT = Path(__file__).resolve().parents[2]
OWNER_ONLY = 0o600
ROOT_FILES = (".env.local", ".env.local.public", ".env.local.subject", ".env.local.referee")
STUB = """
import sys
tool, args = sys.argv[1], sys.argv[2:]
if tool == "docker" and args[:1] == ["inspect"]:
    if "-f" not in args:
        sys.exit(1)  # no such container yet
    if "Health" in args[args.index("-f") + 1]:
        print("healthy")
    sys.exit(0)
if tool == "docker" and args[:1] == ["port"]:
    print("127.0.0.1:55001")
if tool == "uv" and any("user_id_for" in a for a in args):
    print("00000000-0000-0000-0000-00000000000a")
if tool == "psql" and "-f" in args and args[args.index("-f") + 1] == "-":
    sys.stdin.read()
sys.exit(0)
"""


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "scripts" / "dev.sh", root / "scripts" / "dev.sh")
    (root / "supabase" / "migrations").mkdir(parents=True)
    (root / "supabase" / "migrations" / "0001.sql").write_text("select 1;\n")
    (root / "supabase" / "tests" / "harness").mkdir(parents=True)
    (root / "supabase" / "tests" / "harness" / "fixtures.psql").write_text("select 1;\n")
    (root / "prompts" / "manifests").mkdir(parents=True)
    (root / "prompts" / "manifests" / "A1.json").write_text('{"kind": "assistant"}\n')
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "stub.py").write_text(STUB)
    for tool in ("docker", "psql", "uv"):
        wrapper = bindir / tool
        wrapper.write_text(
            f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(bindir / "stub.py"))} {tool} "$@"\n'
        )
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    python = bindir / "python3"
    python.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} "$@"\n')
    python.chmod(python.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    return root


def dev(root: Path, *args: str) -> tuple[int, str]:
    result = proc.run("bash", [str(root / "scripts" / "dev.sh"), *args])
    return result.returncode, result.stdout + result.stderr


def digests(root: Path) -> dict[str, str]:
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ROOT_FILES}


def owner_files(root: Path) -> dict[str, str]:
    for name in ROOT_FILES:
        (root / name).write_text(f"SENTINEL_{name}\n")
    return digests(root)


def test_db_up_and_down_never_touch_the_root_env_files(repo: Path) -> None:
    before = owner_files(repo)
    code, out = dev(repo, "db-up")
    assert code == 0, out
    assert digests(repo) == before
    local = repo / ".run" / "localdb"
    assert sorted(p.name for p in local.iterdir()) == [*sorted(ROOT_FILES), "users.toml"]
    assert "ARENA_PUBLIC_DSN=postgresql://arena_public:" in (local / ".env.local.public").read_text()
    assert stat.S_IMODE((local / ".env.local.public").stat().st_mode) == OWNER_ONLY
    code, out = dev(repo, "db-down")
    assert code == 0, out
    assert digests(repo) == before
    assert list(local.iterdir()) == []


def test_db_up_refuses_to_overwrite_its_own_files(repo: Path) -> None:
    local = repo / ".run" / "localdb"
    local.mkdir(parents=True)
    (local / ".env.local.subject").write_text("KEEP\n")
    code, out = dev(repo, "db-up")
    assert code != 0
    assert "exists" in out
    assert (local / ".env.local.subject").read_text() == "KEEP\n"


def test_up_generates_a_missing_root_env_local_and_never_overwrites_one(repo: Path) -> None:
    code, out = dev(repo, "up")  # no role files in the root: it stops after generating .env.local
    assert code != 0
    assert "missing" in out
    text = (repo / ".env.local").read_text()
    assert "ARENA_MODEL_MODE=fake" in text
    assert "ARENA_GCP_PROJECT=cna-guardian" in text
    assert "ARENA_DEV_USER=dev@arena.local" in text
    assert "_DSN" not in text
    (repo / ".env.local").write_text("SENTINEL\n")
    before = hashlib.sha256((repo / ".env.local").read_bytes()).hexdigest()
    dev(repo, "up")
    assert hashlib.sha256((repo / ".env.local").read_bytes()).hexdigest() == before
