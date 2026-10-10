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
import unicodedata
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
SEGMENT = re.compile(r"[,;]|\band\b|\bthen\b")  # where one predicate of a sentence ends and the next begins
SPAN = re.compile(r"\bfrom (\d{2}:\d{2})\b.{0,40}?\b(?:until|to|till)\b.{0,20}?(\d{2}:\d{2})\b")
_UNITS = [
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
]
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
THOUSAND = 1000
_SCALES = {"hundred": 100, "thousand": THOUSAND, "million": 10**6, "billion": 10**9, "trillion": 10**12}
_DOZEN = {"dozen": 12}
_UNIT = {w: n for n, w in enumerate(_UNITS)}
_ONCE = {"once": 1, "twice": 2}
_NUMBER_WORD = "(?:" + "|".join([*_UNITS, *_TENS, *_SCALES, *_ONCE, *_DOZEN]) + ")"
# A spelled-out cardinal: "seventy", "twenty-one", "two hundred and five", "thirty million", "a dozen". "and" joins
# only after a scale word ("hundred and five"); elsewhere it separates two numbers ("ten and twenty" is 10 and 20).
_AFTER_SCALE = "(?:" + "|".join(f"(?<={w})" for w in _SCALES) + ")"
CARDINAL = re.compile(rf"\b(?:a )?{_NUMBER_WORD}(?:(?:[ -]|{_AFTER_SCALE} and ){_NUMBER_WORD})*\b", re.IGNORECASE)
APOSTROPHES = str.maketrans(
    {"\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u2032": "'", "\u2212": "-"}
    | {chr(c): "-" for c in range(0x2010, 0x2016)}
)


def fold(text: str) -> str:
    """Typographic apostrophes as "'" and dashes U+2010-U+2015, U+2212 as "-", so "didn\u2019t" is a negation and
    "thirty\u2011two" is 32, however they are typed; whitespace runs (tabs, U+00A0) as one space."""
    return re.sub(r"\s+", " ", text.translate(APOSTROPHES))


