"""Static half of "no skip, no todo" in the pgTAP suite (S4 sql/TESTS.md section 0; global never-rig rule).

pgTAP's skip and todo functions (skip, todo, todo_start, todo_end) may not appear in any test or harness file, not
even in a branch that does not run here. A call can be spelled many ways: bare or schema-qualified, quoted, in any
case, with whitespace or comments before its parenthesis, inside a dollar-quoted body or inside a string that is
executed later. So the names are reserved words of the suite: any identifier-delimited occurrence is a hit, in code,
strings and comments alike. The one exception is the exact string literal 'skip' (ops.admit_unit's decision value).
Two spellings that would hide a name from that rule are refused too: Unicode-escape identifiers and strings (U&"..."
and U&'...') and escape strings with octal, hex or Unicode escapes (E'\\x69'). The runtime half is
tools/pgtap_verdict.py, which fails any SKIP or TODO directive that a test actually emits, however it was built.

run_pgtap.sh runs this file as a script with an isolated interpreter (``python3 -I -B tools/pgtap_ban.py <file>...``),
so it uses the standard library only. Exit 0 clean, 1 on any hit, 2 when a file cannot be read.
"""

import re
import sys
from pathlib import Path

RESERVED = re.compile(r"(?<![A-Za-z0-9_$])(todo_start|todo_end|skip|todo)(?![A-Za-z0-9_$])", re.IGNORECASE)
UNICODE_ESCAPE = re.compile(r"(?<![A-Za-z0-9_$])u&[\"']", re.IGNORECASE)
ESCAPED_STRING = re.compile(r"(?<![A-Za-z0-9_$])e'(?:[^'\\]|\\.|'')*?\\[0-7xuU]", re.IGNORECASE | re.DOTALL)
ALLOWED_LITERAL = "skip"


def _line(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def scan(text: str) -> list[str]:
    """One ``line N: <what>`` entry per forbidden occurrence, in file order."""
    hits: list[tuple[int, str]] = []
    for match in RESERVED.finditer(text):
        start, end = match.span()
        quoted_literal = start > 0 and end < len(text) and text[start - 1] == "'" and text[end] == "'"
        if quoted_literal and match.group(1).lower() == ALLOWED_LITERAL:
            continue
        hits.append((start, match.group(1).lower()))
    hits.extend((m.start(), "unicode-escape identifier or string") for m in UNICODE_ESCAPE.finditer(text))
    hits.extend((m.start(), "escape string with an encoded character") for m in ESCAPED_STRING.finditer(text))
    return [f"line {_line(text, offset)}: {what}" for offset, what in sorted(hits)]


def main(argv: list[str]) -> int:
    if not argv:
        sys.stderr.write("run_pgtap: FAIL: could not scan the suite for skip/todo calls (no files)\n")
        return 2
    found: list[str] = []
    for path in argv:
        try:
            text = Path(path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            sys.stderr.write(f"run_pgtap: FAIL: could not scan {path} for skip/todo calls: {exc}\n")
            return 2
        found.extend(f"{path}: {hit}" for hit in scan(text))
    if found:
        sys.stderr.write("run_pgtap: FAIL: pgTAP skip/todo calls are forbidden in the suite:\n")
        sys.stderr.write("".join(f"{hit}\n" for hit in found))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
