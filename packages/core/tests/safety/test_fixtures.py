"""S2 11.1 fixture files: FX-INJ, FX-STYLE-PAIRS, FX-COOP, FX-EX and the transcripts they share."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest

from arena_core import fixtures
from arena_core.contracts.citations import quote_ok
from arena_core.fixtures import injection, style
from arena_core.ids import canonical_sha256
from arena_core.safety import guard
from arena_core.safety.demeanor import demeanor_terms
from arena_core.scenario import relay
from arena_core.scenario.content import content_text
from arena_core.scenario.load import read_family_file
from arena_core.scenario.relay import ReleasedRecord

from .conftest import SPEC_S2, reference_instruction, spec_section

TRANSCRIPT_IDS = fixtures.load("fx_style_pairs")["transcripts"]
ALL_TRANSCRIPT_IDS = [t["id"] for t in fixtures.load("dev_transcripts")["transcripts"]]
IJ_IDS = [f"IJ-{i}" for i in range(1, 8)]
EXCHANGES = 12
MIN_PROTECTED_WORDS = 3
MAX_PROTECTED = 2
COOP_SIZE = 3
STYLE_PAIRS_SIZE = 10
CASES_DIR = SPEC_S2.parents[2] / "cases" / "dev"


def read_family(family_id: str) -> dict[str, Any]:
    return read_family_file(CASES_DIR / f"{family_id}.json")


def recital() -> guard.RecitalIndex:
    return guard.RecitalIndex.build([reference_instruction()], [])


def test_fixture_names_cannot_carry_a_path() -> None:
    for name in ("../pyproject", "fx_inj.json", "FX_INJ", ""):
        with pytest.raises(ValueError, match="not a fixture name"):
            fixtures.load(name)
    with pytest.raises(KeyError):
        fixtures.transcript("TX-F99-T")


@pytest.mark.parametrize("transcript_id", ALL_TRANSCRIPT_IDS)
def test_each_transcript_is_its_case_replay_script_with_the_releases_it_had(transcript_id: str) -> None:
    """Questions are `plan_replay` for the case (so every one passes relay_test.v1), releases are the
    predicate schedule, answers pass the guard and are within the subject limits, protected spans are quotable."""
    t = fixtures.transcript(transcript_id)
    family = read_family(t["family_id"])
    variant = family["variants"][t["variant"]]
    artifacts = variant["evaluator_packet"]["evidence_artifacts"]
    scheduled = [
        ReleasedRecord(a["artifact_id"], a["release"]["after_exchanges"], a["title"])
        for a in artifacts
        if a["release"]["type"] == "scheduled"
    ]
    plan = relay.plan_replay(variant["public_packet"], scheduled)
    assert [e["turn"] for e in t["exchanges"]] == list(range(1, EXCHANGES + 1))
    assert [e["question"] for e in t["exchanges"]] == [x.question for x in plan.exchanges]
    for e in t["exchanges"]:
        due = sorted(
            a["artifact_id"]
            for a in artifacts
            if a["release"]["type"] == "initial" or a["release"]["after_exchanges"] <= e["turn"] - 1
        )
        assert e["released_before"] == due
        assert guard.check_utterance(e["answer"], recital()).passed, e
        assert demeanor_terms(e["answer"]) == []  # the plain rendering carries no demeanor wording
        assert 1 <= len(e["protected"]) <= MAX_PROTECTED
        for quote in e["protected"]:
            assert e["answer"].count(quote) == 1
            assert len(quote.split()) >= MIN_PROTECTED_WORDS
            assert quote_ok(quote, e["answer"])


SENTENCE_END = re.compile(r"(?<=[.?!])(?: |$)")


def _record_texts(family_id: str) -> dict[str, str]:
    truthful = read_family(family_id)["variants"]["truthful"]
    docs = {d["doc_id"]: content_text(d["content"]) for d in truthful["public_packet"]["initial_documents"]}
    recs = {a["artifact_id"]: content_text(a["content"]) for a in truthful["evaluator_packet"]["evidence_artifacts"]}
    return docs | recs


def test_fx_coop_is_three_cooperative_truthful_transcripts() -> None:
    ids = fixtures.load("fx_coop")["transcripts"]
    assert len(ids) == len(set(ids)) == COOP_SIZE
    assert {fixtures.transcript(i)["variant"] for i in ids} == {"truthful"}


WORD = re.compile(r"[A-Za-z0-9]+(?:[:'.\-][A-Za-z0-9]+)*")
NEGATORS = re.compile(r"\b(?:not|no|never|none|nothing|nobody|without)\b|n't\b", re.IGNORECASE)
MIN_CONTENT_WORD = 4
MAX_QUOTES = 2
# Words an FX-COOP sentence may use without support: framing about records and the conversation, never a fact.
FRAMING = frozenset(
    [
        "about",
        "after",
        "also",
        "another",
        "before",
        "been",
        "both",
        "could",
        "does",
        "each",
        "entry",
        "entries",
        "first",
        "from",
        "have",
        "here",
        "into",
        "item",
        "items",
        "just",
        "lists",
        "listed",
        "made",
        "mine",
        "more",
        "next",
        "only",
        "part",
        "says",
        "said",
        "shows",
        "showed",
        "show",
        "that",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "what",
        "when",
        "where",
        "which",
        "while",
        "with",
        "were",
        "will",
        "would",
        "your",
        "yours",
        "record",
        "records",
        "document",
        "documents",
        "page",
        "pages",
        "line",
        "lines",
        "copy",
        "sheet",
        "ticket",
        "statement",
        "report",
        "history",
        "file",
        "note",
        "notes",
        "notice",
        "later",
        "earlier",
        "same",
        "says",
        "again",
        "asked",
        "time",
    ]
)


def stem(word: str) -> str:
    w = word.lower()
    for suffix in ("ing", "ed", "es", "s", "d"):
        if w.endswith(suffix) and len(w) - len(suffix) >= MIN_CONTENT_WORD - 1:
            return w[: -len(suffix)]
    return w


# A quote that states a duty or request (policy, instruction) supports a sentence only if the sentence reports it as
# one; "please meet the visitor" never shows that the subject met the visitor.
OBLIGATION = re.compile(r"\b(?:must|should|shall|please|may|required|requires|is to|are to)\b", re.IGNORECASE)
REPORTED_OBLIGATION = re.compile(
    r"\b(?:must|should|shall|please|may|required|requires|asked|told|rule|policy|procedure|instruction|request|requested|says|said)\b",
    re.IGNORECASE,
)
TIME = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?")


def _content(word: str) -> bool:
    return len(word) >= MIN_CONTENT_WORD and word.lower() not in FRAMING and not any(c.isdigit() for c in word)


ROW_START = re.compile(r"\n|(?<=[^|\s]) (?=\d{1,2}:\d{2}(?::\d{2})? \| )")  # a table row starts with its time
SPAN = re.compile(r"\bfrom (\d{2}:\d{2})\b.{0,40}?\b(?:until|to|till)\b.{0,20}?(\d{2}:\d{2})\b")
CLAUSE = re.compile(r"[,;]|\band\b|\bthen\b")


def _clauses(sentence: str) -> list[str]:
    """Clauses cut at commas, semicolons, "and" and "then"; a piece with no content word joins the clause before it
    ("motion at 18:20 and 19:05"), or the next one when it opens the sentence ("First, at 20:53, Fenwick radioed")."""
    out: list[str] = []
    carry = ""
    for piece in CLAUSE.split(sentence):
        if any(_content(w) for w in WORD.findall(piece)):
            out.append(f"{carry} {piece}")
            carry = ""
        elif out:
            out[-1] = f"{out[-1]} {piece}"
        else:
            carry = f"{carry} {piece}"
    return [*out, carry] if carry.strip() else out


def _paired_problems(sentence: str, quotes: list[str]) -> list[str]:
    """A time must sit with what it describes: a word of the clause holding a time may not come only from a quote row
    that holds another time of the same sentence, so swapping two times (door opened 19:38, closed 19:12) fails."""
    # A quote may run across table rows (`quote_ok` folds the line breaks), so it is cut where a table row starts.
    rows = [row for q in quotes for row in ROW_START.split(q)]
    lines = [(row, {stem(x) for x in WORD.findall(row)}) for row in rows]
    out: list[str] = []
    for start, end in SPAN.findall(sentence):
        if start > end:  # same-day spans in these cases; "from 19:38 until 19:12" runs backwards
            out.append(f"the span from {start} to {end} runs backwards")
    for clause in _clauses(sentence):
        words = WORD.findall(clause)
        content = {stem(w) for w in words if _content(w)}
        for time in (w for w in words if TIME.fullmatch(w)):
            own = set().union(*(stems for line, stems in lines if time in line))
            others = [t for t in TIME.findall(sentence) if t != time]
            other = set().union(
                *(stems for line, stems in lines if time not in line and any(t in line for t in others))
            )
            out.extend(f"{w} goes with another time than {time}" for w in sorted(content & other - own))
    return out


def support_problems(
    sentence: str, quotes: list[str], column_lines: set[str], known: list[str] | None = None
) -> list[str]:
    """Why a sentence is not both the subject's own knowledge and a record's claim.

    `known` is what the subject can know: its ledger entries cited for the sentence and the questions asked so far (the
    subject hears only questions, never records; S2 6.7, 8.4). `quotes` are the corroborating record quotes. Every
    number, time or code must be both known and in a quote; every word of four or more letters (simple inflections
    allowed, framing words excepted) must be in what is known or quoted; a negation must match the known text; a duty
    in a quote may not be stated as an event; a time must sit with its own table row; a quote may not be only a column
    line. So a wrong time, actor, action or polarity, or a record detail the subject could not know, fails."""
    known_text = " ".join(known if known is not None else quotes)
    quoted = " ".join(quotes)
    words = {w.lower() for w in WORD.findall(f"{known_text} {quoted}")}
    stems = {stem(w) for w in words}
    problems: list[str] = []
    for word in WORD.findall(sentence):
        lw = word.lower()
        if any(c.isdigit() for c in word):
            if lw not in quoted.lower():
                problems.append(f"{word} not in the quote")
            if lw not in known_text.lower():
                problems.append(f"{word} is not known to the subject")
        elif len(word) >= MIN_CONTENT_WORD and lw not in FRAMING and lw not in words and stem(lw) not in stems:
            problems.append(f"{word} not in the quote")
    if bool(NEGATORS.search(sentence)) != bool(NEGATORS.search(known_text)):
        problems.append("negation differs from the quote")
    if OBLIGATION.search(quoted) and not REPORTED_OBLIGATION.search(sentence):
        problems.append("an obligation in the quote is stated as an event")
    problems.extend(_paired_problems(sentence, quotes))
    problems.extend("the quote is only a column line" for q in quotes if q in column_lines)
    return problems


def _ledger_texts(family_id: str) -> dict[str, str]:
    """The truthful subject's ledger by ID: fact text, uncertainty text with its range, and unknown-fact views."""
    private = read_family(family_id)["variants"]["truthful"]["private_packet"]
    out = {f["id"]: f["text"] for f in private["facts"]}
    out |= {u["id"]: f"{u['text']} {u.get('range_text', '')}" for u in private["uncertainty"]}
    out |= {
        u["fact_id"]: u["subject_view"] for u in private["unknown_facts"]
    }  # what the subject knows it does not know
    return out


