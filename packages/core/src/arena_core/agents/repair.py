"""Output validation and the one schema repair message (S2 10; AT-COACH-4, AT-COACH-8, AT-SUBJ-3).

`output_errors` validates a model's reply against its output model and the trial context (a `CitationContext`
for coaching outputs, a `SubjectContext` for the subject), and returns the value or the field-path messages that
go into the repair turn: at most 10 items of at most 100 UTF-8 bytes each (TechnoMile `structured.py:131-134`).
The messages name fields and rules, never the reply's free text: a Pydantic message is about the type or constraint
(`include_input=False`), and the arena's own validators name only IDs and enum words, which their models already
constrain.

`repair_message` is the user turn of the one repair. The agent port (WP-05) owns the attempt loop around these:
reservation, the echo of the previous reply cut to the byte budget, transient retries and deadlines.
"""

from __future__ import annotations

import typing
from functools import cache

from pydantic import BaseModel, ValidationError

from arena_core.agents.untrusted import rendered_bytes
from arena_core.contracts.common import ByteLimit

MAX_ERRORS = 10
MAX_ERROR_BYTES = 100
UNKNOWN_KEY = "(unexpected key)"
SALT_LEAK = "reply: repeats the request's data-tag identifier; never copy tag names or identifiers"
REPAIR_SUFFIX = "Reply again with only the corrected JSON object."
MAX_TOKENS_REPAIR = (
    "Your reply was cut off at the output limit. Reply again with only the corrected JSON object, shorter."
)


def _cut(text: str, limit: int = MAX_ERROR_BYTES) -> str:
    data = text.encode("utf-8")
    if len(data) <= limit:
        return text
    return data[:limit].decode("utf-8", errors="ignore")


def _models_in(annotation: object) -> list[type[BaseModel]]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    return [m for arg in typing.get_args(annotation) for m in _models_in(arg)]


@cache
def field_names(model: type[BaseModel]) -> frozenset[str]:
    """Every field name and alias reachable from an output model: the only words a repair path may contain."""
    names: set[str] = set()
    todo, seen = [model], set()
    while todo:
        current = todo.pop()
        if current in seen:
            continue
        seen.add(current)
        for name, info in current.model_fields.items():
            names.add(name)
            if info.alias:
                names.add(info.alias)
            todo += _models_in(info.annotation)
    return frozenset(names)


def _path(loc: tuple[int | str, ...], known: frozenset[str]) -> str:
    """A field path from schema names and list indices only. A key the reply invented (an extra key, which a model
    controls) is never echoed: it becomes a fixed marker (S2 1, 10: no reply text in a trusted turn)."""
    parts = []
    for part in loc:
        if isinstance(part, int):
            parts.append(str(part))
        elif part in known:
            parts.append(part)
        else:
            parts.append(UNKNOWN_KEY)
            break
    return ".".join(parts)


def error_items(exc: ValidationError, known: frozenset[str]) -> list[str]:
    """Field-path messages, one per problem, bounded in count and size."""
    items: list[str] = []
    for err in exc.errors(include_input=False, include_url=False, include_context=False):
        path = _path(err["loc"], known)
        msg = str(err["msg"]).removeprefix("Value error, ")
        if err["type"] == "json_invalid":
            items.append("reply: not valid JSON")
        elif path:
            items.append(f"{path}: {msg}")
        else:
            # A model validator joins its own `field.path: message` items with "; ".
            items += [part for part in msg.split("; ") if part]
    return [_cut(i) for i in items[:MAX_ERRORS]]


def output_errors[T: BaseModel](
    model: type[T], reply: str, context: object | None = None, salt: str | None = None
) -> tuple[T | None, list[str]]:
    """The validated output, or None and the repair items (S2 10, first row). A reply that carries the request's
    salt is refused like a schema failure: the salt is never written to any output (S2 1)."""
    try:
        value = model.model_validate_json(reply, context=context)
    except ValidationError as exc:
        return None, error_items(exc, field_names(model))
    # Checked on the decoded values too: JSON escapes (`\\u0039f3a...`) hide the salt from the raw text.
    if salt is not None and (salt in reply or salt in value.model_dump_json()):
        return None, [SALT_LEAK]
    rendered = rendered_overruns(value)
    if rendered:
        return None, [_cut(i) for i in rendered[:MAX_ERRORS]]
    return value, []


def _limit_in(metadata: list[object]) -> int | None:
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
    """Every string field whose text, as a prompt renders it (`untrusted.clean`), exceeds the field's byte limit
    (D11): NFKC can expand a character up to 18 times, so a raw byte limit does not bound what a later prompt
    carries. A repair item, like any schema failure (S2 10)."""
    out: list[str] = []
    for name, info in type(value).model_fields.items():
        item = getattr(value, name)
        where = f"{path}{name}"
        limit = _limit_in(list(info.metadata)) or _byte_limit(info.annotation)
        items = item if isinstance(item, list) else [item]
        for i, element in enumerate(items):
            at = f"{where}.{i}" if isinstance(item, list) else where
            if isinstance(element, BaseModel):
                out += rendered_overruns(element, f"{at}.")
            elif isinstance(element, str) and limit is not None and rendered_bytes(element) > limit:
                out.append(f"{at}: longer than {limit} UTF-8 bytes once normalized")
    return out


def repair_message(errors: list[str]) -> str:
    """The repair user turn: `{errors}. Reply again with only the corrected JSON object.`"""
    if not errors:
        msg = "a repair needs at least one error"
        raise ValueError(msg)
    return f"{'; '.join(errors[:MAX_ERRORS])}. {REPAIR_SUFFIX}"
