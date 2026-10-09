"""Untrusted-data boundary: `sanitize_untrusted_text` (lift: gokbase G8, S5 2.3).

`sanitize_untrusted_text` is lifted from gokbase `backend/app/rag/v3/injection_defense.py` lines 28-83
(ATTRIBUTIONS.md G8): same character classes, same order of steps, same marker set. It lands here in
WP-08 because S2 8.2 `relay_test.v1` normalizes every question with it (`arena_core.scenario.relay`),
and one copy keeps the relay test and the fence from drifting. `wrap_evidence` and the arena's own
`untrusted_*` tag handling (S2 6.3, 6.9 G2) land with the rest of the fence in WP-11.
"""

from __future__ import annotations

import re
import unicodedata

# Characters kept even though they are control characters (Cc).
_KEEP_CONTROL = frozenset({"\n", "\t"})

# Tag characters (U+E0000 to U+E007F): invisible, can smuggle instructions. Cf on modern Python; the
# range check keeps that true across unicodedata versions.
_TAG_LO, _TAG_HI = 0xE0000, 0xE007F

_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)

# Chat-role and instruction-template delimiters an attacker might embed to impersonate the system or
# break framing. Only these are stripped (not every `<...>`), so `a < b` style text survives. Public because S2
# 6.9 G2 rejects the same markers (`arena_core.safety.guard`): one marker set for the fence and the guard.
INJECTION_MARKERS = re.compile(
    r"</?\s*(?:system|user|assistant|human|ai|tool|function|developer|sys)\s*>"
    r"|<\|[^>]{0,40}\|>"
    r"|\[/?\s*INST\s*\]|<</?\s*SYS\s*>>"
    r"|</?\s*untrusted_evidence[^>]*>",
    re.IGNORECASE,
)


def sanitize_untrusted_text(text: str) -> str:
    """Strip hidden, Unicode and structural injection vectors from untrusted text.

    Removes Cc (except newline and tab), Cf and Co characters, tag characters, HTML comments and
    chat-role delimiters; normalizes CRLF and CR to LF; NFKC-folds confusables. Printable letters,
    marks, symbols and punctuation are preserved.
    """
    if not text:
        return text
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for ch in text:
        if ch in _KEEP_CONTROL:
            out.append(ch)
            continue
        if _TAG_LO <= ord(ch) <= _TAG_HI:
            continue
        if unicodedata.category(ch) in ("Cc", "Cf", "Co"):
            continue
        out.append(ch)
    cleaned = unicodedata.normalize("NFKC", "".join(out))
    cleaned = _HTML_COMMENT.sub("", cleaned)
    return INJECTION_MARKERS.sub("", cleaned)