def cardinal_value(phrase: str) -> int | None:
    """The value of a spelled-out cardinal, or None when its words do not form one (fail closed: "twenty thirty",
    "two three"). Scales multiply what precedes them ("two thousand million" is 2,000,000,000)."""
    total, current, last = 0, 0, ""
    for word in re.split(r"[ -]+", phrase.lower().removeprefix("a ").removeprefix("an ")):
        if word == "and":
            if last not in _SCALES:
                return None
            continue
        if word in _ONCE or word in _UNIT:
            if last in _UNIT or last in _ONCE or (last in _TENS and word in _UNIT and _UNIT[word] >= len(_UNITS) // 2):
                return None  # two units in a row, or tens followed by a teen
            current += _ONCE.get(word, _UNIT.get(word, 0))
        elif word in _TENS:
            if last in _TENS or last in _UNIT:
                return None
            current += _TENS[word]
        elif word in _DOZEN:
            current = max(current, 1) * _DOZEN[word]
        elif word == "hundred":
            current = max(current, 1) * 100
        elif word in _SCALES:
            if current == 0:
                total = max(total, 1) * _SCALES[word]
            else:
                total += current * _SCALES[word]
            current = 0
        last = word
    return total + current


Problem = tuple[int, str, str]


def stem(word: str) -> str:
    w = word.lower()
    for suffix in ("ing", "ed", "es", "s", "d"):
        if w.endswith(suffix) and len(w) - len(suffix) >= MIN_CONTENT_WORD - 1:
            return w[: -len(suffix)]
    return w


# Function words of four or more letters, and the words "time" and "times"; they never say what happened at a time.
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
        "time",
        "times",
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


_ORDINAL_ROOTS = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
    "twentieth",
    "thirtieth",
    "fortieth",
    "fiftieth",
    "sixtieth",
    "seventieth",
    "eightieth",
    "ninetieth",
    "hundredth",
    "thousandth",
    "millionth",
    "billionth",
    "trillionth",
]
_ORDINAL = r"(?:" + "|".join(_ORDINAL_ROOTS) + r"|\d+(?:st|nd|rd|th))s?"
_FRACTION = r"(?:half|halves|quarters?|percent|per cent|percentage)"
# Only plain whole numbers are normalised. Every other numeric construction is rejected outright, so none can pass as
# the whole number beside it (fail closed): fractions and proportions ("half the thirty", "two thirds", "a twelfth",
# "thirty and a thousandth", "10 percent", decimals 1.5, .30, 30,5 and "thirty point five", Unicode fractions such
# as 30\u00bd), signed quantities ("-30",
# "- 30", "negative thirty", "minus 3"), and arithmetic or ranges between numbers ("30 / 2", "30 x 30", "30+30",
# "thirty times thirty", "9 - 10", "ten-twenty"; a hyphen joins only tens and units, "twenty-one"). A token with an
# inner hyphen such as "2-07" or "9-10" is a code and is compared whole. Ordinals are rejected only as denominators
# ("a fifth", "two thirds"), so "First, ..." is left alone; "half past", "quarter past", "quarter to" are clock phrases.
_OPERAND = rf"(?:\b\d+|\b{_NUMBER_WORD}\b)"
_TENS_WORD = "(?:" + "|".join(_TENS) + ")"
_OPERATOR = (
    r"(?:[/*x+^\u00f7\u00d7]|(?:\s-\s*|\s*-\s)(?=\d)"
    r"|\b(?:times|plus|minus|over|by|divided by|multiplied by)\b)"
)
UNSUPPORTED_NUMBER = re.compile(
    rf"\b(?!(?:half|quarter) (?:past|to)\b){_FRACTION}\b"
    rf"|\b(?:an?|{_NUMBER_WORD}|\d+) {_ORDINAL}\b|\band an? {_ORDINAL}\b"
    rf"|%|{_OPERAND}\s*{_OPERATOR}\s*{_OPERAND}"
    rf"|\b(?!{_TENS_WORD}-(?:one|two|three|four|five|six|seven|eight|nine)\b){_NUMBER_WORD}-{_NUMBER_WORD}\b"
    rf"|\b\d+[.,]\d+\b|(?<![\w.])\.\d|{_OPERAND} (?:point|dot) {_OPERAND}"
    rf"|(?<![\w-])[-+]\s*(?:\d|{_NUMBER_WORD}\b)|\b(?:negative|minus|plus)\b",
    re.IGNORECASE,
)


_TRAILING = ".,;:!?\"')("
_CODE_CHARS = re.compile(r"[A-Za-z0-9]+(?:[:'-][A-Za-z0-9]+)*")  # single separators only: MS-6A, 07:12:40, 2-07


def _odd_numeric_chunk(chunk: str) -> bool:
    """A chunk with a digit and any character a plain number, time or code never holds (1_000, 30\u2030, 3#4)."""
    core = chunk.strip(_TRAILING)
    return any(c.isdigit() for c in core) and not _CODE_CHARS.fullmatch(core)


def unsupported_numbers(text: str) -> list[str]:
    folded = fold(text)
    found = [m.group(0) for m in UNSUPPORTED_NUMBER.finditer(folded)]
    found += [c for c in folded.split(" ") if _odd_numeric_chunk(c) and not UNSUPPORTED_NUMBER.search(c)]
    found += [m.group(0) for m in CARDINAL.finditer(folded) if cardinal_value(m.group(0)) is None]
    # Any numeric character that is not an ASCII digit (vulgar fractions, superscripts, other scripts' digits).
    return found + [c for c in folded if not c.isascii() and unicodedata.numeric(c, None) is not None]


_NUMERIC_TOKEN = re.compile(
    rf"^\W*(?:\d[\d.,:/%+-]*|[.,:/%+*x^-]+|{_NUMBER_WORD}|{_FRACTION}|{_ORDINAL}|and|a|an|of|point|dot|over|by"
    rf"|times|plus|minus|negative|percent|dozen|divided|multiplied)\W*$",
    re.IGNORECASE,
)


