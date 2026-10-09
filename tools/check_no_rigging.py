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
file the parser cannot read fails closed. Python is also read as Python: a warning filter set to ignore (a
``warnings`` call, ``catch_warnings(action=...)``, the ``warnings.filters`` list, or a
``pytest.mark.filterwarnings`` filter) and a pytest or unittest skip are judged on the syntax tree, with
import aliases resolved and a module reached through another (``unittest.case.warnings``) seen as itself,
so a keyword argument, a call across lines, an alias, the function taken as a value or fetched through
``getattr`` all count. Both checks are allow-lists, never deny-lists: the only filter action that passes is
a literal ``error`` (``ignore``, ``default``, ``always``, ``module``, ``once``, any abbreviation and any
non-literal action weaken -W error and fail), and a guarded module (``warnings``, ``pytest``,
``pytest.mark``, ``unittest``) may only be used as the base of an attribute access or as getattr's object;
assigning it, passing it or returning it is an escape the scan cannot follow, and fails. Python the
parser cannot read fails closed.

``--snapshot`` scans a plain directory (every file in it) instead of a git worktree: the pre-commit
hook exports the index with ``git checkout-index`` and scans that, i.e. exactly what will be committed.
"""

import argparse
import ast
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


PYTHON_SUFFIXES = {".py", ".pyi"}
WARNINGS_IGNORE, PYTEST_SKIP, UNITTEST_SKIP = "warnings-ignore", "pytest-skip", "unittest-skip"
# Canonical names (after import aliases are resolved) whose call sets a warning filter: the action is the
# first positional argument or ``action=``; a pytest mark takes several filter strings, all positional.
WARNING_FILTER_CALLS = {"warnings.filterwarnings", "warnings.simplefilter"}
PYTEST_FILTER_MARK = "pytest.mark.filterwarnings"
CATCH_WARNINGS = "warnings.catch_warnings"
GETATTR_ARGS = 2  # getattr(object, name)
WARNINGS_FILTER_LIST = "warnings.filters"
# Any reference to one of these (a call, a decorator, a value) skips or expects failure.
SKIP_NAMES = {
    **{f"pytest.{n}": PYTEST_SKIP for n in ("skip", "xfail", "importorskip")},
    **{f"pytest.mark.{n}": PYTEST_SKIP for n in ("skip", "skipif", "xfail")},
    **{
        f"{module}.{n}": UNITTEST_SKIP
        for module in ("unittest", "unittest.case")
        for n in ("skip", "skipIf", "skipUnless", "expectedFailure")
    },  # the skip exception is caught by name in every form, so the line scan suffices for it
}
# Modules used only as an attribute base or getattr's object; getattr is judged by the name it fetches (a
# non-literal name fails closed), any other use is an escape.
GUARDED_MODULES = {"warnings": WARNINGS_IGNORE, "pytest": PYTEST_SKIP, "pytest.mark": PYTEST_SKIP}
GUARDED_MODULES |= {"unittest": UNITTEST_SKIP, "unittest.case": UNITTEST_SKIP}
GUARDED_NAMES = {
    **SKIP_NAMES,
    **dict.fromkeys((*WARNING_FILTER_CALLS, PYTEST_FILTER_MARK, CATCH_WARNINGS, WARNINGS_FILTER_LIST), WARNINGS_IGNORE),
}


def _bindings(tree: ast.AST) -> dict[str, str]:
    """Local name -> the module or module attribute it is bound to by an import anywhere in the file."""
    bound: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    bound[alias.asname] = alias.name
                else:
                    head = alias.name.split(".", 1)[0]
                    bound[head] = head
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for alias in node.names:
                bound[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return bound


def _resolve(node: ast.expr, bound: dict[str, str]) -> str | None:
    """The canonical dotted name of a Name/Attribute chain rooted in an imported name, else None."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name) or node.id not in bound:
        return None
    return ".".join([bound[node.id], *reversed(parts)])


KEPT_ACTION = "error"  # the one warning-filter action that keeps -W error intact


