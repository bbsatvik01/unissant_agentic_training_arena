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
# A plain statement that the subject does not know or has not seen something (no other content).
IGNORANCE = re.compile(
    r"I (?:(?:do not|don't) know (?:anything )?about|have not seen) (?:that|the|this) (?P<thing>[\w\s-]+)\."
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


def sentences(answer: str) -> list[str]:
    return [s for s in SENTENCE_END.split(answer) if s]


def knowledge_problems(sentence: str, known: Iterable[str]) -> list[str]:
    """The subject can say this: every number and every content word (simple inflections allowed) is in `known` (the
    cited ledger entries and the questions so far), and its polarity is the ledger's."""
    known_text = " ".join(known)
    lowered = known_text.lower()
    words = {w.lower() for w in WORD.findall(known_text)}
    stems = {stem(w) for w in words}
    problems = [f"{n} is not known to the subject" for n in numbers(sentence) if n.lower() not in lowered]
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


def _time_problems(sentence: str, rows: list[tuple[str, set[str]]]) -> list[str]:
    """A time sits with what it describes: a word of the clause holding a time may not come only from a row that
    holds another time of the same sentence (so swapping two times fails), and a "from ... until" span runs forward."""
    out = [f"the span from {a} to {b} runs backwards" for a, b in SPAN.findall(sentence) if a > b]
    for clause in clauses(sentence):
        words = {stem(w) for w in WORD.findall(clause) if content(w)}
        for time in TIME.findall(clause):
            own = set().union(*(s for row, s in rows if time in row))
            others = [t for t in TIME.findall(sentence) if t != time]
            other = set().union(*(s for row, s in rows if time not in row and any(t in row for t in others)))
            out.extend(f"{w} goes with another time than {time}" for w in sorted(words & other - own))
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
    problems += [f"{n} disagrees with the quote" for n in numbers(sentence) if n.lower() not in joined.lower()]
    if bool(NEGATORS.search(sentence)) != bool(NEGATORS.search(joined)):
        problems.append("polarity differs from the quote")
    if OBLIGATION.search(joined) and not REPORTED_OBLIGATION.search(sentence):
        problems.append("a duty in the quote is stated as an event")
    problems += _time_problems(sentence, rows_of(quotes))
    return problems


def contradiction_problems(sentence: str, all_records: Iterable[str]) -> list[str]:
    """Against every record of the variant, released or not: the times the sentence states sit with what the records
    say happened at them."""
    return [f"contradicts a record: {p}" for p in _time_problems(sentence, rows_of(all_records))]


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
            ignorance = (
                IGNORANCE.fullmatch(sentence) if support["kind"] == "perception" and not support["ledger"] else None
            )
            if ignorance:
                # S2 6.3: "If something is not in the ledger, you do not know it: say you do not know." Saying so about
                # a thing the questions name is backed by the ledger's silence; the thing's words must come from the
                # questions (the frame "I have not seen" carries no fact, so it has no polarity to compare).
                found += [p for p in knowledge_problems(ignorance["thing"], asked) if "polarity" not in p]
            elif not support["ledger"] or not set(support["ledger"]) <= set(ledger):
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
