"""The FX-COOP rule of S2 11.1 as separate, independent checks over one cooperative transcript.

S2 11.1: every claim is known to the subject (its ledger); no claim is contradicted by any record of the variant; a
claim that states a fact a released record also states agrees with it in content and polarity; claims about the
subject's own perception or memory ("I did not see", "I do not remember") need ledger support only. Each sentence of an
answer carries `{"kind": "fact" | "perception", "ledger": [ids], "records": [{"record_id", "quote"}]}`; `records`
lists the released records that state the same fact (none for a perception claim, and none when no record states it).

The checks never borrow from each other:
- `knowledge_problems`: the sentence's words, numbers and polarity come from the cited ledger entries and the
  questions so far (the subject never sees records, S2 6.7, 8.4). Record quotes are not consulted.
- `agreement_problems`: each cited record quote is about the sentence (shares its content) and agrees with it: every
  number of the sentence that the quote's subject matter carries, polarity, duties, and times on their own rows.
  Ledger text is not consulted.
- `contradiction_problems`: against every record of the variant, released or not: a time the sentence states may not
  be one that the records attach to something else.
- `perception_problems`: a perception or memory claim is phrased as one and cites no record; a fact claim is not
  phrased as a perception.
The independent review (transcript_review.json) judges the same rule semantically; these checks are its floor.
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
MIN_SHARED = 2  # content words a quote shares with its sentence, so an unrelated quote fails
MAX_QUOTES = 2
# Words a sentence may use without a source: framing about records and the conversation, never a fact.
FRAMING = frozenset(
    [
        "about",
        "after",
        "again",
        "also",
        "another",
        "asked",
        "been",
        "before",
        "both",
        "copy",
        "could",
        "document",
        "documents",
        "does",
        "each",
        "earlier",
        "entries",
        "entry",
        "file",
        "first",
        "from",
        "have",
        "here",
        "history",
        "into",
        "item",
        "items",
        "just",
        "later",
        "line",
        "lines",
        "listed",
        "lists",
        "made",
        "mine",
        "more",
        "next",
        "note",
        "notes",
        "notice",
        "only",
        "page",
        "pages",
        "part",
        "record",
        "records",
        "report",
        "said",
        "same",
        "says",
        "sheet",
        "show",
        "showed",
        "shows",
        "statement",
        "that",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "ticket",
        "time",
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
        "yours",
    ]
)
OBLIGATION = re.compile(r"\b(?:must|should|shall|please|may|required|requires|is to|are to)\b", re.IGNORECASE)
REPORTED_OBLIGATION = re.compile(
    r"\b(?:must|should|shall|please|may|required|requires|asked|told|rule|policy|procedure|instruction|request"
    r"|requested|says|said)\b",
    re.IGNORECASE,
)
PERCEPTION = re.compile(
    r"\bI\s+(?:did not|didn't|do not|don't|have not|haven't|had not|hadn't|never|cannot|can't|could not|couldn't)"
    r"\s+(?:\w+\s+)?(?:see|saw|seen|know|knew|remember|recall|notice|noticed|hear|heard|look|looked)\b",
    re.IGNORECASE,
)
TIME = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?")
ROW_START = re.compile(r"\n|(?<=[^|\s]) (?=\d{1,2}:\d{2}(?::\d{2})? \| )")  # a table row starts with its time
SPAN = re.compile(r"\bfrom (\d{2}:\d{2})\b.{0,40}?\b(?:until|to|till)\b.{0,20}?(\d{2}:\d{2})\b")
CLAUSE = re.compile(r"[,;]|\band\b|\bthen\b")

Problem = tuple[int, str, str]


def stem(word: str) -> str:
    w = word.lower()
    for suffix in ("ing", "ed", "es", "s", "d"):
        if w.endswith(suffix) and len(w) - len(suffix) >= MIN_CONTENT_WORD - 1:
            return w[: -len(suffix)]
    return w


def content(word: str) -> bool:
    return len(word) >= MIN_CONTENT_WORD and word.lower() not in FRAMING and not any(c.isdigit() for c in word)


def numbers(text: str) -> list[str]:
    return [w for w in WORD.findall(text) if any(c.isdigit() for c in w)]


def number_in(token: str, text: str) -> bool:
    """A number, time or code matches a whole token of `text`, never part of one ("41" is not in "417"); a time
    given to the minute matches the same time given to the second ("19:12" matches "19:12:40")."""
    token = token.lower()
    for other in (w.lower() for w in numbers(text)):
        if other == token or (TIME.fullmatch(token) and TIME.fullmatch(other) and other.startswith(f"{token}:")):
            return True
    return False


def sentences(answer: str) -> list[str]:
    return [s for s in SENTENCE_END.split(answer) if s]


def knowledge_problems(sentence: str, known: Iterable[str]) -> list[str]:
    """The subject can say this: every number and every content word (simple inflections allowed) is in `known` (the
    cited ledger entries and the questions so far), and its polarity is the ledger's."""
    known_text = " ".join(known)
    words = {w.lower() for w in WORD.findall(known_text)}
    stems = {stem(w) for w in words}
    problems = [f"{n} is not known to the subject" for n in numbers(sentence) if not number_in(n, known_text)]
    problems += [
        f"{w} is not known to the subject"
        for w in WORD.findall(sentence)
        if content(w) and w.lower() not in words and stem(w) not in stems
    ]
    if bool(NEGATORS.search(sentence)) != bool(NEGATORS.search(known_text)):
        problems.append("polarity differs from the ledger")
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


