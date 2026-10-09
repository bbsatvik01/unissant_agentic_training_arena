"""Ratchet (global hard gate: never rig, soften or bypass CI/tests): gate thresholds only ever get stricter.

Two checks, both fail closed:
1. Drift: every threshold's live value (pyproject, Makefile, vitest config, tsconfig, ...) equals the
   value recorded in tools/gates/ratchet.toml; a regex source must match exactly once, so a second
   assignment cannot quietly override the ratcheted one.
2. Monotonicity versus the ratchet file at the base ref (default ``main``): a minimum never falls, a
   maximum never rises, a frozen value never changes, and no entry is removed, re-pointed or has its
   direction changed. A ratchet file absent at the base ref is a first introduction; an unresolvable
   base ref is an error.
"""

import argparse
import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from tools import proc

RATCHET_PATH = "tools/gates/ratchet.toml"
Direction = Literal["min", "max", "frozen"]
Value = int | float | bool | str
_DIRECTIONS: tuple[Direction, ...] = ("min", "max", "frozen")
_SOURCE_KEYS = ("toml_key", "json_key", "regex")


class RatchetError(ValueError):
    """The ratchet file is malformed."""


@dataclass(frozen=True)
class Threshold:
    id: str
    value: Value
    direction: Direction
    origin: str
    source: dict[str, str]


def _is_numeric(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def same(left: object, right: object) -> bool:
    """Equality that also distinguishes bool/int/float (True != 1, 90 != 90.0)."""
    return type(left) is type(right) and left == right


def _parse_entry(raw: dict[str, object]) -> Threshold:
    ident = raw.get("id")
    if not isinstance(ident, str) or not ident:
        msg = "every threshold needs a non-empty string id"
        raise RatchetError(msg)
    direction = raw.get("direction")
    if direction not in _DIRECTIONS:
        msg = f"{ident}: direction must be one of {_DIRECTIONS}, got {direction!r}"
        raise RatchetError(msg)
    value = raw.get("value")
    if not isinstance(value, int | float | bool | str):
        msg = f"{ident}: value must be a number, bool or string"
        raise RatchetError(msg)
    if direction != "frozen" and not _is_numeric(value):
        msg = f"{ident}: a {direction} threshold needs a numeric value"
        raise RatchetError(msg)
    origin = raw.get("origin")
    if not isinstance(origin, str) or not origin:
        msg = f"{ident}: origin (where the value comes from) is required"
        raise RatchetError(msg)
    source = raw.get("source")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("file"), str)
        or sum(key in source for key in _SOURCE_KEYS) != 1
    ):
        msg = f"{ident}: source needs file plus exactly one of toml_key, json_key, regex"
        raise RatchetError(msg)
    if "regex" in source:
        try:
            compiled = re.compile(str(source["regex"]))
        except re.error as exc:
            msg = f"{ident}: invalid regex {source['regex']!r}: {exc}"
            raise RatchetError(msg) from exc
        if compiled.groups != 1:
            msg = f"{ident}: regex must have exactly one capture group"
            raise RatchetError(msg)
    return Threshold(ident, value, direction, origin, {str(k): str(v) for k, v in source.items()})


def parse(text: str) -> list[Threshold]:
    """Parse and validate a ratchet file."""
    entries = [_parse_entry(raw) for raw in tomllib.loads(text).get("threshold", [])]
    seen: set[str] = set()
    for entry in entries:
        if entry.id in seen:
            msg = f"duplicate threshold id {entry.id}"
            raise RatchetError(msg)
        seen.add(entry.id)
    return entries


def _dig(data: object, dotted: str) -> object:
    for part in dotted.split("."):
        if isinstance(data, list) and part.isdigit() and int(part) < len(data):
            data = data[int(part)]
        elif isinstance(data, dict) and part in data:
            data = data[part]
        else:
            raise KeyError(dotted)
    return data


def _coerce(text: str) -> Value:
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    return text


