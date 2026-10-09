"""Supabase config gate (S4 2.1 and Q9; WI-S4-01): no arena schema is exposed through the Data API.

A SECURITY DEFINER function in a schema the Data API exposes is callable over HTTP with the owner's privileges
(S4 2.1), so none of the six arena schemas may appear in supabase/config.toml's ``[api].schemas`` or on its
``[api].extra_search_path``. The list must be explicit: a missing ``[api]`` section or schema list fails too,
because the CLI would then apply its own default. Names compare case- and space-insensitively.
"""

import argparse
import sys
import tomllib
from pathlib import Path

CONFIG_PATH = "supabase/config.toml"
ARENA_SCHEMAS: frozenset[str] = frozenset({"arena", "subject", "sealed", "ledger", "training", "ops"})


def _names(value: object) -> list[str] | None:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return [str(item) for item in value]


def check(text: str) -> list[str]:
    """Errors for the config text (raises tomllib.TOMLDecodeError when it is not TOML)."""
    api = tomllib.loads(text).get("api")
    if not isinstance(api, dict):
        return ["[api] is missing: the exposed-schema list must be explicit"]
    schemas = _names(api.get("schemas"))
    if schemas is None:
        return ["[api].schemas must be an explicit list of schema names"]
    search_path = _names(api.get("extra_search_path", []))
    if search_path is None:
        return ["[api].extra_search_path must be a list of schema names"]
    errors = [
        f"[api].schemas exposes {name!r} through the Data API (S4 2.1)"
        for name in schemas
        if name.strip().lower() in ARENA_SCHEMAS
    ]
    errors.extend(
        f"[api].extra_search_path puts {name!r} on the Data API search path (S4 2.1)"
        for name in search_path
        if name.strip().lower() in ARENA_SCHEMAS
    )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    try:
        errors = check((args.root / CONFIG_PATH).read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        sys.stderr.write(f"supabase-config: FAIL: {CONFIG_PATH}: {exc}\n")
        return 1
    for error in errors:
        sys.stderr.write(f"supabase-config: FAIL: {error}\n")
    if errors:
        return 1
    sys.stdout.write(f"supabase-config: OK (no arena schema exposed in {CONFIG_PATH})\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
