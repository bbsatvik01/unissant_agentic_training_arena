"""Shared helpers for gate tests. Lifted from TechnoMile tools/tests/conftest.py (ATTRIBUTIONS.md); the
fake-gcloud helper stays behind until the hosted cost audit it serves arrives (WP-33)."""

from pathlib import Path

from tools import proc

REPO_ROOT = Path(__file__).resolve().parents[2]


def git_init(root: Path) -> None:
    proc.run("git", ["init", "-q", "-b", "main", str(root)], check=True)


def git_commit_all(root: Path, message: str) -> None:
    proc.run("git", ["-C", str(root), "add", "-A"], check=True)
    identity = ["-c", "user.name=gate-test", "-c", "user.email=gate-test@example.invalid", "-c", "commit.gpgsign=false"]
    proc.run("git", ["-C", str(root), *identity, "commit", "-q", "-m", message], check=True)
