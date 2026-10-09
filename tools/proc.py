"""The one place the gate tools start a subprocess.

argv[0] is always a tool name from TOOLS, resolved to an absolute path: ``git``, ``make``, ``pnpm``, ``uv``
through shutil.which; the pinned security binaries to .tools/bin (installed by tools/ensure_tools.sh); Python tools
to the scripts of the running (locked) environment. No shell, no caller-chosen binary. Keeping the
call here gives Ruff S603 a single, reviewed call site.
"""

import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
_ENV_BIN = Path(sys.executable).parent
PINNED_BINARIES = {
    **{name: REPO_ROOT / ".tools" / "bin" / name for name in ("codeql", "gitleaks", "osv-scanner", "trufflehog")},
    "python": Path(sys.executable),
    **{name: _ENV_BIN / name for name in ("bandit", "diff-cover", "mypy", "pytest")},
}
BATCH_HEADER_FIELDS = 3  # "<sha> <type> <size>"
TOOLS = frozenset({"git", "make", "pnpm", "uv", *PINNED_BINARIES})


class ToolNotFoundError(LookupError):
    """A required tool is not installed."""


def resolve(tool: str) -> str:
    if tool not in TOOLS:
        msg = f"{tool!r} is not an allowed gate tool {sorted(TOOLS)}"
        raise ValueError(msg)
    pinned = PINNED_BINARIES.get(tool)
    if pinned is not None:
        if not pinned.is_file():
            msg = f"{tool} is not installed at {pinned}; run make bootstrap"
            raise ToolNotFoundError(msg)
        return str(pinned)
    found = shutil.which(tool)
    if found is None:
        msg = f"{tool} is not on PATH"
        raise ToolNotFoundError(msg)
    return found


def run_bytes(
    tool: str, args: Sequence[str], *, cwd: Path | None = None, check: bool = False, stdin: bytes | None = None
) -> subprocess.CompletedProcess[bytes]:
    """Run an allowed tool with an argument list and capture raw output (the only subprocess call)."""
    argv = [resolve(tool), *args]
    # S603 flags every non-literal argv; argv[0] is a resolved allowlisted tool and there is no shell.
    return subprocess.run(argv, cwd=cwd, input=stdin, capture_output=True, check=check)  # noqa: S603


def run(
    tool: str, args: Sequence[str], *, cwd: Path | None = None, check: bool = False, stdin: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Run an allowed tool with an argument list and capture text output."""
    raw = run_bytes(tool, args, cwd=cwd, check=check, stdin=None if stdin is None else stdin.encode())
    return subprocess.CompletedProcess(
        raw.args, raw.returncode, raw.stdout.decode(errors="replace"), raw.stderr.decode(errors="replace")
    )


def repo_files(root: Path, *pathspec: str) -> list[str]:
    """Tracked plus untracked-but-not-ignored files under root (what the next commit could contain)."""
    args = ["-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *pathspec]
    listed = run("git", args)
    if listed.returncode != 0:
        msg = f"git ls-files failed in {root}: {listed.stderr.strip()}"
        raise LookupError(msg)
    return sorted({p for p in listed.stdout.split("\0") if p and (root / p).is_file()})


def index_files(root: Path) -> list[str]:
    """Every path in the index, whether or not it still exists in the working tree."""
    listed = run("git", ["-C", str(root), "ls-files", "-z", "--cached"])
    if listed.returncode != 0:
        msg = f"git ls-files failed in {root}: {listed.stderr.strip()}"
        raise LookupError(msg)
    return sorted({p for p in listed.stdout.split("\0") if p})


def index_blobs(root: Path, paths: Sequence[str]) -> dict[str, bytes]:
    """Staged content of ``paths`` in one ``git cat-file --batch`` call."""
    if not paths:
        return {}
    request = "".join(f":{path}\n" for path in paths).encode()
    out = run_bytes("git", ["-C", str(root), "cat-file", "--batch"], stdin=request, check=True).stdout
    blobs: dict[str, bytes] = {}
    offset = 0
    for path in paths:
        header_end = out.index(b"\n", offset)
        header = out[offset:header_end].split()
        if len(header) != BATCH_HEADER_FIELDS:
            msg = f"git cat-file could not read :{path}: {out[offset:header_end]!r}"
            raise LookupError(msg)
        size = int(header[2])
        blobs[path] = out[header_end + 1 : header_end + 1 + size]
        offset = header_end + 1 + size + 1
    return blobs
