"""The salted untrusted-data boundary of every prompt (S2 1; lift: gokbase `injection_defense.py:86-95`, G8).

Every field a model or an investigator wrote reaches a prompt only inside `<untrusted_{kind}_{salt}>` ...
`</untrusted_{kind}_{salt}>`, with a salt of 8 hex characters drawn fresh per model call (`secrets.token_hex(4)`)
and never written to any output, span or log. Before it is placed in a block, each untrusted string is
sanitized (`fence.sanitize_untrusted_text`) and its whitespace collapsed (S2 1, Text normalization). Trusted
blocks carry only code-validated identifiers and counts (D5).
"""

from __future__ import annotations

import re
import secrets

from arena_core.contracts.rendered import (
    ANSWER_MAX_BYTES,
    QUESTION_MAX_BYTES,
    QUESTION_MAX_CHARS,
    TextTooLongError,
    check_answer,
    check_question,
    check_rendered,
    clean,
    rendered_bytes,
    sanitized,
)

__all__ = [
    "ANSWER_MAX_BYTES",
    "QUESTION_MAX_BYTES",
    "QUESTION_MAX_CHARS",
    "TAG_KINDS",
    "TextTooLongError",
    "check_answer",
    "check_question",
    "check_rendered",
    "check_salt",
    "clean",
    "clean_lines",
    "new_salt",
    "rendered_bytes",
    "wrap",
]

TAG_KINDS = frozenset({"case", "records", "transcript", "question", "flags", "followups", "finding"})
_SALT = re.compile(r"[0-9a-f]{8}")


def new_salt() -> str:
    """A fresh per-call salt (S2 1)."""
    return secrets.token_hex(4)


def clean_lines(text: str) -> str:
    """Untrusted text whose line structure is meaningful (a record's body then its table rows): each line
    cleaned on its own."""
    return "\n".join(clean(line) for line in sanitized(text).split("\n"))


def check_salt(salt: str) -> str:
    if not _SALT.fullmatch(salt):
        msg = "an untrusted tag salt is 8 lowercase hex characters"
        raise ValueError(msg)
    return salt


def wrap(kind: str, body: str, salt: str) -> str:
    """`body` (already cleaned field by field) inside the salted tag of `kind`."""
    if kind not in TAG_KINDS:
        msg = f"unknown untrusted tag kind {kind!r}"
        raise ValueError(msg)
    check_salt(salt)
    return f"<untrusted_{kind}_{salt}>\n{body}\n</untrusted_{kind}_{salt}>"
