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

- an investigator or harness question: at most 600 characters and `QUESTION_MAX_BYTES` (2,400) rendered bytes
  (`check_question`; S5's turn submission refuses a longer one before commit, and S6's form states the same bound);
- a subject answer: `ANSWER_MAX_BYTES` (1,800) rendered bytes;
- every model-written or `Finding` field with a `ByteLimit`: that limit, rendered.
"""

from __future__ import annotations

import json
import re
import typing
from dataclasses import dataclass, replace
from functools import lru_cache

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from arena_core.agents.fence import sanitize_untrusted_text
from arena_core.contracts.common import ByteLimit

QUESTION_MAX_CHARS = 600
QUESTION_MAX_BYTES = 2400  # S2 1, 2: 600 characters counted at 4 bytes each
ANSWER_MAX_BYTES = 1800
ANSWER_MAX_CHARS = 900
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


def check_rendered(text: str, max_bytes: int, what: str, max_chars: int | None = None) -> str:
    """`text` as rendered is non-empty, within `max_chars` characters (stored text is the normalized form, S2 1)
    and within `max_bytes` bytes (D11)."""
    cleaned = clean(text)
    if not cleaned:
        msg = f"{what}: empty as rendered"
        raise TextTooLongError(msg)
    if max_chars is not None and len(cleaned) > max_chars:
        msg = f"{what}: {len(cleaned)} characters as rendered, more than {max_chars}"
        raise TextTooLongError(msg)
    size = rendered_bytes(text)
    if size > max_bytes:
        msg = f"{what}: {size} bytes as rendered, more than {max_bytes} (D11)"
        raise TextTooLongError(msg)
    return text


def check_question(text: str) -> str:
    """A question as it may be committed: 600 characters as typed and as rendered, 2,400 rendered bytes (D11).
    Nothing is ever cut."""
    if len(text) > QUESTION_MAX_CHARS:
        msg = f"question: {len(text)} characters, more than {QUESTION_MAX_CHARS}"
        raise TextTooLongError(msg)
    return check_rendered(text, QUESTION_MAX_BYTES, "question", QUESTION_MAX_CHARS)


def check_answer(text: str) -> str:
    return check_rendered(text, ANSWER_MAX_BYTES, "answer", ANSWER_MAX_CHARS)


@dataclass(frozen=True)
class _Limits:
    max_bytes: int | None = None
    max_chars: int | None = None
    min_chars: int | None = None


def _collect(metadata: typing.Iterable[object]) -> _Limits:
    out = _Limits()
    for m in metadata:
        if isinstance(m, ByteLimit):
            out = replace(out, max_bytes=m.limit)
        max_len = getattr(m, "max_length", None)
        min_len = getattr(m, "min_length", None)
        if isinstance(max_len, int):
            out = replace(out, max_chars=max_len)
        if isinstance(min_len, int):
            out = replace(out, min_chars=min_len)
    return out


def _string_limits(annotation: object) -> _Limits | None:
    """The limits of the string inside an annotation (through Optional and list; a list's own length bound is
    not a string bound)."""
    if annotation is str:
        return _Limits()
    if typing.get_origin(annotation) is typing.Annotated:
        base, *metadata = typing.get_args(annotation)
        inner = _string_limits(base)
        if inner is None:
            return None
        if base is str or typing.get_origin(base) is typing.Annotated:
            outer = _collect(metadata)
            return _Limits(
                outer.max_bytes or inner.max_bytes,
                outer.max_chars or inner.max_chars,
                outer.min_chars or inner.min_chars,
            )
        return inner
    for arg in typing.get_args(annotation):
        found = _string_limits(arg)
        if found is not None:
            return found
    return None


def _field_limits(info: FieldInfo) -> _Limits | None:
    if info.annotation is str:
        return _collect(info.metadata)
    return _string_limits(info.annotation)


def rendered_overruns(value: BaseModel, path: str = "") -> list[str]:
    """Every string field (nested models and lists included) whose rendered text is empty where the field needs
    text, or exceeds the field's character or byte limit (stored text is the normalized form, S2 1; D11)."""
    out: list[str] = []
    for name, info in type(value).model_fields.items():
        item = getattr(value, name)
        limits = _field_limits(info)
        items = item if isinstance(item, list) else [item]
        for i, element in enumerate(items):
            at = f"{path}{name}.{i}" if isinstance(item, list) else f"{path}{name}"
            if isinstance(element, BaseModel):
                out += rendered_overruns(element, f"{at}.")
            elif isinstance(element, str) and limits is not None:
                out += _string_overruns(element, limits, at)
    return out


def _string_overruns(text: str, limits: _Limits, at: str) -> list[str]:
    cleaned = clean(text)
    if limits.min_chars and len(cleaned) < limits.min_chars:
        return [
            f"{at}: shorter than {limits.min_chars} characters as rendered" if cleaned else f"{at}: empty as rendered"
        ]
    if limits.max_chars is not None and len(cleaned) > limits.max_chars:
        return [f"{at}: longer than {limits.max_chars} characters as rendered"]
    if limits.max_bytes is not None and rendered_bytes(text) > limits.max_bytes:
        return [f"{at}: longer than {limits.max_bytes} bytes as rendered (D11)"]
    return []
