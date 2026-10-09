"""Canonical JSON, sha256 and strict JSON reading shared by every hashed artifact (S5 1, S1 8.4).

Canonical JSON is the gokbase `_canonical` rule (`recruiter-backend/app/matching/rubrics.py` lines 60-61;
ATTRIBUTIONS.md G14) with `ensure_ascii=False` and UTF-8 encoding, exactly as S1 8.4 defines it for
repository hashes: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.

`read_json_text` is the strict reader every family file and family source goes through: Python's `json`
silently keeps the last of two duplicate keys and accepts `NaN` / `Infinity`, either of which would let
two different files hash or validate as something they do not say. Both are refused here.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


class StrictJSONError(ValueError):
    """The text is not strict JSON: a duplicate object key or a non-finite number."""


def canonical_json(obj: object) -> str:
    """Canonical JSON text (sorted keys, compact separators, non-ASCII kept)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_bytes(obj: object) -> bytes:
    return canonical_json(obj).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def canonical_sha256(obj: object) -> str:
    """sha256 of the canonical JSON of `obj` (S1 8.4 repository hash)."""
    return sha256_hex(canonical_bytes(obj))


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            msg = f"duplicate object key {key!r}"
            raise StrictJSONError(msg)
        out[key] = value
    return out


def _refuse_constant(name: str) -> object:
    msg = f"non-finite number {name} is not JSON"
    raise StrictJSONError(msg)


# Far deeper than any S1 file (the case families and schemas nest 8-12 levels), far shallower than the
# recursion every recursive walk of the result (validators, canonical JSON) can afford.
MAX_JSON_DEPTH = 64


def _finite_float(literal: str) -> float:
    """A JSON number with a fraction or exponent; one that overflows to infinity (1e9999) is refused."""
    value = float(literal)
    if not math.isfinite(value):
        msg = f"non-finite number {literal} (overflows a double) is not storable JSON"
        raise StrictJSONError(msg)
    return value


def read_json_text(text: str) -> object:
    """Parse JSON, refusing duplicate keys, NaN/Infinity, numbers that overflow to infinity and nesting
    deeper than `MAX_JSON_DEPTH` (all as StrictJSONError)."""
    try:
        parsed: object = json.loads(
            text,
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_refuse_constant,
            parse_float=_finite_float,
        )
    except RecursionError:
        msg = "JSON nested too deeply to parse"
        raise StrictJSONError(msg) from None
    if _depth(parsed) > MAX_JSON_DEPTH:
        msg = f"JSON nested deeper than {MAX_JSON_DEPTH} levels"
        raise StrictJSONError(msg)
    return parsed


def _depth(value: object) -> int:
    """Nesting depth of parsed JSON (a scalar is 0), computed without recursion."""
    deepest = 0
    stack: list[tuple[object, int]] = [(value, 0)]
    while stack:
        node, level = stack.pop()
        if isinstance(node, dict):
            children: list[object] = list(node.values())
        elif isinstance(node, list):
            children = list(node)
        else:
            continue
        deepest = max(deepest, level + 1)
        stack.extend((child, level + 1) for child in children)
    return deepest