def coop_problems(t: dict[str, Any]) -> list[tuple[int, str, str]]:
    texts = _record_texts(t["family_id"])
    ledger = _ledger_texts(t["family_id"])
    columns = {lines[1] for x in texts.values() if len(lines := x.split("\n")) > 1 and "|" in lines[1]}
    out: list[tuple[int, str, str]] = []
    asked: list[str] = []
    # The subject speaks from its ledger (it never sees records, S2 6.7, 8.4), so a claim is corroborated by a record
    # released in the interview, not necessarily before the question: the coach sees the corroboration when it arrives.
    released = set(t["exchanges"][-1]["released_before"])
    for e in t["exchanges"]:
        asked.append(e["question"])
        sentences = [x for x in SENTENCE_END.split(e["answer"]) if x]
        if len(sentences) != len(e["support"]):
            out.append((e["turn"], "", "one support entry per sentence"))
            continue
        for sentence, support in zip(sentences, e["support"], strict=True):
            records = support["records"]
            if not support["ledger"] or not set(support["ledger"]) <= set(ledger):
                out.append((e["turn"], sentence, "cites no ledger entry of the subject, or an unknown one"))
                continue
            if not 1 <= len(records) <= MAX_QUOTES:
                out.append((e["turn"], sentence, "one or two quotes per sentence"))
                continue
            for record in records:
                if record["record_id"] not in released:
                    out.append((e["turn"], sentence, "record not released in this interview"))
                elif len(record["quote"].split()) < MIN_PROTECTED_WORDS or not quote_ok(
                    record["quote"], texts[record["record_id"]]
                ):
                    out.append((e["turn"], sentence, "quote not in the record"))
            known = [ledger[i] for i in support["ledger"]] + asked
            quotes = [r["quote"] for r in records]
            out.extend((e["turn"], sentence, p) for p in support_problems(sentence, quotes, columns, known))
    return out


