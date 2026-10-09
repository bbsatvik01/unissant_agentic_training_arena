"""Silent-except gate (S5 11.1 py-check): no silent ``except``.

An exception handler is silent when some path through it neither re-raises, nor logs/warns/reports, nor
uses the caught exception object (judged per path: a raise or a log under one branch covers only that
branch). Such a handler discards the failure: the caller cannot tell "gone" from "could not
look". Deliberate cases carry ``# silent-ok: <reason>`` on the ``except`` line or the line above it.
"""

import argparse
import ast
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from tools import proc

PURE_BUILTINS = {"str", "repr", "len", "format", "type", "id", "bool", "int", "float", "hash", "isinstance", "print"}
REPORTING_CALLS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log", "fatal"}
LABEL = re.compile(r"#\s*silent-ok:\s*\S.{7,}")  # a real reason, not a bare label
SCANNED_ROOTS = ("packages/", "services/", "tools/", "scripts/")


@dataclass(frozen=True)
class Silent:
    path: str
    line: int


def _is_reporting_call(node: ast.Call) -> bool:
    func = node.func
    if isinstance(func, ast.Attribute):
        if func.attr in REPORTING_CALLS:
            return True
        target = func.value
        return (
            func.attr == "write"
            and isinstance(target, ast.Attribute)
            and target.attr == "stderr"
            and isinstance(target.value, ast.Name)
            and target.value.id == "sys"
        )
    return isinstance(func, ast.Name) and func.id in REPORTING_CALLS


def _references(node: ast.AST, name: str) -> bool:
    return any(isinstance(n, ast.Name) and n.id == name for n in ast.walk(node))


def _assign_targets(node: ast.AST) -> list[ast.expr]:
    if isinstance(node, ast.Assign):
        return list(node.targets)
    if isinstance(node, ast.AnnAssign | ast.AugAssign | ast.NamedExpr):
        return [node.target]
    return []


def _tainted_names(nodes: list[ast.AST], name: str) -> set[str]:
    """The exception name plus every local name assigned from it (``msg = str(exc)``), to a fixpoint."""
    tainted = {name}
    changed = True
    while changed:
        changed = False
        for node in nodes:
            value = getattr(node, "value", None)
            if not isinstance(value, ast.AST) or not any(_references(value, t) for t in tainted):
                continue
            for target in _assign_targets(node):
                if isinstance(target, ast.Name) and target.id != "_" and target.id not in tainted:
                    tainted.add(target.id)
                    changed = True
    return tainted


def _escapes(node: ast.AST, tainted: set[str]) -> bool:
    """True when a value derived from the caught exception leaves the handler.

    Counted: returned, yielded or awaited; stored on an attribute or in a subscript (outlives the
    handler); passed to a call that is not a pure builtin (``errors.append(msg)``, ``Failure(exc)``).
    Not counted: bare mentions, local copies (``msg = str(exc)``) that go nowhere, ``_ = exc``, or only
    branching on it (``if msg: return 0``).
    """

    def refs(expr: object) -> bool:
        return isinstance(expr, ast.AST) and any(_references(expr, t) for t in tainted)

    if isinstance(node, ast.Return | ast.Yield | ast.YieldFrom | ast.Await):
        return refs(node.value)
    targets = _assign_targets(node)
    if targets:
        stored = [t for t in targets if isinstance(t, ast.Attribute | ast.Subscript)]
        return bool(stored) and refs(getattr(node, "value", None))
    if isinstance(node, ast.Call):
        pure = isinstance(node.func, ast.Name) and node.func.id in PURE_BUILTINS
        return not pure and any(refs(arg) for arg in [*node.args, *(k.value for k in node.keywords)])
    return False


@dataclass(frozen=True)
class Flow:
    """Paths through a statement list: one leaves the handler silently, one falls off its end unhandled."""

    exits_silently: bool
    falls_through: bool


NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
LOOPS = (ast.For, ast.AsyncFor, ast.While)
EXITS = (ast.Return, ast.Continue, ast.Break)


