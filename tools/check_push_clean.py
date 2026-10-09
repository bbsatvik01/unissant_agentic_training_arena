"""Push-safety (global pre-push bar item 5; S5 11.1 `push-clean`): nothing that must stay local is tracked,
staged, or in the branch history.

Fails on: env files other than the committed example shapes (.env.example, .env.local.example), private
keys and keystores, hidden case families (cases/hidden/, D-014: authored into a git-ignored directory and
never committed), files over the size cap, local tooling or scratch output, and absolute home-directory
paths in code or config (docs/ is research prose and may cite local file paths; code must not depend on
one person's machine).

Default mode reads every index entry from the index (so a file deleted only in the working tree is
still checked), untracked-but-not-ignored files from disk, and every blob version written in
``BASE..HEAD``: each path added, modified or retyped by any commit (merges against each parent), with
that version's real content and size. A file committed then deleted, or grown past the cap then shrunk,
is still pushed, so it still fails. History is read with rename detection off, so a move into a
forbidden path counts as the add it is, and NUL-separated, so git never quotes or escapes a path.
Submodule entries (gitlinks) name a commit, not a blob, and are not read. ``--snapshot`` checks a plain
exported directory.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

from tools import proc

MAX_BYTES = 5 * 1024 * 1024
ENV_FILE = re.compile(r"(^|/)\.env(\.[^/]+)?$")
ENV_EXAMPLES = (".env.example", ".env.local.example")
HIDDEN_CASES = re.compile(r"^cases/hidden(/|$)")
KEY_FILE = re.compile(r"(\.(pem|key|p12|pfx|jks|keystore|ppk)|(^|/)id_(rsa|ecdsa|ed25519)(\.pub)?)$")
LOCAL_OUTPUT = re.compile(r"(^|/)(\.tools|\.gates|\.venv|node_modules|\.next|coverage|htmlcov|scratch|tmp)/|\.log$")
HOME_PATH = re.compile(r"/(Users|home)/[A-Za-z0-9._-]+/")
TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".toml", ".yaml", ".yml", ".sh", ".cfg", ".ini"}
TEXT_NAMES = {"Makefile", "Dockerfile", "pre-commit", ".npmrc", ".gitignore", *ENV_EXAMPLES}


def path_errors(path: str, size: int) -> list[str]:
    errors: list[str] = []
    if ENV_FILE.search(path) and not path.endswith(ENV_EXAMPLES):
        errors.append(f"{path}: environment file must never be committed (only {' and '.join(ENV_EXAMPLES)})")
    if HIDDEN_CASES.search(path):
        errors.append(f"{path}: hidden case families stay in git-ignored cases/hidden/ and are never committed (D-014)")
    if KEY_FILE.search(path):
        errors.append(f"{path}: private key or keystore must never be committed")
    if LOCAL_OUTPUT.search(path):
        errors.append(f"{path}: local tool, build or scratch output must not be committed")
    if size > MAX_BYTES:
        errors.append(f"{path}: {size} bytes exceeds the {MAX_BYTES}-byte cap for committed files")
    return errors


def content_errors(path: str, text: str) -> list[str]:
    name = path.rsplit("/", 1)[-1]
    if path.startswith("docs/") or (Path(name).suffix not in TEXT_SUFFIXES and name not in TEXT_NAMES):
        return []
    return [
        f"{path}:{number}: absolute home-directory path ({match.group(0)}...) in code or config"
        for number, line in enumerate(text.splitlines(), start=1)
        for match in [HOME_PATH.search(line)]
        if match
    ]


def file_errors(path: str, data: bytes) -> list[str]:
    errors = path_errors(path, len(data))
    try:
        text = data.decode("utf-8")
    # silent-ok: a binary file has no text lines to search for home paths; its path and size checks ran above
    except UnicodeDecodeError:
        return errors
    return [*errors, *content_errors(path, text)]


def check(contents: dict[str, bytes], history: list[tuple[str, bytes]]) -> list[str]:
    """Current files, then every historical blob version (``history`` from :func:`history_blobs`)."""
    errors: list[str] = []
    for path, data in sorted(contents.items()):
        errors.extend(file_errors(path, data))
    for path, data in history:
        errors.extend(f"{error} (in branch history)" for error in file_errors(path, data))
    return errors


def repo_contents(root: Path) -> dict[str, bytes]:
    tracked = proc.index_files(root)
    contents = proc.index_blobs(root, tracked)
    untracked = set(proc.repo_files(root)) - set(tracked)
    contents.update({path: (root / path).read_bytes() for path in untracked})
    return contents


GITLINK_MODE = "160000"
NULL_SHA = "0" * 40
RAW_FIELDS = 5  # ":<old mode> <new mode> <old sha> <new sha> <status>"


def history_entries(root: Path, base: str) -> list[tuple[str, str]]:
    """``(path, blob sha)`` for every version written in ``base..HEAD``, sorted and de-duplicated."""
    if proc.run("git", ["-C", str(root), "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"]).returncode:
        msg = f"base ref {base!r} does not resolve to a commit"
        raise LookupError(msg)
    args = ["-C", str(root), "log", "-z", "-m", "--no-renames", "--no-abbrev", "--raw", "--diff-filter=AMT"]
    log = proc.run_bytes("git", [*args, "--format=", f"{base}..HEAD"], check=True).stdout
    parts = log.split(b"\0")
    entries: set[tuple[str, str]] = set()
    for index in range(0, len(parts) - 1, 2):
        meta = parts[index].strip(b"\n").decode("ascii").lstrip(":").split()
        if len(meta) != RAW_FIELDS:
            msg = f"unexpected git log --raw record: {parts[index]!r}"
            raise LookupError(msg)
        _, new_mode, _, new_sha, _ = meta
        if new_mode != GITLINK_MODE and new_sha != NULL_SHA:
            entries.add((parts[index + 1].decode("utf-8", errors="surrogateescape"), new_sha))
    return sorted(entries)


def history_blobs(root: Path, base: str) -> list[tuple[str, bytes]]:
    """The content of every blob version :func:`history_entries` lists, read in one ``git cat-file``."""
    entries = history_entries(root, base)
    blobs = proc.object_blobs(root, sorted({sha for _, sha in entries}))
    return [(path, blobs[sha]) for path, sha in entries]


def snapshot_contents(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file() and not p.is_symlink()}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--base", default="main", help="history from this ref to HEAD is checked too")
    parser.add_argument("--snapshot", action="store_true", help="root is an exported index, not a git worktree")
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        if args.snapshot:
            errors = check(snapshot_contents(root), [])
        else:
            errors = check(repo_contents(root), history_blobs(root, args.base))
    except (OSError, LookupError, ValueError, subprocess.CalledProcessError) as exc:
        sys.stderr.write(f"push-clean: FAIL: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"push-clean: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write("push-clean: OK\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
