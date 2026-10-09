"""Deterministic post-checks on a validated card (S2 4.4; AT-COACH-5, AT-COACH-6).

These never trigger a repair: their results are what the metrics count (S2 10). Per flag: citation existence
through the one shared module (`contracts.citations.flag_citations_ok`, D6), the demeanor lexicon on the
coach-written claim (`missing_fact`), and the duplicate check against flags of earlier cards; per card: the
demeanor lexicon on `finding.rationale`. `question.assessment` is never scanned (the coach is required to call out
a demeanor-driven question there) and neither are quoted subject words (a subject may say "I was nervous").

The lexicon's terms are an argument: `demeanor_lexicon.v1` is its own versioned file (S2 4.4, WP-11).
`j3_flags` selects what the flag-support judge receives: flags whose citation exists, each distinct flag once
(S2 4.4 duplicate rule; S2 7.1).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence

from arena_core.contracts.citations import Record, Turn, cites_of, flag_citations_ok, normalize
from arena_core.contracts.coaching import CardValidation, CoachingCard, FlagCheck, StoredCard, StoredFlag
from arena_core.contracts.common import turn_no


def lexicon_pattern(terms: Iterable[str]) -> re.Pattern[str]:
    """Case-insensitive whole-word or whole-phrase match of any term; a phrase matches across any whitespace."""
    words = sorted({t.strip().lower() for t in terms if t.strip()}, key=len, reverse=True)
    if not words:
        msg = "the demeanor lexicon is empty"
        raise ValueError(msg)
    alternatives = "|".join(r"\s+".join(re.escape(w) for w in term.split()) for term in words)
    return re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)", re.IGNORECASE)


def _key(kind: str, turn: str, quote: str) -> tuple[str, str, str]:
    return kind, turn, normalize(quote)


def card_validation(
    card: CoachingCard,
    turns: Mapping[int, Turn],
    records: Mapping[str, Record],
    earlier_flags: Sequence[StoredFlag],
    lexicon: re.Pattern[str],
) -> CardValidation:
    """The `validation` field of the stored card (S2 4.1) from the S2 4.4 checks."""
    seen = {_key(f.kind, f.turn_id, f.quote) for f in earlier_flags}
    current = turn_no(card.turn_id)
    checks: dict[str, FlagCheck] = {}
    for i, flag in enumerate(card.flags, start=1):
        checks[f"{card.turn_id}.f{i}"] = FlagCheck(
            citation_ok=flag_citations_ok(flag.kind, cites_of(flag.model_dump()), turns, records, current),
            demeanor_based=flag.missing_fact is not None and lexicon.search(flag.missing_fact) is not None,
            duplicate=_key(flag.kind, flag.turn_id, flag.quote) in seen,
        )
    return CardValidation(
        valid=True, flags=checks, demeanor_in_rationale=lexicon.search(card.finding.rationale) is not None
    )


def j3_flags(cards: Iterable[StoredCard]) -> list[StoredFlag]:
    """Flags that passed citation existence, each distinct (kind, turn, normalized quote) once, in card order."""
    out: list[StoredFlag] = []
    seen: set[tuple[str, str, str]] = set()
    for card in cards:
        for flag in card.flags:
            key = _key(flag.kind, flag.turn_id, flag.quote)
            if card.validation.flags[flag.flag_ref].citation_ok and key not in seen:
                seen.add(key)
                out.append(flag)
    return out
