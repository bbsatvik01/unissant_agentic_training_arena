"""No-rigging scan (global hard gate: never rig, soften or bypass CI/tests): forbidden gate
suppressions and hidden code paths fail the build.

Scans every tracked or new (not git-ignored) source and config file for the suppression markers
this gate forbids. A marker passes only when tools/gates/suppressions-allowlist.toml names that file,
that marker and the whole line, stripped of surrounding whitespace (``line``), with a reason: a verified
false positive, narrowest scope. The line is compared for equality, never as a substring, so widening an
approved directive (an extra rule code, a second directive, a bare form) no longer matches its entry.
Allowlist entries that match nothing fail. Python under docs/ (which the linters skip as frozen research
evidence) must stay inside the one archive root. A file that is itself a
suppression list counts every entry line as a finding under the matching inline marker, so it needs the
same reviewed allowlist entry: ``.gitleaksignore`` (fingerprints gitleaks skips, locally and in CI) and a
gitleaks config (``.gitleaks.toml`` / ``gitleaks.toml``, loaded automatically by the CLI and the Action;
it can allowlist findings, disable rules, or replace the default rule set). YAML is also read as YAML:
``continue-on-error`` is judged on the parsed document, so a value on the next line, a block scalar, an
alias or a flow mapping counts as GitHub's parser reads it, and only a plain boolean false passes; a YAML
file the parser cannot read fails closed.

``--snapshot`` scans a plain directory (every file in it) instead of a git worktree: the pre-commit
hook exports the index with ``git checkout-index`` and scans that, i.e. exactly what will be committed.
"""

import argparse
import re
import subprocess
import sys
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import yaml

from tools import proc