def _numeral_chunk(chunk: str) -> bool:
    return any(not c.isascii() and unicodedata.numeric(c, None) is not None for c in chunk)


def _without_unsupported(text: str) -> str:
    """Drop every unsupported construction whole, on either side of a comparison, so none of its parts can stand for a
    whole number ("2" is not in ".12", "30" is not in "30%" or "thirty point five", "12" is not in "half a dozen"):
    each whitespace chunk that overlaps an unsupported match, holds a non-ASCII numeral or an odd character beside a
    digit, is removed together with the neighbouring chunks that are numbers, number words or connectors, never across
    a clause or sentence end (a comma, semicolon, colon or full stop)."""
    chunks = [(m.start(), m.end(), m.group(0)) for m in re.finditer(r"\S+", text)]
    spans = [(m.start(), m.end()) for m in UNSUPPORTED_NUMBER.finditer(text)]
    spans += [(m.start(), m.end()) for m in CARDINAL.finditer(text) if cardinal_value(m.group(0)) is None]
    marked = [
        any(a < e and s < b for s, e in spans) or _numeral_chunk(chunk) or _odd_numeric_chunk(chunk)
        for a, b, chunk in chunks
    ]
    ends = [chunk[-1] in ".,;:!?" for _a, _b, chunk in chunks]  # a clause or sentence ends after this chunk
    changed = True
    while changed:
        changed = False
        for n, (_a, _b, chunk) in enumerate(chunks):
            if marked[n] or not _NUMERIC_TOKEN.match(chunk):
                continue
            from_left = n > 0 and marked[n - 1] and not ends[n - 1]
            from_right = n + 1 < len(chunks) and marked[n + 1] and not ends[n]
            if from_left or from_right:
                marked[n] = changed = True
    return " ".join("\u2063" if marked[n] else chunk for n, (_a, _b, chunk) in enumerate(chunks))


def numbers(text: str) -> list[str]:
    """Numbers, times and codes, with spelled-out cardinals as digits ("seventy" 70, "twenty-one" 21). Fail closed:
    every number phrase is compared, spoken clock times included ("ten to five" carries 10 and 5), so a sentence that
    gives a time in words cites no quote that gives it in digits (the review judges that agreement)."""
    text = _without_unsupported(fold(text))
    # A number, time or code is a whole chunk (trailing punctuation aside), never a fragment of one.
    out = [c.strip(_TRAILING) for c in text.split(" ") if any(ch.isdigit() for ch in c)]
    values = [cardinal_value(m.group(0)) for m in CARDINAL.finditer(text)]
    return out + [str(v) for v in values if v is not None]


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
    if not cited and not (kind == "perception" and IGNORANCE.fullmatch(fold(sentence))):
        return ["cites no ledger entry of the subject"]
    return []


def number_problems(sentence: str, known: Iterable[str], quotes: list[str]) -> list[str]:
    known_text = " ".join(known)
    problems = [f"unsupported number phrase: {u!r}" for u in unsupported_numbers(sentence)]
    problems += [
        f"{n} is not in the cited ledger or the questions" for n in numbers(sentence) if not number_in(n, known_text)
    ]
    if quotes:
        joined = " ".join(quotes)
        problems += [f"{n} disagrees with the quote" for n in numbers(sentence) if not number_in(n, joined)]
    return problems


def polarity_problems(sentence: str, quotes: list[str]) -> list[str]:
    negated = bool(NEGATORS.search(fold(sentence)))
    return [f"polarity differs from the quote: {q[:60]!r}" for q in quotes if bool(NEGATORS.search(fold(q))) != negated]


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


def binding(word: str) -> bool:
    """A word that ties a time to its row: a content word, or an identifier or number that is not itself a time
    (badge 70315, MS-6A)."""
    return content(word) or (any(c.isdigit() for c in word) and not TIME.fullmatch(word))


