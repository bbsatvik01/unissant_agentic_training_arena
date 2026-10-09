"""Role-boundary lint (S5 1.2 item 2): AST walk over every Python file under packages/, services/,
tools/, scripts/ that fails `make check` when:

  a. `arena_api` or `arena_tournament` imports `arena_subject`, `arena_referee` or
     `arena_core.agents.subject_prompts` / `referee_prompts` (modules that do not exist yet; named
     here so the rule is already in force the day they land).
  b. `arena_subject` imports `arena_referee`.
  c. any module other than `arena_core.providers.vertex` imports `google.genai`.
  d. any module imports `google.adk` (the typed agent port replaces ADK everywhere, direction DM-1).

A fifth rule in S5 1.2 item 2 ("any module other than `arena_core.events.projections` constructs an
event frame model") needs the event envelope types that `arena_core.events.envelope` defines in
WP-13; it is not checked here yet (nothing can violate a rule about a type that does not exist), and
is deferred to the WP that adds those types.

Adapted from TechnoMile `tools/check_adk_scope.py` (same AST-walker shape: import detector, dynamic
`importlib.import_module` / `__import__` detector, per-file findings); the rule set itself is new
(S5 1.2 item 2 is unrelated to ADK orchestration scope).
"""

import argparse
import ast
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from tools import proc

SCANNED_ROOTS = ("packages/", "services/", "tools/", "scripts/")

# Role package -> modules it may never import (S5 1.2 item 2 rules a, b).
FORBIDDEN_IMPORTS: dict[str, frozenset[str]] = {
    "arena_api": frozenset(
        {"arena_subject", "arena_referee", "arena_core.agents.subject_prompts", "arena_core.agents.referee_prompts"}
    ),
    "arena_tournament": frozenset(
        {"arena_subject", "arena_referee", "arena_core.agents.subject_prompts", "arena_core.agents.referee_prompts"}
    ),
    "arena_subject": frozenset({"arena_referee"}),
}
# Package a path under services/<role>/ belongs to, keyed by its directory name under services/.
SERVICE_PACKAGE = {
    "api": "arena_api",
    "subject": "arena_subject",
    "referee": "arena_referee",
    "tournament": "arena_tournament",
}
# The one file google.genai may be imported from (S5 1.2 item 2 rule c: "arena_core.providers.vertex").
# A file path, not a dotted module name: `check_source` compares it against the `path` argument, which
# `scan()` always passes as a repo-relative file path (matching TechnoMile check_adk_scope.py's ADAPTER).
VERTEX_ADAPTER = "packages/core/src/arena_core/providers/vertex.py"
GENAI = "google.genai"
ADK = "google.adk"


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}"


def _module_of(path: str) -> str | None:
    """The role package a scanned path belongs to, or None (tools/scripts carry no role)."""
    parts = Path(path).parts
    if parts[:1] == ("services",) and parts[1:2] and parts[1] in SERVICE_PACKAGE:
        return SERVICE_PACKAGE[parts[1]]
    return None


def _dynamic_import(node: ast.Call) -> str | None:
    """The literal module name of ``importlib.import_module("...")`` or ``__import__("...")``."""
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
    if name not in {"import_module", "__import__"} or not node.args:
        return None
    first = node.args[0]
    return first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None


def _imports(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, module) for every static or dynamic import in the tree.

    For ``from X import Y`` this yields both ``X`` (so a rule naming the package catches every name
    imported from it) and ``X.Y`` (so a rule naming one specific submodule, such as
    ``arena_core.agents.subject_prompts``, still catches ``from arena_core.agents import
    subject_prompts``, not only ``import arena_core.agents.subject_prompts``).
    """
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, a.name) for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            found.append((node.lineno, node.module))
            found.extend((node.lineno, f"{node.module}.{a.name}") for a in node.names)
        elif isinstance(node, ast.Call):
            module = _dynamic_import(node)
            if module is not None:
                found.append((node.lineno, module))
    return found


def _is_or_starts_with(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(prefix + ".")


def check_source(path: str, source: str) -> list[Finding]:
    tree = ast.parse(source, filename=path)
    findings: list[Finding] = []
    own_package = _module_of(path)
    forbidden = FORBIDDEN_IMPORTS.get(own_package or "", frozenset())
    for line, module in _imports(tree):
        if any(_is_or_starts_with(module, name) for name in forbidden):
            findings.append(Finding(path, line, f"{own_package} may never import {module} (S5 1.2 item 2)"))
        if _is_or_starts_with(module, GENAI) and path != VERTEX_ADAPTER:
            findings.append(Finding(path, line, f"google.genai imported outside {VERTEX_ADAPTER} (S5 1.2 item 2)"))
        if _is_or_starts_with(module, ADK):
            findings.append(Finding(path, line, "google.adk imported (the typed agent port replaces ADK, DM-1)"))
    return sorted(set(findings), key=lambda f: (f.path, f.line, f.rule))


def scan(root: Path, paths: Iterable[str]) -> list[Finding]:
    findings: list[Finding] = []
    for rel in paths:
        if rel.endswith(".py") and rel.startswith(SCANNED_ROOTS):
            findings.extend(check_source(rel, (root / rel).read_text(encoding="utf-8")))
    return findings


def tracked_python(root: Path) -> list[str]:
    return proc.repo_files(root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    findings = scan(args.root, tracked_python(args.root))
    for finding in findings:
        sys.stderr.write(f"{finding}\n")
    if findings:
        sys.stderr.write(f"roles: {len(findings)} violation(s) of S5 1.2 item 2\n")
        return 1
    sys.stdout.write("roles: OK (no cross-role import, no stray google.genai or google.adk)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