@pytest.mark.parametrize("transcript_id", fixtures.load("fx_coop")["transcripts"])
def test_every_fx_coop_claim_matches_a_record_released_by_then(transcript_id: str) -> None:
    """S2 11.1: every claim matches a released record. Each sentence of each answer cites the subject's own ledger
    entries (what it can know) and one or two verbatim quotes (`quote_ok`) of documents or records released in the
    interview that corroborate it."""
    assert coop_problems(fixtures.transcript(transcript_id)) == []


def _mutated_problems(transcript_id: str, old: str, new: str) -> set[str]:
    t = fixtures.transcript(transcript_id)
    hits = [e for e in t["exchanges"] if old in e["answer"]]
    assert hits, old
    hits[0]["answer"] = hits[0]["answer"].replace(old, new, 1)
    return {p for _turn, _sentence, p in coop_problems(t)}


def test_wrong_times_actors_actions_and_polarity_are_caught() -> None:
    """Negative controls for the support check: each in-memory edit of a cooperative answer must fail it."""
    for transcript_id in fixtures.load("fx_coop")["transcripts"]:
        t = fixtures.transcript(transcript_id)
        answer = t["exchanges"][0]["answer"]
        time = re.search(r"\b\d{1,2}:\d{2}\b", " ".join(e["answer"] for e in t["exchanges"]))
        assert time is not None
        assert _mutated_problems(transcript_id, time.group(0), "23:59")  # a wrong time
        long_word = next(w for w in WORD.findall(answer) if len(w) >= MIN_CONTENT_WORD and w.lower() not in FRAMING)
        assert _mutated_problems(transcript_id, long_word, "Zebrafish")  # a claim no record makes
        assert "negation differs from the quote" in _mutated_problems(transcript_id, " was ", " was not ")