def read_live_value(entry: Threshold, root: Path) -> Value:
    """Read the value a gate actually uses from its source file."""
    path = root / entry.source["file"]
    if not path.is_file():
        msg = f"source file {entry.source['file']} is missing"
        raise LookupError(msg)
    text = path.read_text()
    if "regex" in entry.source:
        matches = list(re.finditer(entry.source["regex"], text, flags=re.MULTILINE))
        if not matches:
            msg = f"regex {entry.source['regex']!r} found no match in {entry.source['file']}"
            raise LookupError(msg)
        if len(matches) > 1:
            lines = [text.count("\n", 0, m.start()) + 1 for m in matches]
            msg = f"{entry.source['file']} sets this threshold {len(matches)} times (lines {lines}); set it once"
            raise LookupError(msg)
        return _coerce(matches[0].group(1))
    key = entry.source.get("toml_key") or entry.source["json_key"]
    data = tomllib.loads(text) if "toml_key" in entry.source else json.loads(text)
    try:
        found = _dig(data, key)
    except KeyError:
        msg = f"key {key} is missing from {entry.source['file']}"
        raise LookupError(msg) from None
    if not isinstance(found, int | float | bool | str):
        msg = f"key {key} in {entry.source['file']} is not a scalar"
        raise TypeError(msg)
    return found


def compare(old: Threshold, new: Threshold) -> str | None:
    """Why ``new`` loosens ``old``, or None when it is equal or stricter."""
    if new.source != old.source:
        return f"{old.id}: source changed {old.source} -> {new.source} (entries may not be re-pointed)"
    if new.direction != old.direction:
        return f"{old.id}: direction changed from {old.direction} to {new.direction}"
    if old.direction == "frozen":
        return None if same(new.value, old.value) else f"{old.id}: frozen value changed {old.value!r} -> {new.value!r}"
    return _compare_numbers(old, new)


def _compare_numbers(old: Threshold, new: Threshold) -> str | None:
    old_num, new_num = old.value, new.value
    if isinstance(old_num, bool | str) or isinstance(new_num, bool | str):
        return f"{old.id}: a {old.direction} threshold must stay numeric"
    if old.direction == "min" and new_num < old_num:
        return f"{old.id}: minimum loosened {old.value} -> {new.value}"
    if old.direction == "max" and new_num > old_num:
        return f"{old.id}: maximum loosened {old.value} -> {new.value}"
    return None


def check(current: list[Threshold], base: list[Threshold] | None, root: Path) -> list[str]:
    """Return every ratchet violation (empty list = pass)."""
    errors: list[str] = []
    for entry in current:
        try:
            live = read_live_value(entry, root)
        except (LookupError, TypeError) as exc:
            errors.append(f"{entry.id}: {exc}")
            continue
        if not same(live, entry.value):
            where = entry.source["file"]
            errors.append(f"{entry.id}: config drift, {where} has {live!r}, ratchet says {entry.value!r}")
    if base is not None:
        by_id = {entry.id: entry for entry in current}
        for old in base:
            new = by_id.get(old.id)
            if new is None:
                errors.append(f"{old.id}: removed from the ratchet (entries may never be deleted)")
                continue
            problem = compare(old, new)
            if problem:
                errors.append(problem)
    return errors


def load_base(root: Path, ref: str) -> list[Threshold] | None:
    """Ratchet entries at ``ref``; None when the file did not exist there yet."""
    if proc.run("git", ["-C", str(root), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]).returncode != 0:
        msg = f"base ref {ref!r} does not resolve to a commit"
        raise LookupError(msg)
    shown = proc.run("git", ["-C", str(root), "show", f"{ref}:{RATCHET_PATH}"])
    if shown.returncode != 0:
        return None
    return parse(shown.stdout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="main", help="git ref holding the previous ratchet (default: main)")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    root: Path = args.root
    try:
        current = parse((root / RATCHET_PATH).read_text())
        base = load_base(root, args.base)
    except (OSError, LookupError, RatchetError, subprocess.CalledProcessError, tomllib.TOMLDecodeError) as exc:
        sys.stderr.write(f"ratchet: FAIL: {exc}\n")
        return 1
    errors = check(current, base, root)
    for error in errors:
        sys.stderr.write(f"ratchet: FAIL: {error}\n")
    if errors:
        return 1
    note = "first introduction, no base file" if base is None else f"no loosening vs {args.base}"
    sys.stdout.write(f"ratchet: OK ({len(current)} thresholds match their configs; {note})\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
