"""`subject_guard.v1` (S2 6.9): the deterministic guard run on a validated subject utterance before
`record_subject_turn()`, and the G0 results of S2 6.10.

Rules, in the order they are checked; the first hit is the one reported (any hit rejects, S2 6.9):

- G1 hidden characters: Unicode Cc other than newline and tab, Cf, Co, or U+E0000 to U+E007F, in the raw text.
- G2 markup, role delimiters, links: the fence's marker set (gokbase `_INJECTION_MARKERS`, lifted in
  `arena_core.agents.fence`) extended with `</?\\s*untrusted_[a-z]+[^>]*>`; any of `< > { } [ ] ` |`;
  `https?://` or `www.`. Checked on the raw text and on its NFKC form, so a fullwidth bracket is still one.
- G3-G5: `arena_core.scenario.guardscan`, the one pattern source the scenario engine's V4c authoring scan also
  uses. This module holds no copy of that vocabulary.
- G6 recited instructions: an 8-gram shared with the reference set M (`RecitalIndex`).
- G7 size: more than 900 characters, 1,800 UTF-8 bytes or 120 words.

A rejection carries the rule ID and a matched span of at most 80 characters (S2 6.10). There is no
regeneration after a hit. `as_record()` is the `guard_result` object S4's `record_subject_turn` takes.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from arena_core.agents.fence import INJECTION_MARKERS
from arena_core.scenario import guardscan

GUARD_VERSION = guardscan.GUARD_VERSION
MAX_SPAN = 80
MAX_CHARS = 900
MAX_BYTES = 1800
MAX_WORDS = 120
NGRAM = 8

_ALLOWED_CONTROLS = frozenset({"\n", "\t"})
_TAG_LO, _TAG_HI = 0xE0000, 0xE007F
_HIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Co"})

# The fence's marker set already carries the arena extension `</?\s*untrusted_[a-z]+[^>]*>` (WP-10), so G2 uses it
# as is: one marker set for the fence and the guard.
G2_MARKERS = INJECTION_MARKERS
_G2_CHARACTERS = re.compile(r"[<>{}\[\]`|]")
_G2_LINKS = re.compile(r"https?://|www\.", re.IGNORECASE)
_TOKEN = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True, slots=True)
class GuardResult:
    passed: bool
    rule: str | None = None
    span: str | None = None

    def as_record(self) -> dict[str, Any]:
        """The `guard_result` jsonb for `record_subject_turn` (S4): `{passed}` or `{passed, rule[, span]}`."""
        if self.passed:
            return {"passed": True}
        out: dict[str, Any] = {"passed": False, "rule": self.rule}
        if self.span is not None:
            out["span"] = self.span
        return out


PASSED = GuardResult(passed=True)


def schema_failure() -> GuardResult:
    """S2 6.10: the output failed its schema after the one repair (quarantine with a null utterance)."""
    return GuardResult(passed=False, rule="G0_schema")


def provider_blocked() -> GuardResult:
    """S2 6.10: the provider blocked the output (`finish_reason` SAFETY and similar) after the one repair."""
    return GuardResult(passed=False, rule="G0_blocked")


def tokens(text: str) -> list[str]:
    """S2 6.9 G6 tokenization: `re.findall(r"[a-z0-9]+", nfkc(text).lower())`."""
    return _TOKEN.findall(unicodedata.normalize("NFKC", text).lower())


def ngrams(text: str, n: int = NGRAM) -> set[tuple[str, ...]]:
    """The n-grams of one string's tokens (never across two strings)."""
    words = tokens(text)
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


@dataclass(frozen=True, slots=True)
class RecitalIndex:
    """The G6 reference set M: every 8-gram of the subject's rendered system instruction (base, role, policy and
    style blocks) and of the ledger heading lines, minus every 8-gram that also occurs in the case's own public
    text or private fact text (S2 6.9). Built once per trial context by the subject service."""

    grams: frozenset[tuple[str, ...]]

    @classmethod
    def build(cls, reference_texts: Iterable[str], case_texts: Iterable[str]) -> RecitalIndex:
        reference: set[tuple[str, ...]] = set()
        for text in reference_texts:
            reference |= ngrams(text)
        for text in case_texts:
            reference -= ngrams(text)
        return cls(frozenset(reference))

    @classmethod
    def empty(cls) -> RecitalIndex:
        return cls(frozenset())

    def __len__(self) -> int:
        return len(self.grams)


def _span(text: str) -> str:
    return text[:MAX_SPAN]


def _g1(raw: str) -> str | None:
    for ch in raw:
        if ch in _ALLOWED_CONTROLS:
            continue
        if _TAG_LO <= ord(ch) <= _TAG_HI or unicodedata.category(ch) in _HIDDEN_CATEGORIES:
            return f"U+{ord(ch):04X}"
    return None


def _g2(raw: str) -> str | None:
    for form in dict.fromkeys((raw, unicodedata.normalize("NFKC", raw))):
        for pattern in (G2_MARKERS, _G2_CHARACTERS, _G2_LINKS):
            found = pattern.search(form)
            if found is not None:
                return found.group(0)
    return None


def _g3_to_g5(raw: str) -> tuple[str, str] | None:
    hits = guardscan.guard_hits(raw)
    return (hits[0].rule, hits[0].match) if hits else None


def _g6(raw: str, recital: RecitalIndex) -> str | None:
    if not recital.grams:
        return None
    words = tokens(raw)
    for i in range(len(words) - NGRAM + 1):
        gram = tuple(words[i : i + NGRAM])
        if gram in recital.grams:
            return " ".join(gram)
    return None


def _g7(raw: str) -> str | None:
    if len(raw) > MAX_CHARS or len(raw.encode("utf-8")) > MAX_BYTES or len(raw.split()) > MAX_WORDS:
        return raw
    return None


def check_utterance(utterance: str, recital: RecitalIndex) -> GuardResult:
    """Run G1-G7 on the raw utterance; the first rule that hits rejects it."""
    if (hit := _g1(utterance)) is not None:
        return GuardResult(passed=False, rule="G1", span=hit)
    if (hit := _g2(utterance)) is not None:
        return GuardResult(passed=False, rule="G2", span=_span(hit))
    if (lexical := _g3_to_g5(utterance)) is not None:
        return GuardResult(passed=False, rule=lexical[0], span=_span(lexical[1]))
    if (hit := _g6(utterance, recital)) is not None:
        return GuardResult(passed=False, rule="G6", span=_span(hit))
    if (hit := _g7(utterance)) is not None:
        return GuardResult(passed=False, rule="G7", span=_span(hit))
    return PASSED