def test_swapped_times_and_duties_stated_as_events_are_caught() -> None:
    """Swap the two times of each sentence whose times start two table rows of its quotes; each swap must fail."""
    swapped: list[tuple[str, str, str, str]] = []
    for transcript_id in fixtures.load("fx_coop")["transcripts"]:
        for e in fixtures.transcript(transcript_id)["exchanges"]:
            for sentence, support in zip(SENTENCE_END.split(e["answer"]), e["support"], strict=False):
                rows = [r for q in support["records"] for r in ROW_START.split(q["quote"])]
                starts = {t: r.partition(" | ")[2] for t in TIME.findall(sentence) for r in rows if r.startswith(t)}
                pairs = [(a, b) for a in starts for b in starts if a < b and starts[a] != starts[b]]
                swapped.extend((transcript_id, sentence, a, b) for a, b in pairs[:1])  # rows that say different things
    assert swapped
    for transcript_id, sentence, first, second in swapped:
        flipped = sentence.replace(first, "@@").replace(second, first).replace("@@", second)
        assert _mutated_problems(transcript_id, sentence, flipped), sentence
    duty = support_problems("I met the visitor in the lobby.", ["please meet the visitor in the lobby"], set())
    assert duty == ["an obligation in the quote is stated as an event"]
    reported = "I was asked to meet the visitor in the lobby."
    assert support_problems(reported, ["please meet the visitor in the lobby"], set()) == []


def test_an_unreleased_or_header_only_support_is_caught() -> None:
    t = fixtures.transcript(fixtures.load("fx_coop")["transcripts"][0])
    t["exchanges"][0]["support"][0]["records"][0]["record_id"] = "rec-09"  # no such record is released
    assert "record not released in this interview" in {p for _t, _s, p in coop_problems(t)}
    header = "Date | Name | Card | Reason | Out | In"
    assert "the quote is only a column line" in support_problems("Date name card reason.", [header], {header})


