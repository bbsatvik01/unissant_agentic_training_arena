"""A voice session's stored exchanges as question-and-answer turns (UI v2 amendment to D7: voice is scored and
coached like text).

Each `training.voice_exchanges` row is one exchange window: the role-tagged transcription lines that arrived since
the previous Live turn boundary. Its investigator lines form the turn's question and its subject lines the answer,
each cleaned and cut at a word to the same bounds a typed question and a subject answer have (S2 1, D11), so the
coach and the referee read voice turns through the very contracts they read text turns with. A window without
both a question and an answer (silence, a lone interruption) is no turn. Turns are numbered 1..n in exchange order;
`exchange_no` keeps the window's own number. A turn is `partial` when any of its subject lines was interrupted.
Nothing here reads the database or calls a model.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from arena_core.contracts.rendered import (
    ANSWER_MAX_CHARS,
    QUESTION_MAX_CHARS,
    TextTooLongError,
    check_answer,
    check_question,
    clean,
)
from arena_core.voice.protocol import cut_words

_SHRINK = 0.9  # each retry keeps 90% of the characters, for text whose escaped bytes pass the bound


def _fit(text: str, limit_chars: int, check: Callable[[str], str]) -> str:
    """`text` cleaned and cut at a word until `check` accepts it; empty when nothing of it fits."""
    fitted = cut_words(clean(text), limit_chars)
    while fitted:
        try:
            return check(fitted)
        except TextTooLongError:  # silent-ok: too many escaped bytes; the loop cuts it shorter and checks again
            fitted = cut_words(fitted, int(len(fitted) * _SHRINK))
    return ""


def _said(lines: Sequence[Mapping[str, Any]], role: str) -> str:
    return " ".join(str(line.get("text") or "") for line in lines if line.get("role") == role)


def voice_turns(exchanges: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """`[{turn_no, exchange_no, question, answer, partial}]` from stored exchanges `{exchange_no, lines}`."""
    out: list[dict[str, Any]] = []
    for exchange in sorted(exchanges, key=lambda e: int(e["exchange_no"])):
        lines = list(exchange.get("lines") or [])
        question = _fit(_said(lines, "investigator"), QUESTION_MAX_CHARS, check_question)
        answer = _fit(_said(lines, "subject"), ANSWER_MAX_CHARS, check_answer)
        if not question or not answer:
            continue
        partial = any(line.get("role") == "subject" and bool(line.get("partial")) for line in lines)
        out.append(
            {
                "turn_no": len(out) + 1,
                "exchange_no": int(exchange["exchange_no"]),
                "question": question,
                "answer": answer,
                "partial": partial,
            }
        )
    return out
