"""Shared helpers for gate tests."""

import shlex
import stat
import sys
from pathlib import Path

from tools import proc

REPO_ROOT = Path(__file__).resolve().parents[2]


def git_init(root: Path) -> None:
    proc.run("git", ["init", "-q", "-b", "main", str(root)], check=True)


def git_commit_all(root: Path, message: str) -> None:
    proc.run("git", ["-C", str(root), "add", "-A"], check=True)
    identity = ["-c", "user.name=gate-test", "-c", "user.email=gate-test@example.invalid", "-c", "commit.gpgsign=false"]
    proc.run("git", ["-C", str(root), *identity, "commit", "-q", "-m", message], check=True)


def write_fake_gcloud(bindir: Path, source: str) -> Path:
    """Install a fake ``gcloud`` on PATH: the Python source runs through a /bin/sh wrapper, because a shebang
    cannot hold an interpreter path with spaces (this repo lives under "2026 Fall/Challenge X/...")."""
    script = bindir / "gcloud_fake.py"
    script.write_text(source)
    wrapper = bindir / "gcloud"
    wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    return wrapper