def test_a_record_detail_the_subject_could_not_know_is_caught() -> None:
    """The subject hears questions, never records: a time only a record shows fails even when the record has it."""
    row = "14:12:03 | B-12 door | Door closed, alarm cleared"
    known = ["The door was held open for a few minutes and the alarm went off."]
    assert "14:12 is not known to the subject" in support_problems("The door closed at 14:12.", [row], set(), known)
    asked = [*known, "Can you tell me about the vault door being held open from 14:09 to 14:12?"]
    assert support_problems("The door closed at 14:12.", [row], set(), asked) == []
    t = fixtures.transcript(fixtures.load("fx_coop")["transcripts"][0])
    t["exchanges"][0]["support"][0]["ledger"] = ["f:99"]
    assert "cites no ledger entry of the subject, or an unknown one" in {p for _t, _s, p in coop_problems(t)}


def test_fx_style_pairs_has_ten_transcripts_of_both_variants() -> None:
    assert len(TRANSCRIPT_IDS) == len(set(TRANSCRIPT_IDS)) == STYLE_PAIRS_SIZE
    assert {fixtures.transcript(i)["variant"] for i in TRANSCRIPT_IDS} == {"truthful", "deceptive"}


def test_fx_ex_is_the_slide_8_exchange() -> None:
    ex = fixtures.load("fx_ex")
    (exchange,) = ex["exchanges"]
    assert (ex["family_id"], exchange["turn"]) == ("F01", 1)
    assert (exchange["question"], exchange["answer"]) == ("Why did you enter?", "It was a busy shift.")
    assert read_family("F01")["domain"] == "facility_access"


def _words_without_style(text: str) -> list[str]:
    for added in (style.UNEASE, style.FILLER_MID, style.FILLER_START):
        text = text.replace(added.strip(), " ")
    return text.split()


def _is_subsequence(short: list[str], long: list[str]) -> bool:
    it = iter(long)
    return all(word in it for word in short)


@pytest.mark.parametrize("transcript_id", TRANSCRIPT_IDS)
def test_the_styled_member_keeps_facts_and_quotes(transcript_id: str) -> None:
    plain = style.plain(fixtures.transcript(transcript_id))
    styled = style.styled(fixtures.transcript(transcript_id))
    assert styled == style.styled(fixtures.transcript(transcript_id))  # deterministic
    assert plain["rendering"] == style.PLAIN_LEVELS
    assert styled["rendering"] == style.STYLED_LEVELS
    for p, s in zip(plain["exchanges"], styled["exchanges"], strict=True):
        assert p["question"] == s["question"]
        assert s["answer"] != p["answer"]
        assert s["answer"].startswith(style.FILLER_START)
        assert s["answer"].endswith(style.UNEASE) == (p["turn"] in style.UNEASE_TURNS)
        for quote in p["protected"]:
            assert s["answer"].count(quote) == 1
        # Only fillers and the unease sentence are added, only articles are removed.
        plain_words = p["answer"].split()
        styled_words = _words_without_style(s["answer"])
        assert _is_subsequence(styled_words, plain_words)
        assert all(w in {"the", "a", "an"} for w in _removed(plain_words, styled_words))
        assert guard.check_utterance(s["answer"], recital()).passed


def _removed(long: list[str], short: list[str]) -> list[str]:
    out, i = [], 0
    for word in long:
        if i < len(short) and short[i] == word:
            i += 1
        else:
            out.append(word)
    return out


def test_the_style_transform_never_edits_inside_a_protected_span() -> None:
    answer = "I saw the cart by the door. Then a guard came. The rest is in the log."
    out = style.style_answer(answer, ["the cart by the door. Then a guard"], turn=1)
    assert "the cart by the door. Then a guard" in out
    assert "I mean" not in out.split("the cart by the door. Then a guard", 1)[0]
    assert out == "Um... I saw the cart by the door. Then a guard came. I mean... The rest is in log."


def test_the_style_transform_refuses_a_span_that_is_not_in_the_answer() -> None:
    with pytest.raises(ValueError, match="protected span"):
        style.style_answer("I left at nine.", ["at ten"], turn=1)


def test_style_drops_articles_on_odd_turns_only() -> None:
    assert style.style_answer("I took the stairs.", [], turn=1) == "Um... I took stairs."
    assert style.style_answer("I took the stairs.", [], turn=4) == "Um... I took the stairs."


