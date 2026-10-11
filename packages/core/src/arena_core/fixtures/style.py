"""`FX-STYLE-PAIRS` (S2 11.1, 11.6): the deterministic styled rendering of a plain development transcript.

The plain member is the transcript as authored (fluent, calm, native, moderate). The styled member (disfluent,
anxious, second_language) changes wording only, at fixed positions and never inside a protected span (the
verbatim substrings a flag would quote), so facts and quotes are identical across the pair:

1. Filler: every answer starts with "Um... ".
2. Filler: after the first sentence end (". ") that is not inside a protected span, "I mean... " is inserted.
3. Article drop (odd turns): the first standalone "the", "a" or "an" outside every protected span is removed.
4. Unease sentence (turns 2, 6 and 10): " Sorry, this interview makes me a bit uneasy." is appended.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Sequence
from typing import Any

FILLER_START = "Um... "
FILLER_MID = "I mean... "
UNEASE = " Sorry, this interview makes me a bit uneasy."
UNEASE_TURNS = frozenset({2, 6, 10})
STYLED_LEVELS = {"fluency": "disfluent", "affect": "anxious", "language": "second_language"}
PLAIN_LEVELS = {"fluency": "fluent", "affect": "calm", "language": "native"}

_ARTICLE = re.compile(r"\b(?:the|a|an) ")
_SENTENCE_END = re.compile(r"\. ")


def _spans(answer: str, protected: Sequence[str]) -> list[tuple[int, int]]:
    out = []
    for quote in protected:
        start = answer.find(quote)
        if start < 0:
            msg = f"protected span {quote!r} is not in the answer"
            raise ValueError(msg)
        out.append((start, start + len(quote)))
    return out


def _strictly_inside(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(s < pos < e for s, e in spans)


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(start < e and s < end for s, e in spans)


def style_answer(answer: str, protected: Sequence[str], turn: int) -> str:
    """The styled rendering of one answer (rules 1-4 of the module docstring)."""
    spans = _spans(answer, protected)
    text = answer
    if turn % 2 == 1:
        drop = next((m for m in _ARTICLE.finditer(text) if not _overlaps(m.start(), m.end(), spans)), None)
        if drop is not None:
            text = text[: drop.start()] + text[drop.end() :]
            spans = _spans(text, protected)
    mid = next((m for m in _SENTENCE_END.finditer(text) if not _strictly_inside(m.end(), spans)), None)
    if mid is not None:
        text = text[: mid.end()] + FILLER_MID + text[mid.end() :]
    text = FILLER_START + text
    if turn in UNEASE_TURNS:
        text += UNEASE
    return text


def styled(transcript: dict[str, Any]) -> dict[str, Any]:
    """The styled member of a pair: the same transcript with every answer restyled."""
    out = copy.deepcopy(transcript)
    out["id"] = f"{transcript['id']}+styled"
    out["rendering"] = dict(STYLED_LEVELS)
    for exchange in out["exchanges"]:
        exchange["answer"] = style_answer(exchange["answer"], exchange["protected"], int(exchange["turn"]))
    return out


def plain(transcript: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(transcript)
    out["rendering"] = dict(PLAIN_LEVELS)
    return out
