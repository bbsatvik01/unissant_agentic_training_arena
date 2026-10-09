"""Silent-except gate (S5 11.1 py-check): no silent ``except``.

An exception handler is silent when it neither re-raises, nor logs/warns/reports, nor uses the caught
exception object. Such a handler discards the failure: the caller cannot tell "gone" from "could not
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


def handler_is_silent(handler: ast.ExceptHandler) -> bool:
    """Silent = no re-raise, no reporting call, and nothing derived from the exception leaves the handler."""
    nodes = [n for stmt in handler.body for n in ast.walk(stmt)]
    if any(isinstance(n, ast.Raise) for n in nodes):
        return False
    if any(isinstance(n, ast.Call) and _is_reporting_call(n) for n in nodes):
        return False
    if handler.name is None:
        return True
    tainted = _tainted_names(nodes, handler.name)
    return not any(_escapes(n, tainted) for n in nodes)


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