def agreement_problems(sentence: str, quotes: list[str], column_lines: set[str]) -> list[str]:
    """Each quote states the sentence's fact and agrees with it: it shares at least two content words with the sentence
    (an unrelated quote fails), every number of the sentence is in the quotes, the polarity is the same, a duty is
    reported as a duty, times stay on their rows, and no quote is only a table's column line."""
    joined = " ".join(quotes)
    sentence_stems = {stem(w) for w in WORD.findall(sentence) if content(w)}
    problems: list[str] = []
    for quote in quotes:
        shared = sentence_stems & {stem(w) for w in WORD.findall(quote) if content(w)}
        if len(shared) < MIN_SHARED:
            problems.append(f"the quote is not about the sentence: {quote[:60]!r}")
        if quote in column_lines:
            problems.append("the quote is only a column line")
    problems += [f"{n} disagrees with the quote" for n in numbers(sentence) if not number_in(n, joined)]
    negated = bool(NEGATORS.search(sentence))
    problems += [f"polarity differs from the quote: {q[:60]!r}" for q in quotes if bool(NEGATORS.search(q)) != negated]
    if OBLIGATION.search(joined) and not REPORTED_OBLIGATION.search(sentence):
        problems.append("a duty in the quote is stated as an event")
    problems += _time_problems(sentence, [rows_of(quotes)])
    return problems


def contradiction_problems(sentence: str, all_records: Iterable[str]) -> list[str]:
    """Against every record of the variant, released or not: the times the sentence states sit with what the records
    say happened at them."""
    return [f"contradicts a record: {p}" for p in _time_problems(sentence, [rows_of([r]) for r in all_records])]


def perception_problems(sentence: str, kind: str, records: list[Any]) -> list[str]:
    if kind == "perception":
        problems = [] if PERCEPTION.search(sentence) else ["a perception claim is not phrased as one"]
        return problems + (["a perception claim cites a record"] if records else [])
    if kind != "fact":
        return [f"unknown claim kind {kind!r}"]
    return ["a perception or memory claim is marked as a fact"] if PERCEPTION.search(sentence) else []


def coop_problems(t: dict[str, Any], ledger: dict[str, str], record_texts: dict[str, str]) -> list[Problem]:
    """Every problem of one FX-COOP transcript: (turn, sentence, problem)."""
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
            found: list[str] = []
            if not support["ledger"] or not set(support["ledger"]) <= set(ledger):
                found.append("cites no ledger entry of the subject, or an unknown one")
            else:
                found += knowledge_problems(sentence, [ledger[i] for i in support["ledger"]] + asked)
            found += perception_problems(sentence, support["kind"], records)
            if len(records) > MAX_QUOTES:
                found.append("more than two quotes")
            for record in records:
                if record["record_id"] not in released:
                    found.append("record not released in this interview")
                elif len(record["quote"].split()) < MIN_QUOTE_WORDS or not quote_ok(
                    record["quote"], record_texts[record["record_id"]]
                ):
                    found.append("quote not in the record")
            if records:
                found += agreement_problems(sentence, [r["quote"] for r in records], columns)
            found += contradiction_problems(sentence, record_texts.values())
            out.extend((e["turn"], sentence, p) for p in found)
    return out
