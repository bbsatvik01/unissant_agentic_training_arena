"""scripts/dev.sh (WP-13): the disposable local database never writes or deletes the repository root's
`.env.local*` files (the owner's Supabase role files), refuses to overwrite its own, and `up` generates a root
`.env.local` only when one is absent. Docker, psql and uv are stubs; the root files are sentinels compared by
hash, never printed."""

from __future__ import annotations

import hashlib
import json
import re
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
import json, os, sys
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
if tool == "uv" and "run" in args and os.environ.get("ARENA_ROLE"):
    keep = {k: v for k, v in os.environ.items() if k.startswith("ARENA_") and k != "ARENA_LOCAL_CALLERS"}
    with open(os.path.join(os.path.dirname(__file__), "..", "children.log"), "a") as log:
        print(json.dumps({"argv": args, "env": keep}), file=log)
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
    monkeypatch.delenv("ENV_DIR", raising=False)
    git = ("git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.invalid")
    proc.run(git[0], [*git[1:], "init", "-q"])
    proc.run(git[0], [*git[1:], "add", "-A"])
    proc.run(git[0], [*git[1:], "commit", "-q", "-m", "fixture"])
    return root


def head_sha(root: Path) -> str:
    return proc.run("git", ["-C", str(root), "rev-parse", "HEAD"]).stdout.strip()


def children(root: Path) -> list[dict[str, object]]:
    """What each launched child saw: the stub appends it next to its own bin directory (children run with a
    clean environment, so nothing else can tell the stub where to write)."""
    log = root.parent / "children.log"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def two_configs(root: Path) -> None:
    """Synthetic root (as the owner's) and .run/localdb settings, each naming its own database."""
    local = root / ".run" / "localdb"
    local.mkdir(parents=True)
    for where, tag in ((root, "root"), (local, "local")):
        (where / ".env.local").write_text(f"ARENA_ENV=local\nARENA_CASE_DRAW_SEED={tag}\n")
        for file, var in (("public", "PUBLIC"), ("subject", "SUBJECT"), ("referee", "REFEREE")):
            (where / f".env.local.{file}").write_text(f"ARENA_{var}_DSN=postgresql://{tag}-{file}@127.0.0.1:1/x\n")


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


def test_db_up_refuses_a_symlink_that_points_at_a_root_file(repo: Path) -> None:
    local = repo / ".run" / "localdb"
    local.mkdir(parents=True)
    (local / ".env.local").symlink_to(repo / ".env.local")  # dangling: the root file does not exist
    code, out = dev(repo, "db-up")
    assert code != 0
    assert "exists" in out
    assert not (repo / ".env.local").exists()


def test_a_symlinked_local_directory_is_refused_and_the_root_files_survive(repo: Path) -> None:
    before = owner_files(repo)
    (repo / ".run").mkdir()
    (repo / ".run" / "localdb").symlink_to(repo)
    for command in ("db-down", "db-up"):
        code, out = dev(repo, command)
        assert code != 0
        assert "symlink" in out
    assert digests(repo) == before


@pytest.mark.parametrize("env_dir", [".", "./", "{root}/"])
def test_equivalent_spellings_of_the_root_generate_the_shared_settings(
    repo: Path, monkeypatch: pytest.MonkeyPatch, env_dir: str
) -> None:
    monkeypatch.setenv("ENV_DIR", env_dir.format(root=repo))
    monkeypatch.chdir(repo)
    dev(repo, "up")
    assert "ARENA_MODEL_MODE=fake" in (repo / ".env.local").read_text()


@pytest.mark.parametrize(("env_dir", "tag"), [(None, "root"), (".run/localdb", "local")])
def test_each_child_gets_the_selected_settings_and_only_its_own_credential(
    repo: Path, monkeypatch: pytest.MonkeyPatch, env_dir: str | None, tag: str
) -> None:
    two_configs(repo)
    if env_dir is not None:
        monkeypatch.setenv("ENV_DIR", env_dir)
    code, out = dev(repo, "up")
    assert code == 0, out
    own = {"subject": "ARENA_SUBJECT_DSN", "referee": "ARENA_REFEREE_DSN", "api": "ARENA_PUBLIC_DSN"}
    seen = {}
    for child in children(repo):
        env = child["env"]
        assert isinstance(env, dict)
        role = env["ARENA_ROLE"]
        seen[role] = env
        assert env["ARENA_CASE_DRAW_SEED"] == tag
        assert sorted(k for k in env if k.endswith("_DSN")) == [own[role]]
        assert env[own[role]].startswith(f"postgresql://{tag}-")
    assert sorted(seen) == ["api", "referee", "subject"]
    # The referee refuses to boot without the checkout's commit (its gate evidence binds to it, S3 9).
    sha = head_sha(repo)
    assert re.fullmatch(r"[0-9a-f]{40}", sha)
    assert seen["referee"]["ARENA_GIT_SHA"] == sha


def test_export_run_reads_the_selected_settings(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    two_configs(repo)
    monkeypatch.setenv("ENV_DIR", ".run/localdb")
    code, out = dev(repo, "export-run", "00000000-0000-0000-0000-000000000001")
    assert code == 0, out
    [child] = children(repo)
    env = child["env"]
    assert isinstance(env, dict)
    assert env["ARENA_PUBLIC_DSN"] == "postgresql://local-public@127.0.0.1:1/x"
    assert sorted(k for k in env if k.endswith("_DSN")) == ["ARENA_PUBLIC_DSN"]
