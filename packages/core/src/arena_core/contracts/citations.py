"""The one citation module (S2 4.4.1, D6): every quote match in the arena is decided here.

S2's post-checks (4.4) and J1 quote check (7.2), the referee's J3 input filter (7.3) and S3's scorer (S3 5.3,
M08 stage 1 and check 5b) import it; the browser runs a TypeScript port (`web/src/lib/contracts/quote.ts`)
against the same fixture file, `contracts/fixtures/citations.json`. Nothing else implements a quote rule.

A record's text is S1's `content_text()` (S1 6.1), the one rendering of a Content object; it is imported, never
re-implemented here.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from arena_core.scenario.content import content_text

__all__ = [
    "Cite",
    "Record",
    "Turn",
    "cite_ok",
    "cites_of",
    "content_text",
    "finding_citation_ok",
    "flag_citations_ok",
    "normalize",
    "quote_ok",
    "record_citable",
    "turn_citable",
]

_FOLD = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2212": "-",
        **{chr(c): "-" for c in range(0x2010, 0x2016)},
    }
)
_WHITESPACE = re.compile(r"\s+")
MIN_QUOTE_WORDS = 3


def normalize(text: str) -> str:
    """NFKC; curly quotes and apostrophes to straight; dashes U+2010-U+2015 and U+2212 to '-'; whitespace runs
    to one space; trimmed; case kept. For matching only: stored text is never rewritten."""
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", text).translate(_FOLD)).strip()


def quote_ok(quote: str, text: str) -> bool:
    """D6: the normalized quote is a substring of the normalized text with at least 3 words, or equals the whole
    normalized text when that text is shorter."""
    q, t = normalize(quote), normalize(text)
    return bool(q) and q in t and (len(q.split(" ")) >= MIN_QUOTE_WORDS or q == t)


@dataclass(frozen=True)
class Turn:
    """A committed row of the trial's own `arena.turns` (a replay trial's copies too, D2)."""

    answer: str | None
    partial: bool = False


@dataclass(frozen=True)
class Record:
    """An initial document (`released_after` None) or a released record; `text` is `content_text(content)`."""

    text: str
    released_after: int | None = None


@dataclass(frozen=True)
class Cite:
    quote: str
    turn_no: int | None = None
    record_id: str | None = None


def cites_of(flag: Mapping[str, Any]) -> list[Cite]:
    """The citations of one stored card.v1 flag, main citation first (S3 1.3.1 uses this mapping)."""
    out = [Cite(flag["quote"], turn_no=int(flag["turn_id"][1:]))]
    if flag["kind"] == "contradiction":
        out.append(Cite(flag["conflict_quote"], turn_no=int(flag["conflict_turn_id"][1:])))
    if flag["kind"] == "evidence_conflict":
        out.append(Cite(flag["conflict_record_quote"], record_id=flag["conflict_record_id"]))
    return out


def turn_citable(turns: Mapping[int, Turn], turn_no: int, as_of_turn: int) -> bool:
    t = turns.get(turn_no)
    return t is not None and turn_no <= as_of_turn and t.answer is not None and not t.partial


def record_citable(records: Mapping[str, Record], record_id: str, as_of_releases: int) -> bool:
    r = records.get(record_id)
    return r is not None and (r.released_after is None or r.released_after <= as_of_releases)


def cite_ok(
    c: Cite, turns: Mapping[int, Turn], records: Mapping[str, Record], as_of_turn: int, as_of_releases: int
) -> bool:
    if c.turn_no is not None:
        answer = turns[c.turn_no].answer if turn_citable(turns, c.turn_no, as_of_turn) else None
        return answer is not None and quote_ok(c.quote, answer)
    return (
        c.record_id is not None
        and record_citable(records, c.record_id, as_of_releases)
        and quote_ok(c.quote, records[c.record_id].text)
    )


def _spans(q: str, t: str) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    i = t.find(q)
    while i != -1:
        out.append((i, i + len(q)))
        i = t.find(q, i + 1)
    return out


def flag_citations_ok(
    kind: str, cites: list[Cite], turns: Mapping[int, Turn], records: Mapping[str, Record], card_turn: int
) -> bool:
    """Citation existence (S2 4.4) for a flag on the card of exchange `card_turn`: the card saw turns
    1..card_turn and the records released before question card_turn (released_after <= card_turn - 1)."""
    if not all(cite_ok(c, turns, records, card_turn, card_turn - 1) for c in cites):
        return False
    if kind == "contradiction" and cites[0].turn_no == cites[1].turn_no and cites[0].turn_no is not None:
        answer = turns[cites[0].turn_no].answer or ""
        t = normalize(answer)
        a, b = normalize(cites[0].quote), normalize(cites[1].quote)
        return any(e1 <= s2 or e2 <= s1 for s1, e1 in _spans(a, t) for s2, e2 in _spans(b, t))
    return True


def finding_citation_ok(
    turns: Mapping[int, Turn], records: Mapping[str, Record], as_of_turn: int, as_of_releases: int, cited: int | str
) -> bool:
    """One entry of a Finding's cited_turns (`cited` a turn number) or cited_records (`cited` a record ID)
    (S2 4.3, S3 check 5b): a committed, non-partial answer, or an initial document or a record released by then.
    The running finding on the card of exchange n uses (n, n - 1); a final or committed finding uses (completed
    exchanges, completed exchanges). S2's reference passes the target as `turn_no=` or `record_id=`; one
    argument whose type says which keeps the call unambiguous."""
    if isinstance(cited, int):
        return turn_citable(turns, cited, as_of_turn)
    return record_citable(records, cited, as_of_releases)
