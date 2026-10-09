"""Role-boundary lint (S5 1.2 item 2): AST walk over every Python file under packages/, services/,
tools/, scripts/ that fails `make check` when:

  a. `arena_api` or `arena_tournament` imports `arena_subject`, `arena_referee` or
     `arena_core.agents.subject_prompts` / `referee_prompts` (modules that do not exist yet; named
     here so the rule is already in force the day they land).
  b. `arena_subject` imports `arena_referee`.
  c. any module other than `arena_core.providers.vertex` imports `google.genai`.
  d. any module imports `google.adk` (the typed agent port replaces ADK everywhere, direction DM-1).
  core. `arena_core` imports any role package (`arena_api`, `arena_subject`, `arena_referee`,
     `arena_tournament`). Every role imports arena_core, so a role import inside it would hand
     arena_api the subject's or the referee's code transitively and defeat rules a and b.
  dyn. product code (arena_core or a role) uses dynamic import machinery (`importlib` other than the
     `importlib.metadata` from-imports, `runpy`, `pkgutil`, `builtins`, `zipimport`, `__import__`,
     `__builtins__`). Every module product code loads is then a static import this lint can check; an
     alias or a keyword argument to `importlib.import_module` cannot route around rules a, b and core.
     Outside product code, aliased and keyword dynamic imports with a literal target still resolve.

The lint reads source, it is not a sandbox: attribute chains built at run time are out of its reach,
and the database grants and per-process credentials (S5 1.2 items 1 and 3) remain the data boundary.

A fifth rule in S5 1.2 item 2 ("any module other than `arena_core.events.projections` constructs an
event frame model") needs the wire frame types, which WP-02 generates (`contracts/`, C-17) and WP-13's
projection builds (S5 6.5 makes the rule part of that acceptance); it lands with those types, since
nothing can violate a rule about a type that does not exist yet.

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

ROLE_PACKAGES = frozenset({"arena_api", "arena_subject", "arena_referee", "arena_tournament"})
# Package -> modules it may never import (S5 1.2 item 2 rules a, b; the arena_core rule above).
FORBIDDEN_IMPORTS: dict[str, frozenset[str]] = {
    "arena_core": ROLE_PACKAGES,
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
# Modules that load other modules by name at run time (rule dyn). importlib.metadata reads distribution
# metadata without importing anything; its from-import forms are allowed (`import importlib.metadata` is not,
# because it binds `importlib` itself).
DYNAMIC_LOADER_MODULES = ("importlib", "runpy", "pkgutil", "builtins", "zipimport")
METADATA = "importlib.metadata"
DYNAMIC_NAMES = frozenset({"__import__", "__builtins__"})
LOADER_FUNCTIONS = frozenset({"import_module", "__import__"})
DYNAMIC_RULE = "dynamic import machinery {what} in product code (S5 1.2 item 2: imports must be static)"


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}"


def _module_of(path: str) -> str | None:
    """The package a scanned path belongs to (a role, or arena_core), or None (tools/scripts carry no role)."""
    parts = Path(path).parts
    if parts[:1] == ("services",) and parts[1:2] and parts[1] in SERVICE_PACKAGE:
        return SERVICE_PACKAGE[parts[1]]
    if parts[:2] == ("packages", "core"):
        return "arena_core"
    return None


def _loader_aliases(tree: ast.AST) -> frozenset[str]:
    """Local names bound to a loader function: ``from importlib import import_module as load`` binds ``load``."""
    names = set(LOADER_FUNCTIONS)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in {"importlib", "builtins"} and node.level == 0:
            names.update(a.asname or a.name for a in node.names if a.name in LOADER_FUNCTIONS)
    return frozenset(names)


def _argument(node: ast.Call, position: int, keyword: str) -> str | None:
    """A string-literal argument given by position or by keyword, else None."""
    value: ast.expr | None = node.args[position] if len(node.args) > position else None
    value = next((k.value for k in node.keywords if k.arg == keyword), value)
    return value.value if isinstance(value, ast.Constant) and isinstance(value.value, str) else None


def _resolve_relative(name: str, package: str | None) -> str:
    """``import_module(".genai", package="google")`` -> ``google.genai`` (importlib's own rule)."""
    level = len(name) - len(name.lstrip("."))
    if not level or package is None:
        return name
    base = package.rsplit(".", level - 1)[0] if level > 1 else package
    return f"{base}.{name[level:]}" if name[level:] else base


def _dynamic_import(node: ast.Call, loaders: frozenset[str]) -> str | None:
    """The literal module name a loader call imports (any alias; positional or keyword), else None."""
    func = node.func
    is_loader = (isinstance(func, ast.Name) and func.id in loaders) or (
        isinstance(func, ast.Attribute) and func.attr in LOADER_FUNCTIONS
    )
    if not is_loader:
        return None
    name = _argument(node, 0, "name")
    return None if name is None else _resolve_relative(name, _argument(node, 1, "package"))


def _imports(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, module) for every static or dynamic import in the tree.

    For ``from X import Y`` this yields both ``X`` (so a rule naming the package catches every name
    imported from it) and ``X.Y`` (so a rule naming one specific submodule, such as
    ``arena_core.agents.subject_prompts``, still catches ``from arena_core.agents import
    subject_prompts``, not only ``import arena_core.agents.subject_prompts``).
    """
    loaders = _loader_aliases(tree)
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, a.name) for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            found.append((node.lineno, node.module))
            found.extend((node.lineno, f"{node.module}.{a.name}") for a in node.names)
        elif isinstance(node, ast.Call):
            module = _dynamic_import(node, loaders)
            if module is not None:
                found.append((node.lineno, module))
    return found


def _is_loader_module(module: str) -> bool:
    return any(_is_or_starts_with(module, loader) for loader in DYNAMIC_LOADER_MODULES)


def _machinery(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, what) for every use of dynamic import machinery (rule dyn; product code only)."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, f"`import {a.name}`") for a in node.names if _is_loader_module(a.name))
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            metadata_only = node.module == "importlib" and all(a.name == "metadata" for a in node.names)
            if _is_loader_module(node.module) and not metadata_only and not _is_or_starts_with(node.module, METADATA):
                found.append((node.lineno, f"`from {node.module} import ...`"))
        elif isinstance(node, ast.Name) and node.id in DYNAMIC_NAMES:
            found.append((node.lineno, f"`{node.id}`"))
        elif isinstance(node, ast.Attribute) and node.attr == "__import__":
            found.append((node.lineno, "`.__import__`"))
    return found


def _is_or_starts_with(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(prefix + ".")


def check_source(path: str, source: str) -> list[Finding]:
    tree = ast.parse(source, filename=path)
    findings: list[Finding] = []
    own_package = _module_of(path)
    forbidden = FORBIDDEN_IMPORTS.get(own_package or "", frozenset())
    if own_package is not None:
        findings.extend(Finding(path, line, DYNAMIC_RULE.format(what=what)) for line, what in _machinery(tree))
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