def _handles(stmt: ast.stmt, tainted: set[str]) -> bool:
    """A simple statement that raises, reports, or hands a value derived from the exception on."""
    for node in ast.walk(stmt):
        if isinstance(node, ast.Raise) or (isinstance(node, ast.Call) and _is_reporting_call(node)):
            return True
        if _escapes(node, tainted):
            return True
    return False


def _flow(stmts: list[ast.stmt], tainted: set[str], *, in_loop: bool) -> Flow:
    """Per-path analysis: a path is handled once a statement on it raises, reports or lets the exception
    escape; a path that returns, continues or breaks out of the handler before that is silent, and so is one
    that reaches the end of the handler. A loop body may run zero times; break and continue inside a loop
    within the handler stay in the handler."""
    exits, falls = False, True
    for stmt in stmts:
        if not falls:
            break
        if isinstance(stmt, NESTED_SCOPES):
            continue
        if isinstance(stmt, ast.If):
            body, orelse = _flow(stmt.body, tainted, in_loop=in_loop), _flow(stmt.orelse, tainted, in_loop=in_loop)
            exits = exits or body.exits_silently or orelse.exits_silently
            falls = body.falls_through or orelse.falls_through
        elif isinstance(stmt, LOOPS):
            inner = [_flow(stmt.body, tainted, in_loop=True), _flow(stmt.orelse, tainted, in_loop=in_loop)]
            exits = exits or any(f.exits_silently for f in inner)
        elif isinstance(stmt, ast.With | ast.AsyncWith):
            inner_with = _flow(stmt.body, tainted, in_loop=in_loop)
            exits, falls = exits or inner_with.exits_silently, inner_with.falls_through
        elif isinstance(stmt, ast.Try | ast.TryStar | ast.Match):
            blocks = [*_child_blocks(stmt)]
            flows = [_flow(block, tainted, in_loop=in_loop) for block in blocks]
            exits = exits or any(f.exits_silently for f in flows)
        elif _handles(stmt, tainted):
            falls = False
        elif isinstance(stmt, EXITS):
            if not (in_loop and isinstance(stmt, ast.Continue | ast.Break)):
                exits = True
            falls = False
    return Flow(exits, falls)


def _child_blocks(stmt: ast.Try | ast.TryStar | ast.Match) -> list[list[ast.stmt]]:
    if isinstance(stmt, ast.Match):
        return [case.body for case in stmt.cases]
    return [stmt.body, *(h.body for h in stmt.handlers), stmt.orelse, stmt.finalbody]


def handler_is_silent(handler: ast.ExceptHandler) -> bool:
    """Silent = some path through the handler leaves it, or reaches its end, without re-raising, reporting
    or letting something derived from the exception leave the handler (a conditional raise or a debug-only
    log covers only its own branch)."""
    nodes = [n for stmt in handler.body for n in ast.walk(stmt)]
    tainted = set() if handler.name is None else _tainted_names(nodes, handler.name)
    flow = _flow(handler.body, tainted, in_loop=False)
    return flow.exits_silently or flow.falls_through


def scan_source(path: str, source: str) -> list[Silent]:
    lines = source.splitlines()
    found: list[Silent] = []
    for node in ast.walk(ast.parse(source, filename=path)):
        if isinstance(node, ast.ExceptHandler) and handler_is_silent(node):
            nearby = lines[max(node.lineno - 2, 0) : node.lineno]
            if not any(LABEL.search(line) for line in nearby):
                found.append(Silent(path, node.lineno))
    return found


def scanned_python_files(root: Path) -> list[str]:
    return [p for p in proc.repo_files(root, "*.py") if p.startswith(SCANNED_ROOTS)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        found = [s for path in scanned_python_files(root) for s in scan_source(path, (root / path).read_text())]
    except (OSError, LookupError, SyntaxError, subprocess.CalledProcessError) as exc:
        sys.stderr.write(f"silent-except: FAIL: {exc}\n")
        return 1
    for item in found:
        sys.stderr.write(
            f"silent-except: FAIL: {item.path}:{item.line}: handler swallows the exception "
            "(re-raise, log it, use it, or label '# silent-ok: <reason>')\n"
        )
    if found:
        return 1
    sys.stdout.write("silent-except: OK\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
