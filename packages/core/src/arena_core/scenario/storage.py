"""Text PostgreSQL cannot store (V1.storage).

JSON strings may hold U+0000 or a lone surrogate, which PostgreSQL `jsonb` and `text` refuse, so a family
that passes the S1 schema could still fail `sealed.ingest_case_family`. V1 refuses such a family before it
reaches S4. Sizes are V1d's (`arena_core.scenario.content`).
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping

_SURROGATES = range(0xD800, 0xE000)


def _strings(value: object, path: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, Mapping):
        for key, child in value.items():
            yield f"{path}/{key}", str(key)
            yield from _strings(child, f"{path}/{key}")
    elif isinstance(value, list | tuple):
        for index, child in enumerate(value):
            yield from _strings(child, f"{path}/{index}")


def unstorable_text(value: object) -> list[str]:
    """Paths of strings (keys or values) PostgreSQL cannot store: a U+0000 or a lone surrogate."""
    problems: list[str] = []
    for path, text in _strings(value, ""):
        if "\x00" in text:
            problems.append(f"NUL character at {path or '/'}")
        if any(ord(ch) in _SURROGATES for ch in text):
            problems.append(f"lone surrogate at {path or '/'}")
    return problems
