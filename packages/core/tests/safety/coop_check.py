"""FX-COOP (S2 11.1): the checks a program can decide reliably, and nothing more.

S2 11.1: every claim is known to the subject (its ledger); no claim is contradicted by any record of the variant; a
claim that states a fact a released record also states agrees with it in content and polarity; claims about the
subject's own perception or memory need ledger support only. Each sentence of an answer carries
`{"kind": "fact" | "perception", "ledger": [ids], "records": [{"record_id", "quote"}]}`; `records` lists released
records that state the same fact (none for a perception claim, none when no record states it).

Enforcement is split exactly as S2 11.1 says.

Mechanical, decided here (each check is independent and decides only what it states):
- `ledger_problems`: every cited ID exists in the variant's ledger, and the sentence cites at least one, except a
  plain statement of ignorance ("I have not seen that camera review."), which S2 6.3 tells the subject to make about
  anything its ledger does not hold.
- `quote_problems`: every cited quote is verbatim in its record (`quote_ok`), at least three words, the record is
  released in the interview, at most two per sentence, and no quote is only a table's column line.
- `number_problems`: numbers, times and codes compare as whole tokens ("41" is not "417"; a time to the minute matches
  the same time to the second), spelled-out quantities normalised to digits ("ten times" carries 10). Every number of
  the sentence is in its cited ledger entries or the questions so far, and, when quotes are cited, in the quotes.
- `polarity_problems`: each cited quote, on its own, has the sentence's polarity (a negator in both or neither).
- `time_row_problems`: no time is attached to the wrong record row: the words nearest a time may not come only from
  rows of the same record that hold other times (cited quotes and every record of the variant), and a
  "from ... until" span runs forward.
- `perception_problems`: a perception or memory claim is phrased as one and cites no record; a fact is not phrased as
  a perception.

Semantic, decided by the recorded independent review (transcript_review.json, one fresh read-only session per
transcript, bound to the text and case hashes; a test fails if any pair lacks a current passing review): whether the
cited ledger entries state the claim (and the question text did not supply it), whether every cited quote states the
same fact, whether a statement of ignorance is about something the ledger really does not hold, and whether any
record of the variant, cited or not, contradicts a claim. Word matching cannot decide these,
so no check here claims to.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from arena_core.contracts.citations import quote_ok

SENTENCE_END = re.compile(r"(?<=[.?!])(?: |$)")
WORD = re.compile(r"[A-Za-z0-9]+(?:[:'.\-][A-Za-z0-9]+)*")
NEGATORS = re.compile(r"\b(?:not|no|never|none|nothing|nobody|without)\b|n't\b", re.IGNORECASE)
MIN_CONTENT_WORD = 4
MIN_QUOTE_WORDS = 3
MAX_QUOTES = 2
PERCEPTION = re.compile(
    r"\bI\s+(?:did not|didn't|do not|don't|have not|haven't|had not|hadn't|never|cannot|can't|could not|couldn't)"
    r"\s+(?:\w+\s+)?(?:see|saw|seen|know|knew|remember|recall|notice|noticed|hear|heard|look|looked)\b",
    re.IGNORECASE,
)
TIME = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?")
ROW_START = re.compile(r"\n|(?<=[^|\s]) (?=\d{1,2}:\d{2}(?::\d{2})? \| )")  # a table row starts with its time
SPAN = re.compile(r"\bfrom (\d{2}:\d{2})\b.{0,40}?\b(?:until|to|till)\b.{0,20}?(\d{2}:\d{2})\b")
CLAUSE = re.compile(r"[,;]|\band\b|\bthen\b")
NUMBER_WORDS = {
    w: str(i)
    for i, w in enumerate(
        [
            "zero",
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
            "twenty",
        ]
    )
} | {"thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "hundred": "100", "once": "1", "twice": "2"}

Problem = tuple[int, str, str]


def stem(word: str) -> str:
    w = word.lower()
    for suffix in ("ing", "ed", "es", "s", "d"):
        if w.endswith(suffix) and len(w) - len(suffix) >= MIN_CONTENT_WORD - 1:
            return w[: -len(suffix)]
    return w


# Function words of four or more letters; they never say what happened at a time.
FUNCTION_WORDS = frozenset(
    [
        "about",
        "after",
        "also",
        "been",
        "before",
        "could",
        "does",
        "from",
        "have",
        "into",
        "just",
        "only",
        "that",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "will",
        "with",
        "would",
        "your",
    ]
)


def content(word: str) -> bool:
    """A word that can say what happened: four or more letters, no digit, not a function word."""
    return len(word) >= MIN_CONTENT_WORD and not any(c.isdigit() for c in word) and word.lower() not in FUNCTION_WORDS


_NUMBER_WORD = "(?:" + "|".join(NUMBER_WORDS) + ")"
# Spoken clock times ("half past twelve", "ten to five", "after eight", "nine o'clock") are times, not quantities; they
# are approximate by nature, so code does not compare them (the review does).
_LEAD = r"(?:(?:after|before|around|about|until|till|from|at|by|since) )"
SPOKEN_TIME = re.compile(
    rf"\b{_LEAD}?(?:(?:half|quarter|{_NUMBER_WORD}) (?:past|to) {_NUMBER_WORD}|{_NUMBER_WORD} o'clock)\b"
    rf"|\b{_LEAD}{_NUMBER_WORD}\b",
    re.IGNORECASE,
)


def numbers(text: str) -> list[str]:
    """Numbers, times and codes, with spelled-out quantities as digits; spoken clock times are left out."""
    out = []
    for w in WORD.findall(SPOKEN_TIME.sub(" ", text)):
        if any(c.isdigit() for c in w):
            out.append(w)
        elif w.lower() in NUMBER_WORDS:
            out.append(NUMBER_WORDS[w.lower()])
    return out


def number_in(token: str, text: str) -> bool:
    """A number matches a whole token of `text`, never part of one; a time to the minute matches the same time to the
    second ("19:12" matches "19:12:40")."""
    token = token.lower()
    for other in (w.lower() for w in numbers(text)):
        if other == token or (TIME.fullmatch(token) and TIME.fullmatch(other) and other.startswith(f"{token}:")):
            return True
    return False


def sentences(answer: str) -> list[str]:
    return [s for s in SENTENCE_END.split(answer) if s]


# "I have not seen that camera review." / "I do not know anything about the copier log." The subject's instruction
# (S2 6.3) says: if something is not in the ledger, you do not know it; say so. Such a sentence may cite no ledger
# entry; whether the ledger really is silent on the thing (a false denial of something the ledger knows is not) is a
# semantic question the review decides (ledger_states_claims).
IGNORANCE = re.compile(
    r"I (?:have not seen|haven't seen|do not know (?:anything )?about|don't know (?:anything )?about) "
    r"(?:that|the|this|any) [\w\s-]+\."
)


def ledger_problems(cited: list[str], ledger: dict[str, str], sentence: str = "", kind: str = "fact") -> list[str]:
    """Every cited ID exists; a sentence cites at least one, except a plain statement of ignorance (IGNORANCE)."""
    if not set(cited) <= set(ledger):
        return ["cites an unknown ledger entry"]
    if not cited and not (kind == "perception" and IGNORANCE.fullmatch(sentence)):
        return ["cites no ledger entry of the subject"]
    return []


def number_problems(sentence: str, known: Iterable[str], quotes: list[str]) -> list[str]:
    known_text = " ".join(known)
    problems = [
        f"{n} is not in the cited ledger or the questions" for n in numbers(sentence) if not number_in(n, known_text)
    ]
    if quotes:
        joined = " ".join(quotes)
        problems += [f"{n} disagrees with the quote" for n in numbers(sentence) if not number_in(n, joined)]
    return problems


def polarity_problems(sentence: str, quotes: list[str]) -> list[str]:
    negated = bool(NEGATORS.search(sentence))
    return [f"polarity differs from the quote: {q[:60]!r}" for q in quotes if bool(NEGATORS.search(q)) != negated]


def quote_problems(
    records: list[dict[str, str]], record_texts: dict[str, str], released: set[str], column_lines: set[str]
) -> list[str]:
    problems = ["more than two quotes"] if len(records) > MAX_QUOTES else []
    for record in records:
        if record["record_id"] not in released:
            problems.append("record not released in this interview")
        elif len(record["quote"].split()) < MIN_QUOTE_WORDS or not quote_ok(
            record["quote"], record_texts[record["record_id"]]
        ):
            problems.append("quote not in the record")
        if record["quote"] in column_lines:
            problems.append("the quote is only a column line")
    return problems


def clauses(sentence: str) -> list[str]:
    """Clauses cut at commas, semicolons, "and" and "then"; a piece with no content word joins the clause before it
    ("motion at 18:20 and 19:05"), or the next one when it opens the sentence ("First, at 20:53, Fenwick radioed")."""
    out: list[str] = []
    carry = ""
    for piece in CLAUSE.split(sentence):
        if any(content(w) for w in WORD.findall(piece)):
            out.append(f"{carry} {piece}")
            carry = ""
        elif out:
            out[-1] = f"{out[-1]} {piece}"
        else:
            carry = f"{carry} {piece}"
    return [*out, carry] if carry.strip() else out


def rows_of(texts: Iterable[str]) -> list[tuple[str, set[str]]]:
    rows = [row for text in texts for row in ROW_START.split(text)]
    return [(row, {stem(w) for w in WORD.findall(row)}) for row in rows]


NEAR = 3  # content words on each side of a time that say what happened at it
# Calendar words date an event; they never say what happened, so they are not compared with table rows.
CALENDAR = frozenset(
    [
        "january",
        "february",
        "march",
        "april",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
)


def _time_problems(sentence: str, tables: list[list[tuple[str, set[str]]]]) -> list[str]:
    """A time sits with what it describes. For each time, the content words nearest it in its clause (up to three on
    each side) may not come only from rows of the same record that hold other times and never from a row that holds
    this one: "the door opened at 19:38", when the record says opened at 19:12 and closed at 19:38, fails, and so does
    swapping two times. A "from ... until" span runs forward. A time no row holds is not judged here."""
    out = [f"the span from {a} to {b} runs backwards" for a, b in SPAN.findall(sentence) if a > b]
    for clause in clauses(sentence):
        tokens = WORD.findall(clause)
        for i, time in enumerate(tokens):
            if not TIME.fullmatch(time):
                continue
            before = [w for w in tokens[:i] if content(w)][-NEAR:]
            after = [w for w in tokens[i + 1 :] if content(w)][:NEAR]
            near = {stem(w) for w in before + after if w.lower() not in CALENDAR}
            for rows in tables:
                holding = [s for row, s in rows if number_in(time, row)]
                if not holding:
                    continue
                own = set().union(*holding)
                other = set().union(*(s for row, s in rows if TIME.search(row) and not number_in(time, row)))
                out.extend(f"{w} goes with another time than {time}" for w in sorted(near & other - own))
    return out


def time_row_problems(sentence: str, quotes: list[str], all_records: Iterable[str]) -> list[str]:
    """Times against the cited quotes and against every record of the variant, released or not."""
    tables = [rows_of(quotes)] + [rows_of([r]) for r in all_records]
    return list(dict.fromkeys(_time_problems(sentence, tables)))


def perception_problems(sentence: str, kind: str, records: list[Any]) -> list[str]:
    if kind == "perception":
        problems = [] if PERCEPTION.search(sentence) else ["a perception claim is not phrased as one"]
        return problems + (["a perception claim cites a record"] if records else [])
    if kind != "fact":
        return [f"unknown claim kind {kind!r}"]
    return ["a perception or memory claim is marked as a fact"] if PERCEPTION.search(sentence) else []


def coop_problems(t: dict[str, Any], ledger: dict[str, str], record_texts: dict[str, str]) -> list[Problem]:
    """Every mechanical problem of one FX-COOP transcript: (turn, sentence, problem)."""
    columns = {lines[1] for x in record_texts.values() if len(lines := x.split("\n")) > 1 and "|" in lines[1]}
    released = set(t["exchanges"][-1]["released_before"])  # records reach the coach during the interview
    out: list[Problem] = []
    asked: list[str] = []
    for e in t["exchanges"]:
        asked.append(e["question"])
        parts = sentences(e["answer"])
        if len(parts) != len(e["support"]):
            out.append((e["turn"], "", "one support entry per sentence"))
            continue
        for sentence, support in zip(parts, e["support"], strict=True):
            records = support["records"]
            quotes = [r["quote"] for r in records]
            known = [ledger[i] for i in support["ledger"] if i in ledger] + asked
            found = ledger_problems(support["ledger"], ledger, sentence, support["kind"])
            found += quote_problems(records, record_texts, released, columns)
            found += number_problems(sentence, known, quotes)
            found += polarity_problems(sentence, quotes)
            found += time_row_problems(sentence, quotes, record_texts.values())
            found += perception_problems(sentence, support["kind"], records)
            out.extend((e["turn"], sentence, p) for p in found)
    return out
