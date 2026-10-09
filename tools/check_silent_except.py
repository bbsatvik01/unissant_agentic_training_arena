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
from collections.abc import Callable
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


COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)


def _always_children(node: ast.AST) -> list[ast.AST]:
    """The children that always run when ``node`` runs (a conditional expression is handled by the caller)."""
    if isinstance(node, ast.Lambda | ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return []
    if isinstance(node, ast.BoolOp):
        return [node.values[0]]
    if isinstance(node, COMPREHENSIONS):
        return [node.generators[0].iter]
    if isinstance(node, ast.Assert):
        return [node.test]
    return list(ast.iter_child_nodes(node))


def _always(node: ast.AST, holds: Callable[[ast.AST], bool]) -> bool:
    """True when ``holds`` is true of a node that always runs when ``node`` runs: only the test of a
    conditional expression (or both of its branches), only the first operand of ``and``/``or``, only the
    first iterable of a comprehension, never a lambda or nested definition body, never an assert message."""
    if holds(node):
        return True
    if isinstance(node, ast.IfExp):
        return _always(node.test, holds) or (_always(node.body, holds) and _always(node.orelse, holds))
    return any(_always(child, holds) for child in _always_children(node))


def _escapes(node: ast.AST, tainted: set[str]) -> bool:
    """True when a value derived from the caught exception leaves the handler.

    Counted: returned, yielded or awaited; stored on an attribute or in a subscript (outlives the
    handler); passed to a call that is not a pure builtin (``errors.append(msg)``, ``Failure(exc)``).
    Not counted: bare mentions, local copies (``msg = str(exc)``) that go nowhere, ``_ = exc``, or only
    branching on it (``if msg: return 0``).
    """

    def refs(expr: object) -> bool:
        return isinstance(expr, ast.AST) and _always(expr, lambda n: isinstance(n, ast.Name) and n.id in tainted)

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
    """A simple statement that always raises, reports, or hands a value derived from the exception on (a
    report under a conditional expression, a short-circuit operand or a comprehension may never run)."""

    def handles(node: ast.AST) -> bool:
        if isinstance(node, ast.Raise) or (isinstance(node, ast.Call) and _is_reporting_call(node)):
            return True
        return _escapes(node, tainted)

    return _always(stmt, handles)


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
        elif isinstance(stmt, ast.Try | ast.TryStar):
            inner_try = _try_flow(stmt, tainted, in_loop=in_loop)
            exits, falls = exits or inner_try.exits_silently, inner_try.falls_through
        elif isinstance(stmt, ast.Match):
            cases = [_flow(case.body, tainted, in_loop=in_loop) for case in stmt.cases]
            exits = exits or any(f.exits_silently for f in cases)
            falls = not _exhaustive(stmt) or any(f.falls_through for f in cases)
        elif _handles(stmt, tainted):
            falls = False
        elif isinstance(stmt, EXITS):
            if not (in_loop and isinstance(stmt, ast.Continue | ast.Break)):
                exits = True
            falls = False
    return Flow(exits, falls)


def _try_flow(stmt: ast.Try | ast.TryStar, tainted: set[str], *, in_loop: bool) -> Flow:
    """A ``finally`` that handles every path covers the whole statement (a return in the body still runs
    it); otherwise the body (then ``else``) and each handler are paths of their own."""
    final = _flow(stmt.finalbody, tainted, in_loop=in_loop)
    if stmt.finalbody and not final.falls_through and not final.exits_silently:
        return Flow(exits_silently=False, falls_through=False)
    body = _flow(stmt.body, tainted, in_loop=in_loop)
    orelse = _flow(stmt.orelse, tainted, in_loop=in_loop)
    handlers = [_flow(handler.body, tainted, in_loop=in_loop) for handler in stmt.handlers]
    exits = body.exits_silently or orelse.exits_silently or any(h.exits_silently for h in handlers)
    falls = (body.falls_through and orelse.falls_through) or any(h.falls_through for h in handlers)
    return Flow(exits or final.exits_silently, falls)


def _exhaustive(stmt: ast.Match) -> bool:
    """The last case is an unguarded wildcard (``case _:``), so some case always runs."""
    last = stmt.cases[-1] if stmt.cases else None
    return (
        last is not None
        and last.guard is None
        and isinstance(last.pattern, ast.MatchAs)
        and last.pattern.pattern is None
    )


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