ALLOWLIST_PATH = "tools/gates/suppressions-allowlist.toml"
DOCS_PY_ARCHIVES = ("docs/research/",)
MARKERS_PATH = "tools/gates/suppression-markers.toml"
POLICY_FILES = {ALLOWLIST_PATH, MARKERS_PATH}  # name markers as data; validated on load
SCANNED_SUFFIXES = {".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".toml", ".yaml", ".yml"}
SCANNED_SUFFIXES |= {".json", ".cfg", ".ini", ".sh", ".txt"}
# A whole file whose entries are suppressions -> the marker each non-blank, non-comment line counts as.
SUPPRESSION_FILES = {
    ".gitleaksignore": "gitleaks-allow",
    ".gitleaks.toml": "gitleaks-allow",
    "gitleaks.toml": "gitleaks-allow",
}
SCANNED_NAMES = {"Makefile", "Dockerfile", "pre-commit", "pre-push", *SUPPRESSION_FILES}
YAML_SUFFIXES = {".yaml", ".yml"}
CONTINUE_ON_ERROR = "continue-on-error"
# The only value that leaves a failing job or step failing: a plain (unquoted) YAML boolean false.
FALSE_SPELLINGS = {"false", "False", "FALSE"}


def load_markers(text: str) -> dict[str, re.Pattern[str]]:
    """Marker regexes from the policy file; ``ids`` must list exactly the ``patterns`` keys."""
    data = tomllib.loads(text)
    ids, patterns = data.get("ids"), data.get("patterns")
    if not isinstance(ids, list) or not isinstance(patterns, dict) or sorted(ids) != sorted(patterns):
        msg = f"{MARKERS_PATH}: `ids` must list exactly the keys of [patterns]"
        raise ValueError(msg)
    return {str(k): re.compile(str(v)) for k, v in patterns.items()}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    marker: str
    text: str


@dataclass(frozen=True)
class Allowance:
    """One verified exception: a marker in one file, only on a line whose stripped text equals ``line``."""

    path: str
    marker: str
    line: str

    def covers(self, finding: Finding) -> bool:
        return finding.path == self.path and finding.marker == self.marker and finding.text == self.line


def load_allowlist(text: str, markers: dict[str, re.Pattern[str]]) -> list[Allowance]:
    """Every entry needs path, a known marker, the exact stripped ``line`` and a reason."""
    allowed: list[Allowance] = []
    for entry in tomllib.loads(text).get("allow", []):
        path, marker, line, reason = (entry.get(k) for k in ("path", "marker", "line", "reason"))
        if not all(isinstance(v, str) and v.strip() for v in (path, marker, line, reason)):
            msg = f"allowlist entry needs non-empty path, marker, line and reason: {entry!r}"
            raise ValueError(msg)
        if marker not in markers:
            msg = f"allowlist entry names unknown marker {marker!r}"
            raise ValueError(msg)
        allowed.append(Allowance(str(path), str(marker), str(line).strip()))
    return allowed


def is_scanned(path: str) -> bool:
    if path.startswith("docs/") or path in POLICY_FILES:
        return False
    name = path.rsplit("/", 1)[-1]
    return name in SCANNED_NAMES or Path(name).suffix in SCANNED_SUFFIXES


def scan_text(path: str, text: str, markers: dict[str, re.Pattern[str]]) -> list[Finding]:
    findings: list[Finding] = []
    whole_file_marker = SUPPRESSION_FILES.get(path.rsplit("/", 1)[-1])
    for number, line in enumerate(text.splitlines(), start=1):
        if whole_file_marker is not None and line.strip() and not line.lstrip().startswith("#"):
            findings.append(Finding(path, number, whole_file_marker, line.strip()))
        for marker, pattern in markers.items():
            if pattern.search(line):
                findings.append(Finding(path, number, marker, line.strip()))
    return findings


def _plain_false(node: yaml.Node) -> bool:
    return isinstance(node, yaml.ScalarNode) and node.style is None and node.value in FALSE_SPELLINGS


def yaml_findings(path: str, text: str) -> list[Finding]:
    """``continue-on-error`` anywhere in the parsed documents with any value but a plain boolean false."""
    lines = text.splitlines()
    findings: list[Finding] = []
    for document in yaml.compose_all(text, Loader=yaml.SafeLoader):
        stack: list[yaml.Node] = [document]
        seen: set[int] = set()
        while stack:
            node = stack.pop()
            if id(node) in seen:
                continue
            seen.add(id(node))
            if isinstance(node, yaml.MappingNode):
                for key, value in node.value:
                    if isinstance(key, yaml.ScalarNode) and key.value == CONTINUE_ON_ERROR and not _plain_false(value):
                        row = key.start_mark.line
                        findings.append(Finding(path, row + 1, CONTINUE_ON_ERROR, lines[row].strip()))
                    stack.extend((key, value))
            elif isinstance(node, yaml.SequenceNode):
                stack.extend(node.value)
    return findings


def docs_python_errors(paths: list[str]) -> list[str]:
    """The linters skip docs/ (frozen research evidence); new Python there must not escape them."""
    return [
        f"{p}: Python under docs/ outside {DOCS_PY_ARCHIVES} escapes the linters"
        for p in paths
        if p.startswith("docs/") and p.endswith(".py") and not p.startswith(DOCS_PY_ARCHIVES)
    ]


def check(
    paths: list[str],
    read: Callable[[str], bytes],
    allowed: list[Allowance],
    markers: dict[str, re.Pattern[str]],
) -> list[str]:
    errors: list[str] = []
    used: set[Allowance] = set()
    for path in paths:
        if not is_scanned(path):
            continue
        try:
            text = read(path).decode("utf-8")
        except UnicodeDecodeError as exc:
            errors.append(f"{path}: not UTF-8 text ({exc.reason}); the suppression scan cannot read it")
            continue
        findings = scan_text(path, text, markers)
        if Path(path).suffix in YAML_SUFFIXES:
            try:
                findings += yaml_findings(path, text)
            except yaml.YAMLError as exc:
                reason = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
                errors.append(f"{path}: not valid YAML ({reason}); the suppression scan cannot read it")
                continue
        for finding in dict.fromkeys(findings):  # one finding per (line, marker) when the two scans agree
            covering = [a for a in allowed if a.covers(finding)]
            used.update(covering)
            if not covering:
                where = f"{finding.path}:{finding.line}"
                errors.append(f"{where}: forbidden suppression [{finding.marker}] {finding.text[:160]}")
    errors.extend(
        f"{a.path}: stale allowlist entry [{a.marker}] {a.line!r} matches nothing" for a in allowed if a not in used
    )
    errors.extend(docs_python_errors(paths))
    return errors


def worktree_source(root: Path) -> tuple[list[str], Callable[[str], bytes]]:
    return proc.repo_files(root), lambda path: (root / path).read_bytes()


def snapshot_source(root: Path) -> tuple[list[str], Callable[[str], bytes]]:
    paths = sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    return paths, lambda path: (root / path).read_bytes()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--snapshot", action="store_true", help="root is an exported index, not a git worktree")
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        paths, read = snapshot_source(root) if args.snapshot else worktree_source(root)
        markers = load_markers(read(MARKERS_PATH).decode())
        allowed = load_allowlist(read(ALLOWLIST_PATH).decode(), markers)
        errors = check(paths, read, allowed, markers)
    except (OSError, LookupError, ValueError, subprocess.CalledProcessError, tomllib.TOMLDecodeError) as exc:
        sys.stderr.write(f"no-rigging: FAIL: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"no-rigging: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write("no-rigging: OK (no unallowlisted suppressions)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