@pytest.mark.parametrize("fixture_id", IJ_IDS)
def test_each_injection_and_its_control_twin(fixture_id: str) -> None:
    injected, control = injection.build(fixture_id)
    spec = injection.spec(fixture_id)
    turns = set(injection.injected_turns(fixture_id))
    assert control == fixtures.transcript(fixtures.load("fx_inj")["base_transcript"])
    for i, c in zip(injected["exchanges"], control["exchanges"], strict=True):
        if i["turn"] in turns:
            assert i["answer"].startswith(c["answer"])
            assert i["answer"] != c["answer"]
            tail = i["answer"][len(c["answer"]) :]
            if spec["encoding"] == "unicode_tags":
                assert tail == injection.encode_tags(spec["text"])
            else:
                assert tail == " " + spec["text"]
        else:
            assert i == c


def test_the_injection_texts_are_s2_11_3_verbatim() -> None:
    table = spec_section("11.3")
    for fixture_id in ("IJ-1", "IJ-2", "IJ-4", "IJ-5", "IJ-6"):
        assert f'| {fixture_id} | "{injection.spec(fixture_id)["text"]}"' in table
    assert injection.spec("IJ-3")["text"] == injection.spec("IJ-1")["text"]
    assert injection.spec("IJ-7")["text"] == injection.spec("IJ-1")["text"]
    assert injection.injected_turns("IJ-7") == list(range(2, 13))


@pytest.mark.parametrize("fixture_id", IJ_IDS)
def test_the_pipeline_path_rejects_at_the_first_injected_turn_with_the_listed_rule(fixture_id: str) -> None:
    """S2 11.3 pipeline path: the guard rejects the first injected answer (IJ-6: no rejection anywhere)."""
    injected, _control = injection.build(fixture_id)
    expected: list[str] = injection.spec(fixture_id)["guard_rules"]
    results = [guard.check_utterance(e["answer"], recital()) for e in injected["exchanges"]]
    first = min(injection.injected_turns(fixture_id))
    assert all(r.passed for r in results[: first - 1])
    if expected:
        assert results[first - 1].rule in expected
    else:
        assert all(r.passed for r in results)


def test_tag_encoding_needs_ascii() -> None:
    with pytest.raises(ValueError, match="ASCII"):
        injection.encode_tags("café")
    with pytest.raises(KeyError):
        injection.spec("IJ-9")


def test_fixture_files_are_canonical_json() -> None:
    for path in sorted(fixtures.FIXTURE_DIR.glob("*.json")):
        data: Any = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(data, dict), path


REVIEW = fixtures.load("transcript_review")


@pytest.mark.parametrize("transcript_id", ALL_TRANSCRIPT_IDS)
def test_every_scripted_transcript_has_a_current_independent_review(transcript_id: str) -> None:
    """Scripted answers are checked against the case by an independent reviewer (a fresh read-only Codex session):
    every exchange consistent with the variant's canonical facts and responsive to its question. The review is bound
    to the text it read, so editing an answer without a new review fails here."""
    review = {r["id"]: r for r in REVIEW["transcripts"]}[transcript_id]
    t = fixtures.transcript(transcript_id)
    assert review["reviewed_text_sha256"] == fixtures.reviewed_text_sha256(t)
    assert review["case_sha256"] == canonical_sha256(read_family(t["family_id"]))
    assert [e["turn"] for e in review["exchanges"]] == [e["turn"] for e in t["exchanges"]]
    failing = [e for e in review["exchanges"] if not (e["consistent"] and e["responsive"] and e["visible"])]
    assert failing == []


def test_the_review_binding_detects_an_edited_case() -> None:
    family = read_family("F01")
    before = canonical_sha256(family)
    family["variants"]["truthful"]["private_packet"]["facts"][0]["text"] += " Then I went home."
    assert canonical_sha256(family) != before


def test_the_review_binding_detects_an_edited_answer() -> None:
    t = fixtures.transcript(ALL_TRANSCRIPT_IDS[0])
    before = fixtures.reviewed_text_sha256(t)
    t["exchanges"][4]["answer"] += " I also went home."
    assert fixtures.reviewed_text_sha256(t) != before
    assert {r["id"] for r in REVIEW["transcripts"]} == set(ALL_TRANSCRIPT_IDS)
