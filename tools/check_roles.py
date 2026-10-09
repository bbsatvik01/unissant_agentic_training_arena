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
  dyn. product code (arena_core or a role) touches the import system: it imports `importlib` (any part,
     entry points included), `runpy`, `pkgutil`, `pydoc`, `site`, `builtins` or `zipimport`; names
     `__import__` or `__builtins__` (as a name, an attribute or a string); or reaches `sys.path`,
     `sys.meta_path`, `sys.path_hooks`, `sys.path_importer_cache` or `sys.modules`. Every module product
     code loads is then a static import this lint checks.
  str. product code names a module it may not import as a dotted or colon reference in a string
     (`pkg.mod`, `pkg.mod:attr`, `ext://pkg.mod.Attr`). Every load-by-name API (uvicorn app strings,
     logging.config, mock.patch, pydantic ImportString, entry points) takes the module name as data, so
     this one rule covers them all. A bare name is not a reference (`arena_referee` is also the database
     role), and docstrings are prose.
  Outside product code, aliased and keyword dynamic imports with a literal target still resolve.

The lint reads source; it is not a sandbox. A module name assembled at run time is out of its reach;
the per-process credentials and the database grants (S5 1.2 items 1 and 3, S5 10.2 item 7) remain the
data boundary, as S5's threat model states.

  frame. product code other than `arena_core.events.projections` names an event frame model outside a
     type annotation: a call, `X.model_validate(...)`, `TypeAdapter(X)`, any other value use, or the model's
     name as a string (S5 1.2 item 2: "any module other than `arena_core.events.projections` constructs an
     event frame model"; S5 6.5). The frame models are read from `arena_core/contracts/events.py` (WP-02):
     every class or alias there whose name ends in `Frame`, and every container that carries one
     (`ReplayPage`, the tournament poll), since validating a container builds its frames. Two files are exempt,
     each for a reason the rule cannot be broken by: that module itself (it declares them) and
     `arena_core/contracts/export.py` (it reads their JSON Schema to write `contracts/`, and builds no frame);
     product code may not import that export module, which hands out every wire type. Absolute and relative
     imports both resolve. A function's annotations stay free, so a function may accept or return a frame it
     never builds; a class-body annotation is a field (validating the class builds it) and a call inside any
     annotation runs, so both are value uses.

Adapted from TechnoMile `tools/check_adk_scope.py` (same AST-walker shape: import detector, dynamic
`importlib.import_module` / `__import__` detector, per-file findings); the rule set itself is new
(S5 1.2 item 2 is unrelated to ADK orchestration scope).
"""

import argparse
import ast
import re
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
# Rule frame: where the frame models are defined, and the one module that may build them.
FRAME_SOURCE = "packages/core/src/arena_core/contracts/events.py"
FRAME_MODULE = "arena_core.contracts.events"
FRAME_BUILDER = "packages/core/src/arena_core/events/projections.py"
FRAME_EXEMPT = frozenset({FRAME_BUILDER, FRAME_SOURCE, "packages/core/src/arena_core/contracts/export.py"})
FRAME_RULE = "{name} is an event frame model; only arena_core.events.projections builds frames (S5 1.2 item 2)"
# The schema export maps file stems to every wire type, frames included; product code never needs it.
EXPORT_MODULE = "arena_core.contracts.export"
EXPORT_RULE = "arena_core.contracts.export hands out the frame types; only tools import it (S5 1.2 item 2)"
GENAI = "google.genai"
ADK = "google.adk"
# Modules that load or locate other modules by name at run time (rule dyn), whole: importlib.metadata loads
# modules too (EntryPoint.load, entry_points()).
DYNAMIC_LOADER_MODULES = ("importlib", "runpy", "pkgutil", "pydoc", "site", "builtins", "zipimport")
DYNAMIC_NAMES = frozenset({"__import__", "__builtins__"})
# The import system's mutable state on `sys` (rule dyn): a path entry or a module injected there loads code
# under a name no import statement shows.
IMPORT_STATE = frozenset({"path", "meta_path", "path_hooks", "path_importer_cache", "modules"})
LOADER_FUNCTIONS = frozenset({"import_module", "__import__"})
DYNAMIC_RULE = "dynamic import machinery {what} in product code (S5 1.2 item 2: imports must be static)"
STRING_RULE = "{package} names {module} in a string; a load-by-name API would import it (S5 1.2 item 2)"
# A dotted (`a.b`) or colon (`a:attr`) module reference, optionally `ext://`-prefixed (logging.config).
MODULE_REFERENCE = re.compile(r"(?:ext://)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|[A-Za-z_]\w*(?=:))(?::[\w.]+)?")


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


def _sys_names(tree: ast.AST) -> frozenset[str]:
    """Local names bound to the sys module (`import sys`, `import sys as s`)."""
    return frozenset(
        a.asname or a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names if a.name == "sys"
    )


def _statement_machinery(node: ast.AST) -> str | None:
    """An import statement that brings in a loader module or the import state on sys, or None."""
    if isinstance(node, ast.Import):
        loaders = [a.name for a in node.names if _is_loader_module(a.name)]
        return f"`import {loaders[0]}`" if loaders else None
    if not isinstance(node, ast.ImportFrom) or node.module is None or node.level != 0:
        return None
    if _is_loader_module(node.module):
        return f"`from {node.module} import ...`"
    state = [a.name for a in node.names if node.module == "sys" and a.name in IMPORT_STATE]
    return f"`from sys import {state[0]}`" if state else None


def _reference_machinery(node: ast.AST, sys_names: frozenset[str]) -> str | None:
    """A reference to `__import__`, `__builtins__` or the import state on sys, or None."""
    name = None
    if isinstance(node, ast.Name) and node.id in DYNAMIC_NAMES:
        name = f"`{node.id}`"
    elif isinstance(node, ast.Attribute) and node.attr in DYNAMIC_NAMES:
        name = f"`.{node.attr}`"
    elif isinstance(node, ast.Attribute) and node.attr in IMPORT_STATE and isinstance(node.value, ast.Name):
        name = f"`sys.{node.attr}`" if node.value.id in sys_names else None
    elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in DYNAMIC_NAMES:
        name = f"the string {node.value!r}"
    return name


def _machinery(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, what) for every touch of the import system (rule dyn; product code only)."""
    sys_names = _sys_names(tree)
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        what = _statement_machinery(node) or _reference_machinery(node, sys_names)
        if what is not None:
            found.append((getattr(node, "lineno", 0), what))
    return found


def _docstrings(tree: ast.AST) -> set[int]:
    """ids of the docstring constants (prose, not data)."""
    found: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                found.add(id(first.value))
    return found


def _module_references(tree: ast.AST) -> list[tuple[int, str]]:
    """(line, module) for every string constant that is a whole module reference (rule str)."""
    docstrings = _docstrings(tree)
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            match = MODULE_REFERENCE.fullmatch(node.value.strip())
            if match is not None:
                found.append((node.lineno, match.group(1)))
    return found


def _is_or_starts_with(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(prefix + ".")


def frame_models(root: Path) -> frozenset[str]:
    """The frame models of FRAME_SOURCE: every module-level class or alias whose name ends in `Frame`, plus every
    class or alias that carries one (a field, a base or a union member naming it, transitively), because
    validating such a container builds the frames inside it (`ReplayPage.model_validate(raw)`)."""
    tree = ast.parse((root / FRAME_SOURCE).read_text(encoding="utf-8"), filename=FRAME_SOURCE)
    uses: dict[str, set[str]] = {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            parts: list[ast.AST] = [*node.bases]
            parts += [s.annotation for s in node.body if isinstance(s, ast.AnnAssign)]
            uses[node.name] = {n.id for part in parts for n in ast.walk(part) if isinstance(n, ast.Name)}
        elif isinstance(node, ast.Assign):
            named = {n.id for n in ast.walk(node.value) if isinstance(n, ast.Name)}
            uses.update({t.id: named for t in node.targets if isinstance(t, ast.Name)})
    frames = {name for name in uses if name.endswith("Frame")}
    while carriers := {name for name, named in uses.items() if name not in frames and named & frames}:
        frames |= carriers
    return frozenset(frames)


def _annotation_nodes(tree: ast.AST) -> set[int]:
    """ids of the nodes of every type annotation (arguments, returns, annotated assignments), except the nodes
    of a call inside one: `def f(x: NoticeFrame(v=1))` runs that call when the function is defined."""
    # A class-body annotation is a field (Pydantic, dataclasses): validating the class builds its value.
    fields = {
        id(s) for c in ast.walk(tree) if isinstance(c, ast.ClassDef) for s in c.body if isinstance(s, ast.AnnAssign)
    }
    roots: list[ast.AST] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and node.annotation is not None:
            roots.append(node.annotation)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.returns is not None:
            roots.append(node.returns)
        elif isinstance(node, ast.AnnAssign) and id(node) not in fields:
            roots.append(node.annotation)
    inside = {id(n) for root in roots for n in ast.walk(root)}
    calls = {id(n) for root in roots for c in ast.walk(root) if isinstance(c, ast.Call) for n in ast.walk(c)}
    return inside - calls


def _dotted_module(path: str) -> list[str]:
    """`packages/core/src/arena_core/x/y.py` -> ['arena_core', 'x', 'y'] (a package's `__init__` -> the package)."""
    parts = Path(path).with_suffix("").parts
    tail = list(parts[parts.index("src") + 1 :]) if "src" in parts else []
    return tail[:-1] if tail[-1:] == ["__init__"] else tail


def _resolve_from(path: str, node: ast.ImportFrom) -> str | None:
    """The absolute module a `from ... import` names, resolving relative imports against the file's package."""
    if node.level == 0:
        return node.module
    own = _dotted_module(path)
    package = own if Path(path).name == "__init__.py" else own[:-1]
    if node.level - 1 > len(package):
        return None
    base = package[: len(package) - (node.level - 1)]
    return ".".join([*base, *([node.module] if node.module else [])])


def _frame_uses(path: str, tree: ast.AST, frames: frozenset[str]) -> list[tuple[int, str]]:
    """(line, name) for every value use of a frame model (rule frame)."""
    local: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and _resolve_from(path, node) == FRAME_MODULE:
            local.update(a.asname or a.name for a in node.names if a.name in frames)
    exempt = _annotation_nodes(tree) | _docstrings(tree)
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if id(node) in exempt:
            continue
        if _imports_export(path, node):
            found.append((getattr(node, "lineno", 0), ""))
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in local:
            found.append((node.lineno, node.id))
        elif isinstance(node, ast.Attribute) and node.attr in frames:
            found.append((node.lineno, node.attr))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            found.extend((node.lineno, name) for name in _named_in_string(node.value, frames | local))
    return found


def _named_in_string(text: str, names: frozenset[str] | set[str]) -> list[str]:
    """Frame names a string carries: the whole string (`getattr(events, "NoticeFrame")`) or any name in it read
    as an expression (a string annotation such as `"NoticeFrame | None"`, which Pydantic resolves)."""
    if text.strip() in names:
        return [text.strip()]
    try:
        expression = ast.parse(text.strip(), mode="eval")
    except SyntaxError:
        return []
    named = {n.id for n in ast.walk(expression) if isinstance(n, ast.Name)}
    named |= {n.attr for n in ast.walk(expression) if isinstance(n, ast.Attribute)}
    return sorted(named & set(names))


def _imports_export(path: str, node: ast.AST) -> bool:
    if isinstance(node, ast.Import):
        return any(_is_or_starts_with(a.name, EXPORT_MODULE) for a in node.names)
    if isinstance(node, ast.ImportFrom):
        module = _resolve_from(path, node) or ""
        return _is_or_starts_with(module, EXPORT_MODULE) or any(
            f"{module}.{a.name}" == EXPORT_MODULE for a in node.names
        )
    return False


def _builds_frames(path: str, own_package: str | None) -> bool:
    """Product code (a package's src tree), except the projection and the two exempt contracts files."""
    return own_package is not None and "/src/" in path and path not in FRAME_EXEMPT


def check_source(path: str, source: str, frames: frozenset[str] = frozenset()) -> list[Finding]:
    tree = ast.parse(source, filename=path)
    findings: list[Finding] = []
    own_package = _module_of(path)
    if frames and _builds_frames(path, own_package):
        findings.extend(
            Finding(path, line, FRAME_RULE.format(name=name) if name else EXPORT_RULE)
            for line, name in _frame_uses(path, tree, frames)
        )
    forbidden = FORBIDDEN_IMPORTS.get(own_package or "", frozenset())
    if own_package is not None:
        findings.extend(Finding(path, line, DYNAMIC_RULE.format(what=what)) for line, what in _machinery(tree))
        unnameable = {*forbidden, ADK} | ({GENAI} if path != VERTEX_ADAPTER else set())
        findings.extend(
            Finding(path, line, STRING_RULE.format(package=own_package, module=module))
            for line, module in _module_references(tree)
            if any(_is_or_starts_with(module, name) for name in unnameable)
        )
    for line, module in _imports(tree):
        if any(_is_or_starts_with(module, name) for name in forbidden):
            findings.append(Finding(path, line, f"{own_package} may never import {module} (S5 1.2 item 2)"))
        if _is_or_starts_with(module, GENAI) and path != VERTEX_ADAPTER:
            findings.append(Finding(path, line, f"google.genai imported outside {VERTEX_ADAPTER} (S5 1.2 item 2)"))
        if _is_or_starts_with(module, ADK):
            findings.append(Finding(path, line, "google.adk imported (the typed agent port replaces ADK, DM-1)"))
    return sorted(set(findings), key=lambda f: (f.path, f.line, f.rule))


def scan(root: Path, paths: Iterable[str]) -> list[Finding]:
    frames = frame_models(root)
    findings: list[Finding] = []
    for rel in paths:
        if rel.endswith(".py") and rel.startswith(SCANNED_ROOTS):
            findings.extend(check_source(rel, (root / rel).read_text(encoding="utf-8"), frames))
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
    sys.stdout.write("roles: OK (no cross-role import, no stray google.genai or google.adk, no stray frame)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
