r"""S2 `relay_test.v1` (S2 8.2) and `replay_script.v1` (S2 8.6): the one module S1 and S2 both import.

S1's validator V1c (S1 9.1) runs every case's opening question, its rendered replay script and its
evidence-slot questions through `relay_test`; the interviewer harness (S2 8.2-8.6, WP-17) relays coach
follow-ups through the same function. Keeping one implementation is what lets V1c promise that every
authored question will pass at run time.

Steps run in S2's order and the first failure stops the test with its reason code:

1. Normalize: `sanitize_untrusted_text` (gokbase lift, `arena_core.agents.fence`), collapse whitespace,
   strip one pair of surrounding straight or curly quotes.
2. R1 length: 3 to 40 words (`too_short`, `too_long`).
3. R2 one question: ends with "?" and holds exactly one (`not_single_question`).
4. R3 plain text: none of `< > { } [ ] ` | * # _ ~`, no `https?://` or `www.`, and no line break in the
   raw string (`markup`).
5. R4 no identifiers: `\b[fug]:\d{2,3}\b`, `\brec-\d{2}\b` (`identifier`).
6. R5 addressed to the subject (`not_addressed_to_subject`).
7. R6 not compound (`compound`).
8. R7 no tag question (`leading_tag`).
9. R8 neutrality lexicon `neutrality_lexicon.v1`, whole words or phrases (`non_neutral:<group>`).
10. R9 not a repeat of a question already asked in the trial, compared lowercased with punctuation
    removed (`repeat`).

Two readings of S2's text are fixed here and only ever make the test stricter: a "newline" in R3 is any
of LF, CR, U+2028 or U+2029 in the raw string; and the pattern rules R5-R8 match on a copy whose
typographic apostrophes (U+2018, U+2019, U+02BC) are folded to "'", so "isn't it true" spelled with
U+2019 cannot slip past R8. The relayed question itself is the normalized text, unchanged by that fold.
R9 also collapses whitespace after removing punctuation, so "B - 12" and "B 12" compare equal.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from arena_core.agents.fence import sanitize_untrusted_text

RELAY_TEST_VERSION = "relay_test.v1"
REPLAY_SCRIPT_VERSION = "replay_script.v1"

MIN_WORDS = 3
MAX_WORDS = 40

_I = re.IGNORECASE
_NEWLINES = ("\n", "\r", "\u2028", "\u2029")
_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("\u201c", "\u201d"), ("\u2018", "\u2019"))
_APOSTROPHES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u02bc": "'"})

_MARKUP = re.compile(r"[<>{}\[\]`|*#_~]|https?://|www\.", _I)
_IDENTIFIER = re.compile(r"\b[fug]:\d{2,3}\b|\brec-\d{2}\b", _I)
_NOT_ADDRESSED = tuple(
    re.compile(p, _I)
    for p in (
        r"^\s*(?:q|question|investigator|officer|coach|assistant|ask|suggested(?: follow-?up)?)\s*[:\-]",
        r"\bask (?:him|her|them|the subject)\b",
        r"\bthe subject (?:should|must|needs to)\b",
        r"\byou (?:should|could|might|may want to) ask\b",
    )
)
_COMPOUND = re.compile(
    r"\b(?:what|when|where|who|whom|whose|why|how|which|did|do|does|was|were|is|are|can|could|would|will|have|has|had)\b"
    r"[^?]*\b(?:and|or)\s+(?:what|when|where|who|whom|whose|why|how|which|did you|do you|does|was|were|is|are|can you"
    r"|could you|would you|will you|have you|has|had)\b",
    _I,
)
_LEADING_TAG = re.compile(
    r",\s*(?:isn't|wasn't|aren't|weren't|didn't|don't|doesn't|won't|wouldn't|haven't|hasn't|right|correct|yes|no)\b"
    r"[^?]*\?$",
    _I,
)

# neutrality_lexicon.v1 (S2 8.2 R8), group -> phrases, in S2's order.
NEUTRALITY_LEXICON: dict[str, tuple[str, ...]] = {
    "accusation": (
        "admit it",
        "admit that",
        "just admit",
        "confess",
        "confession",
        "come clean",
        "own up",
        "lie to",
        "lied",
        "lying",
        "liar",
        "dishonest",
        "deceive",
        "deceiving",
        "deceptive",
        "cover up",
        "covering up",
        "cover-up",
        "hiding something",
        "you're hiding",
        "you are hiding",
        "what are you hiding",
        "guilty",
        "steal",
        "stole",
        "we know you",
        "we already know",
        "everyone knows",
        "the truth is",
        "tell the truth",
        "be honest",
        "stop lying",
        "nobody believes",
        "don't believe you",
    ),
    "leading": (
        "isn't it true",
        "isn't that true",
        "wouldn't you agree",
        "don't you think",
        "you must have",
        "you must've",
        "surely",
        "obviously",
        "clearly you",
        "of course you",
        "you'd agree",
    ),
    "demeanor": (
        "nervous",
        "nervously",
        "sweating",
        "fidget",
        "fidgeting",
        "eye contact",
        "look me in the eye",
        "your tone",
        "your accent",
        "your voice",
        "calm down",
        "you seem",
        "you look",
        "body language",
        "stammer",
        "stammering",
        "stutter",
        "stuttering",
        "shaking",
        "hesitating",
        "hesitant",
        "defensive",
    ),
    "pressure": (
        "or else",
        "you'd better",
        "you had better",
        "consequences",
        "get fired",
        "be fired",
        "lose your job",
        "jail",
        "prison",
        "arrest",
        "press charges",
        "criminal charges",
        "prosecute",
        "prosecution",
        "make this easier",
        "go easier",
        "help yourself",
        "if you cooperate",
        "last chance",
        "this is your chance",
        "we can protect you",
        "off the record",
    ),
}
# Whole words or phrases (R8): a term may not continue or be continued by a word character. An apostrophe
# or quotation mark next to the term is a boundary, so 'lying', the same in U+2018/U+2019 (folded to ') and jail's all
# match; no lexicon term is a contraction tail (s, t, d, ll, re, ve, m), so "didn't" matches nothing.
_LEXICON = {
    group: re.compile(r"(?<!\w)(?:" + "|".join(re.escape(p) for p in phrases) + r")(?!\w)", _I)
    for group, phrases in NEUTRALITY_LEXICON.items()
}

# replay_script.v1 (S2 8.6): rows 1-12; {opening} is the public packet's opening_question and {t0}-{t2}
# its three replay_topics.
REPLAY_SCRIPT: tuple[str, ...] = (
    "{opening}",
    "What happened next?",
    "Can you go through that period again, starting from the end and working backwards?",
    "Can you tell me about {t0}?",
    "What was the purpose of {t0}?",
    "Who else was present, or could confirm what you have described?",
    "Can you tell me about {t1}?",
    "Which records or documents would show what you have described?",
    "Can you tell me about {t2}?",
    "Is there anything about {t0} you have not mentioned yet?",
    "Earlier you described {t0}. Is there anything you would like to add or correct?",
    "Is there anything else you think we should know?",
)
REPLAY_TOPIC_COUNT = 3


@dataclass(frozen=True, slots=True)
class RelayResult:
    """Outcome of one relay test: `question` is the normalized text the harness would relay."""

    question: str
    reason: str | None

    @property
    def passed(self) -> bool:
        return self.reason is None


def normalize(raw: str) -> str:
    """S2 8.2 step 1: sanitize, collapse whitespace, strip one pair of surrounding quotes."""
    text = re.sub(r"\s+", " ", sanitize_untrusted_text(raw)).strip()
    for opening, closing in _QUOTE_PAIRS:
        if len(text) >= len(opening) + len(closing) and text.startswith(opening) and text.endswith(closing):
            return text[len(opening) : len(text) - len(closing)].strip()
    return text


def repeat_key(question: str) -> str:
    """R9 comparison key: normalized, lowercased, punctuation removed, whitespace collapsed."""
    return " ".join(re.sub(r"[^\w\s]", "", normalize(question).lower()).split())


@dataclass(frozen=True, slots=True)
class _Question:
    raw: str
    text: str  # normalized
    folded: str  # normalized, typographic apostrophes folded
    asked: tuple[str, ...]


def _r1_length(q: _Question) -> str | None:
    words = len(q.text.split())
    if words < MIN_WORDS:
        return "too_short"
    return "too_long" if words > MAX_WORDS else None


def _r2_one_question(q: _Question) -> str | None:
    return None if q.text.endswith("?") and q.text.count("?") == 1 else "not_single_question"


def _r3_plain_text(q: _Question) -> str | None:
    return "markup" if any(nl in q.raw for nl in _NEWLINES) or _MARKUP.search(q.text) else None


def _r4_no_identifiers(q: _Question) -> str | None:
    return "identifier" if _IDENTIFIER.search(q.text) else None


def _r5_addressed_to_subject(q: _Question) -> str | None:
    return "not_addressed_to_subject" if any(rule.search(q.folded) for rule in _NOT_ADDRESSED) else None


def _r6_not_compound(q: _Question) -> str | None:
    return "compound" if _COMPOUND.search(q.folded) else None


def _r7_no_tag_question(q: _Question) -> str | None:
    return "leading_tag" if _LEADING_TAG.search(q.folded) else None


def _r8_neutral(q: _Question) -> str | None:
    return next((f"non_neutral:{group}" for group, rule in _LEXICON.items() if rule.search(q.folded)), None)


def _r9_not_a_repeat(q: _Question) -> str | None:
    return "repeat" if repeat_key(q.text) in {repeat_key(a) for a in q.asked} else None


# S2 8.2 steps R1-R9, in order; the first failure is the reason.
RULES = (
    _r1_length,
    _r2_one_question,
    _r3_plain_text,
    _r4_no_identifiers,
    _r5_addressed_to_subject,
    _r6_not_compound,
    _r7_no_tag_question,
    _r8_neutral,
    _r9_not_a_repeat,
)


def relay_test(raw: str, asked: Iterable[str] = ()) -> RelayResult:
    """Run `relay_test.v1` on one question; `asked` holds the questions already asked in the trial."""
    text = normalize(raw)
    question = _Question(raw, text, text.translate(_APOSTROPHES), tuple(asked))
    reason = next((r for r in (rule(question) for rule in RULES) if r is not None), None)
    return RelayResult(text, reason)


def render_replay_script(opening_question: str, replay_topics: Sequence[str]) -> list[str]:
    """The 12 script questions with no releases (S2 8.6); exactly three topics."""
    if len(replay_topics) != REPLAY_TOPIC_COUNT:
        msg = f"replay_script.v1 needs exactly {REPLAY_TOPIC_COUNT} replay topics, got {len(replay_topics)}"
        raise ValueError(msg)
    t0, t1, t2 = replay_topics
    return [row.format(opening=opening_question, t0=t0, t1=t1, t2=t2) for row in REPLAY_SCRIPT]


def evidence_slot_question(title: str, date: str | None = None) -> str:
    """The S2 8.6 evidence-slot question for a released record (dated form when the record lists a date)."""
    if date:
        return f"We have {title}, dated {date}. Can you tell me about it?"
    return f"We have {title}. Can you tell me about it?"
