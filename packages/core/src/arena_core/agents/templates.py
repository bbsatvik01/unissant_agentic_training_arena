"""Prompt files and the one template renderer (S2 3.1, 5.4, 6.7).

Prompt files live under `prompts/` at the repository root and are named by repository-relative POSIX paths, the
form a manifest records (`prompts/coach/common.v1.txt`). A file's `sha256` is of its UTF-8 bytes with LF line
endings (S2 3.1); a file with a CR, or that is not UTF-8, is refused rather than hashed.

`render` fills `{{name}}` placeholders in one pass over the template, so text inserted for one placeholder is never
read again as a template: an investigator who types `{{salt}}` gets those characters, not the salt. Every
placeholder must be given a value and every value must have a placeholder, so a template edit that drops or
renames a block fails loudly instead of rendering a prompt without it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePosixPath

from arena_core.ids import sha256_hex

# packages/core/src/arena_core/agents/templates.py -> the repository root.
REPO_ROOT = Path(__file__).resolve().parents[5]
_PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")
_REL_PATH = re.compile(r"^[a-z0-9_-]+(?:/[A-Za-z0-9_.-]+)+$")


def require[T](value: object, kind: type[T], builder: str) -> T:
    """A builder's runtime type refusal (S5 1.2 item 3: mypy and a runtime check): `value` must be a `kind`."""
    if not isinstance(value, kind):
        msg = f"the {builder} takes a {kind.__name__}, not {type(value).__name__}"
        raise TypeError(msg)
    return value


class TemplateError(ValueError):
    """A template and its values do not match, or a prompt file cannot be read as one."""


def check_rel_path(rel: str) -> str:
    """A repository-relative POSIX path with no `..`, no leading `/` and no empty segment."""
    if not _REL_PATH.fullmatch(rel) or ".." in PurePosixPath(rel).parts:
        msg = f"not a repository-relative prompt path: {rel!r}"
        raise TemplateError(msg)
    return rel


def read_text(rel: str, root: Path = REPO_ROOT) -> str:
    """A prompt file's text: UTF-8, LF line endings."""
    data = (root / check_rel_path(rel)).read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        msg = f"{rel}: not UTF-8"
        raise TemplateError(msg) from exc
    if "\r" in text:
        msg = f"{rel}: CR line endings (prompt files are LF only)"
        raise TemplateError(msg)
    return text


def file_sha256(rel: str, root: Path = REPO_ROOT) -> str:
    """S2 3.1: sha256 of the file's UTF-8 bytes with LF line endings."""
    return sha256_hex(read_text(rel, root).encode("utf-8"))


def placeholders(template: str) -> set[str]:
    return {m.group(1) for m in _PLACEHOLDER.finditer(template)}


def render(template: str, values: Mapping[str, str]) -> str:
    """Fill every `{{name}}` with `values[name]` in a single pass."""
    names = placeholders(template)
    missing = sorted(names - set(values))
    unused = sorted(set(values) - names)
    if missing or unused:
        msg = f"template placeholders missing values {missing}, values without placeholders {unused}"
        raise TemplateError(msg)
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], template)


def join_blocks(blocks: Iterable[str]) -> str:
    """S2 3.1 `prompt.assembly`: files concatenated, separated by one blank line; empty blocks are skipped."""
    return "\n\n".join(b.strip("\n") for b in blocks if b.strip("\n"))
