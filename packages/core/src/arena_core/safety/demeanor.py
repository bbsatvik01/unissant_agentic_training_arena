"""`demeanor_lexicon.v1` (S2 4.4): the deterministic demeanor post-check on coach-written text.

Applied to the claim text a coach writes in a flag (`missing_fact`) and to `finding.rationale`, never to quoted
subject words (a subject may say "I was nervous") and never to `question.assessment`. A match is a
case-insensitive whole word or phrase. As in `arena_core.scenario.relay` R8, text is NFKC-folded with
typographic apostrophes folded to "'", and every scan form of `guardscan.scan_forms` is read, so a zero-width or
fullwidth disguise cannot hide a term. J3's `content_based` check is the semantic backstop for paraphrases.

The lexicon is tuned for zero hits on `FX-DEM-NEUTRAL`; a term that produces a false hit there is removed or
narrowed in the spec first, never left in.
"""

from __future__ import annotations

import re
import unicodedata

from arena_core.scenario.guardscan import scan_forms

DEMEANOR_LEXICON_VERSION = "demeanor_lexicon.v1"
DEMEANOR_LEXICON: tuple[str, ...] = (
    "nervous",
    "nervously",
    "nervousness",
    "anxious",
    "anxiety",
    "hesitant",
    "hesitated",
    "hesitation",
    "hesitating",
    "stammer",
    "stammered",
    "stammering",
    "stutter",
    "stuttered",
    "stuttering",
    "fidget",
    "fidgeting",
    "sweating",
    "eye contact",
    "tone of voice",
    "his tone",
    "her tone",
    "their tone",
    "accent",
    "demeanor",
    "demeanour",
    "body language",
    "defensive",
    "uneasy",
    "flustered",
    "rambling",
    "filler words",
    "fluency",
    "grammar",
    "emotional",
    "seemed upset",
    "confident manner",
    "sounded nervous",
    "sounded unsure",
)
_APOSTROPHES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u02bc": "'"})
# Longest first, so "sounded nervous" is reported rather than its "nervous"; a phrase matches across any
# whitespace run, as a reader sees it.
_TERMS = re.compile(
    r"(?<!\w)(?:"
    + "|".join(r"\s+".join(map(re.escape, t.split())) for t in sorted(DEMEANOR_LEXICON, key=len, reverse=True))
    + r")(?!\w)",
    re.IGNORECASE,
)


def demeanor_terms(text: str) -> list[str]:
    """The lexicon terms in `text`, lowercased, in order of first appearance, each once."""
    found: dict[str, None] = {}
    for form in scan_forms(text):
        folded = unicodedata.normalize("NFKC", form).translate(_APOSTROPHES)
        for match in _TERMS.finditer(folded):
            found[" ".join(match.group(0).lower().split())] = None
    return list(found)


def is_demeanor_based(text: str) -> bool:
    return bool(demeanor_terms(text))
