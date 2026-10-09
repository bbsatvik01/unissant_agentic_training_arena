"""Text as a prompt carries it, and the D11 byte bound on it (S2 1, 2; D11).

`clean` is the one normalization of an untrusted field before it is placed in a prompt: `fence.sanitize_untrusted_text`
(NFKC, hidden characters and injection markers removed) repeated until nothing changes, then whitespace collapsed.
Both are pure and memoized (a prompt renders the same answers and records on every turn).
It never raises: text built so that every pass rebuilds a marker (`<sys<system>tem>` nested past any pass count)
loses its angle and square brackets, after which no marker can form.

`rendered_bytes` is the D11 measure of a field: the UTF-8 bytes its cleaned text occupies in a serialized request
(JSON string escapes included: `"` and `\\` count 2, a control character 6). NFKC can expand one character to 18
(U+FDFA) and escaping doubles a quote, so neither a character cap nor a raw byte cap bounds a prompt; every byte
bound S2 sets on a field is checked on this measure (`check_rendered`, `rendered_overruns`):

- an investigator or harness question: at most 600 characters and `QUESTION_MAX_BYTES` (1,800) rendered bytes
  (`check_question`; S5's turn submission refuses a longer one before commit, and S6's form states the same bound);
- a subject answer: `ANSWER_MAX_BYTES` (1,800) rendered bytes;
- every model-written or `Finding` field with a `ByteLimit`: that limit, rendered.
"""

from __future__ import annotations

import json
import re
import typing
from functools import lru_cache

from pydantic import BaseModel

from arena_core.agents.fence import sanitize_untrusted_text
from arena_core.contracts.common import ByteLimit

QUESTION_MAX_CHARS = 600
QUESTION_MAX_BYTES = 1800
ANSWER_MAX_BYTES = 1800
_WHITESPACE = re.compile(r"\s+")
_BRACKETS = str.maketrans("", "", "<>[]")
_MAX_PASSES = 32


class TextTooLongError(ValueError):
    """Text whose rendered form exceeds its byte bound (D11)."""


@lru_cache(maxsize=4096)
def sanitized(text: str) -> str:
    """Sanitize to a fixpoint: one pass can rebuild a marker from the pieces around an inner one it removed."""
    for _ in range(_MAX_PASSES):
        cleaned = sanitize_untrusted_text(text)
        if cleaned == text:
            return cleaned
        text = cleaned
    # Text built to rebuild a marker on every pass: without brackets no marker can form, so this is the fixpoint.
    return sanitize_untrusted_text(text.translate(_BRACKETS))


@lru_cache(maxsize=4096)
def clean(text: str) -> str:
    """One untrusted field as one line: sanitized, whitespace runs collapsed to one space, trimmed."""
    return _WHITESPACE.sub(" ", sanitized(text)).strip()


def rendered_bytes(text: str) -> int:
    """UTF-8 bytes `text` occupies in a serialized request once cleaned (D11)."""
    return len(json.dumps(clean(text), ensure_ascii=False).encode("utf-8")) - 2


def check_rendered(text: str, max_bytes: int, what: str) -> str:
    size = rendered_bytes(text)
    if size > max_bytes:
        msg = f"{what}: {size} bytes as rendered, more than {max_bytes} (D11)"
        raise TextTooLongError(msg)
    return text


def check_question(text: str) -> str:
    """A question as it may be committed: 600 characters and 1,800 rendered bytes (D11). Nothing is ever cut."""
    if len(text) > QUESTION_MAX_CHARS:
        msg = f"question: {len(text)} characters, more than {QUESTION_MAX_CHARS}"
        raise TextTooLongError(msg)
    return check_rendered(text, QUESTION_MAX_BYTES, "question")


def check_answer(text: str) -> str:
    return check_rendered(text, ANSWER_MAX_BYTES, "answer")


def _limit_in(metadata: typing.Iterable[object]) -> int | None:
    return next((m.limit for m in metadata if isinstance(m, ByteLimit)), None)


def _byte_limit(annotation: object) -> int | None:
    """The `ByteLimit` of a string annotation, looking through Annotated, Optional and list."""
    if typing.get_origin(annotation) is typing.Annotated:
        base, *metadata = typing.get_args(annotation)
        return _limit_in(metadata) or _byte_limit(base)
    for arg in typing.get_args(annotation):
        found = _byte_limit(arg)
        if found is not None:
            return found
    return None


def rendered_overruns(value: BaseModel, path: str = "") -> list[str]:
    """Every string field (nested models and lists included) whose rendered bytes exceed its `ByteLimit`."""
    out: list[str] = []
    for name, info in type(value).model_fields.items():
        item = getattr(value, name)
        limit = _limit_in(info.metadata) or _byte_limit(info.annotation)
        items = item if isinstance(item, list) else [item]
        for i, element in enumerate(items):
            at = f"{path}{name}.{i}" if isinstance(item, list) else f"{path}{name}"
            if isinstance(element, BaseModel):
                out += rendered_overruns(element, f"{at}.")
            elif isinstance(element, str) and limit is not None and rendered_bytes(element) > limit:
                out.append(f"{at}: longer than {limit} bytes as rendered (D11)")
    return out