def _canonical(name: str) -> str:
    """The longest dotted suffix of ``name`` that is a guarded module or name (``a.warnings.filters`` ->
    ``warnings.filters``), else ``name``: a guarded module reached through another is still itself."""
    parts = name.split(".")
    for start in range(len(parts)):
        suffix = ".".join(parts[start:])
        if suffix in GUARDED_NAMES or suffix in GUARDED_MODULES:
            return suffix
    return name


def _weakens(expr: ast.expr | None) -> bool:
    """True unless ``expr`` is absent or a literal filter whose action (before any ``:``) is ``error``."""
    if expr is None:
        return False
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return expr.value.split(":", 1)[0].strip() != KEPT_ACTION
    return True


def _call_suppresses(name: str, call: ast.Call) -> bool:
    if any(keyword.arg is None for keyword in call.keywords):  # **kwargs: the action cannot be read
        return True
    action = next((k.value for k in call.keywords if k.arg == "action"), None)
    if name == CATCH_WARNINGS:
        return _weakens(action)
    if name == PYTEST_FILTER_MARK:
        return any(_weakens(arg) for arg in call.args) or _weakens(action)
    first = call.args[0] if call.args else None
    return _weakens(action) or _weakens(first)


def _is_getattr(call: ast.Call) -> bool:
    return isinstance(call.func, ast.Name) and call.func.id == "getattr" and len(call.args) >= GETATTR_ARGS


def _getattr_marker(call: ast.Call, bound: dict[str, str]) -> str | None:
    """``getattr(<guarded module>, name)``: the marker when the name is guarded or not a literal."""
    if not _is_getattr(call):
        return None
    resolved = _resolve(call.args[0], bound)
    module = None if resolved is None else _canonical(resolved)
    if module is None or module not in GUARDED_MODULES:
        return None
    name = call.args[1]
    if isinstance(name, ast.Constant) and isinstance(name.value, str):
        return GUARDED_NAMES.get(f"{module}.{name.value}")
    return GUARDED_MODULES[module]


def _module_use_is_followed(node: ast.AST, parent: ast.AST | None) -> bool:
    """A guarded module the scan can follow: the base of an attribute access, or getattr's object."""
    if isinstance(parent, ast.Attribute):
        return parent.value is node
    return isinstance(parent, ast.Call) and _is_getattr(parent) and parent.args[0] is node


def python_findings(path: str, text: str) -> list[Finding]:
    """Weakened warning filters, skips and escaped guarded modules, judged on the syntax tree (module docstring)."""
    tree = ast.parse(text, filename=path)
    lines = text.splitlines()
    bound = _bindings(tree)
    called = {id(node.func): node for node in ast.walk(tree) if isinstance(node, ast.Call)}
    parents = {id(child): parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    findings: list[Finding] = []

    def found(node: ast.AST, marker: str) -> None:
        row = getattr(node, "lineno", 1)
        findings.append(Finding(path, row, marker, lines[row - 1].strip()))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and (marker := _getattr_marker(node, bound)) is not None:
            found(node, marker)
        if not isinstance(node, ast.Name | ast.Attribute):
            continue
        resolved = _resolve(node, bound)
        name = None if resolved is None else _canonical(resolved)
        if name in GUARDED_MODULES:
            if not _module_use_is_followed(node, parents.get(id(node))):
                found(node, GUARDED_MODULES[name])
            continue
        if name is None or name not in GUARDED_NAMES:
            continue
        call = called.get(id(node))
        if name in SKIP_NAMES or name == WARNINGS_FILTER_LIST or call is None or _call_suppresses(name, call):
            found(call or node, GUARDED_NAMES[name])
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
        if Path(path).suffix in PYTHON_SUFFIXES:
            try:
                findings += python_findings(path, text)
            except (SyntaxError, ValueError) as exc:  # fail closed; the line scan's findings still stand
                errors.append(f"{path}: not valid Python ({exc}); the suppression scan cannot read it")
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