def rows_of(texts: Iterable[str]) -> list[tuple[str, set[str]]]:
    """Record rows: split at the record's own line breaks first (tables whose rows start with a date too), then at a
    time that starts a row inside a quote that runs across rows; whitespace is folded within each row."""
    rows = [fold(row) for text in texts for line in text.split("\n") for row in ROW_START.split(line)]
    return [(row, {stem(w) for w in WORD.findall(row)}) for row in rows]


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
    """A time sits with what it describes. Each binding word (content words and identifiers such as badge numbers)
    belongs to the nearest time in its own segment (a stretch between commas, "and" or "then"); a segment without a
    time belongs to the nearest segment that has one, so a coordinated predicate ("at 19:12 the door opened and
    closed") still belongs to that time; a time
    listed with no word of its own ("opened at 19:12 and 19:38") shares all the sentence's words. Those words may not
    come only from rows of the same record that hold other times and never from a row that holds this one: "the door
    opened at 19:38", when the record says opened at 19:12 and closed at 19:38, fails, and so does "badge 70315 at
    08:12" when 08:12 is badge 70288's row. A "from ... until" span runs forward. A record is judged for a time when its
    row at that time shares a binding word with the sentence or the record names one of the time's identifiers
    anywhere (otherwise its row at that time is about something else); a time no row holds is not judged here."""
    sentence = fold(sentence)
    out = [f"the span from {a} to {b} runs backwards" for a, b in SPAN.findall(sentence) if a > b]
    segments = [WORD.findall(piece) for piece in SEGMENT.split(sentence)]
    tokens = [w for seg in segments for w in seg]
    seg_of = [n for n, seg in enumerate(segments) for _ in seg]
    sentence_words = {stem(w) for w in tokens if binding(w) and w.lower() not in CALENDAR}
    times = [k for k, w in enumerate(tokens) if TIME.fullmatch(w)]

    def owner(k: int) -> int:
        """The time a word belongs to: the nearest time in its own segment; for a segment without one, the nearest
        segment that has one (the earlier on a tie: "at 19:12 the door opened and closed")."""
        same = [t for t in times if seg_of[t] == seg_of[k]]
        if same:
            return min(same, key=lambda t: (abs(t - k), -t))
        return min(times, key=lambda t: (abs(seg_of[t] - seg_of[k]), seg_of[t] > seg_of[k], abs(t - k)))

    for i in times:
        time = tokens[i]
        mine = [w for k, w in enumerate(tokens) if binding(w) and owner(k) == i]
        if not mine:
            mine = [w for w in tokens if binding(w)]
        near = {stem(w) for w in mine if w.lower() not in CALENDAR}
        idents = {stem(w) for w in mine if not content(w)}
        for rows in tables:
            holding = [s for row, s in rows if number_in(time, row)]
            if not holding:
                continue
            own = set().union(*holding)
            mentioned = set().union(*(s for _row, s in rows))
            if not sentence_words & own and not idents & mentioned:
                continue  # the record neither shares the row's words nor names the time's identifiers
            other = set().union(*(s for row, s in rows if TIME.search(row) and not number_in(time, row)))
            out.extend(f"{w} goes with another time than {time}" for w in sorted(near & other - own))
    return out


def time_row_problems(sentence: str, quotes: list[str], all_records: Iterable[str]) -> list[str]:
    """Times against the cited quotes and against every record of the variant, released or not. A segment that holds
    two times ("granted to badge 70315 at 08:12 before the 08:41 meeting") cannot be bound reliably, so it is
    rejected rather than guessed (fail closed): split the sentence."""
    ambiguous = [
        f"two times in one segment: {' '.join(TIME.findall(piece))}"
        for piece in SEGMENT.split(fold(sentence))
        if len(TIME.findall(SPAN.sub(" ", piece))) + len(SPAN.findall(piece)) > 1  # a span counts as one time
    ]
    tables = [rows_of(quotes)] + [rows_of([r]) for r in all_records]
    return list(dict.fromkeys(ambiguous + _time_problems(sentence, tables)))


def perception_problems(sentence: str, kind: str, records: list[Any]) -> list[str]:
    sentence = fold(sentence)
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
