"""FX-COOP (S2 11.1): three cooperative truthful transcripts, each sentence held to four independent checks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from arena_core import fixtures
from arena_core.scenario.content import content_text
from arena_core.scenario.load import read_family_file

from . import coop_check as cc
from .conftest import SPEC_S2

CASES_DIR: Path = SPEC_S2.parents[2] / "cases" / "dev"
COOP_IDS: list[str] = fixtures.load("fx_coop")["transcripts"]
COOP_SIZE = 3
MIN_CITED = 5


def _truthful(family_id: str) -> dict[str, Any]:
    variants: dict[str, Any] = read_family_file(CASES_DIR / f"{family_id}.json")["variants"]
    return dict(variants["truthful"])


def record_texts(family_id: str) -> dict[str, str]:
    v = _truthful(family_id)
    docs = {d["doc_id"]: content_text(d["content"]) for d in v["public_packet"]["initial_documents"]}
    return docs | {a["artifact_id"]: content_text(a["content"]) for a in v["evaluator_packet"]["evidence_artifacts"]}


def ledger(family_id: str) -> dict[str, str]:
    """The truthful subject's ledger by ID: facts, uncertainty with its range, and unknown-fact views."""
    p = _truthful(family_id)["private_packet"]
    out = {f["id"]: f["text"] for f in p["facts"]}
    out |= {u["id"]: f"{u['text']} {u.get('range_text', '')}" for u in p["uncertainty"]}
    return out | {u["fact_id"]: u["subject_view"] for u in p["unknown_facts"]}


def problems(t: dict[str, Any]) -> list[cc.Problem]:
    return cc.coop_problems(t, ledger(t["family_id"]), record_texts(t["family_id"]))


def kinds(t: dict[str, Any]) -> set[str]:
    return {p for _turn, _sentence, p in problems(t)}


def test_fx_coop_is_three_cooperative_truthful_transcripts() -> None:
    assert len(COOP_IDS) == len(set(COOP_IDS)) == COOP_SIZE
    assert {fixtures.transcript(i)["variant"] for i in COOP_IDS} == {"truthful"}


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_every_sentence_passes_the_mechanical_checks(transcript_id: str) -> None:
    """S2 11.1 enforcement, code side: ledger IDs exist, quotes verbatim and released, numbers as whole tokens,
    per-quote polarity, no time on the wrong row, perception claims phrased as such. The review is the semantic side."""
    assert problems(fixtures.transcript(transcript_id)) == []


REVIEW = {r["id"]: r for r in fixtures.load("transcript_review")["transcripts"]}
SEMANTIC = ("consistent", "responsive", "visible", "ledger_states_claims", "quotes_state_facts", "uncontradicted")


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_every_pair_has_a_current_passing_semantic_review(transcript_id: str) -> None:
    """S2 11.1 enforcement, review side: for every Q/A pair the recorded independent review says the cited ledger
    entries state each claim (the question text did not supply it), every cited quote states the same fact, and no
    record of the variant, cited or not, contradicts a claim. The text and case hash binding is in test_fixtures."""
    review = REVIEW[transcript_id]
    t = fixtures.transcript(transcript_id)
    assert review["reviewed_text_sha256"] == fixtures.reviewed_text_sha256(t)
    assert [e["turn"] for e in review["exchanges"]] == [e["turn"] for e in t["exchanges"]]
    failing = [(e["turn"], k) for e in review["exchanges"] for k in SEMANTIC if e.get(k) is not True]
    assert failing == []


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_the_controls_state_facts_records_also_state(transcript_id: str) -> None:
    """A control that cited no record would never exercise the agreement checks: each cites a released record for at
    least five fact sentences. A quote is cited only where the review confirms it states the sentence's whole fact
    (S2 11.1 requires agreement only where a record states the fact), so this is a floor on coverage, not a ratio."""
    support = [s for e in fixtures.transcript(transcript_id)["exchanges"] for s in e["support"]]
    assert sum(bool(s["records"]) for s in support if s["kind"] == "fact") >= MIN_CITED


# ------------------------------------------------------- regressions: each mechanical check fails on its defect

COPIER_ROW = "16:52 | Copy | 3 | L. Specht"
DOOR = "Door events.\n19:12 | Room 417 door contact | Door opened\n19:38 | Room 417 door contact | Door closed"


def test_a_contradicting_quote_fails_on_polarity() -> None:
    """The cold-gate example: a quote saying the opposite fails, whatever the ledger says."""
    assert polarity("I did not use the copier.", ["I used the copier."])
    assert cc.polarity_problems(
        "I did not use the office copier.", ["I did not use the office copier.", "I used the office copier."]
    ) == ["polarity differs from the quote: 'I used the office copier.'"]
    assert cc.polarity_problems("I did not use the copier.", ["I did not use the copier."]) == []


def polarity(sentence: str, quotes: list[str]) -> bool:
    return bool(cc.polarity_problems(sentence, quotes))


def test_numbers_match_whole_tokens_and_spelled_out_numbers_count() -> None:
    assert cc.number_problems("I opened the 41 door.", ["You opened the 417 door."], []) == [
        "41 is not in the cited ledger or the questions"
    ]
    assert cc.number_problems("The copier ran at 16:58.", ["16:58"], [COPIER_ROW]) == ["16:58 disagrees with the quote"]
    assert (
        cc.number_problems("The door opened at 19:12.", ["at 19:12"], ["19:12:40 | Room 417 door | Door opened"]) == []
    )
    assert cc.number_problems("I walk-tested it ten times.", ["You walk-tested it two times."], []) == [
        "10 is not in the cited ledger or the questions"
    ]
    assert cc.number_problems("I walk-tested it twice.", ["You walk-tested it two times."], []) == []


@pytest.mark.parametrize(
    ("phrase", "value"),
    [
        ("seventy", ["70"]),
        ("twenty-one", ["21"]),
        ("about ten", ["10"]),
        ("two hundred and five", ["205"]),
        ("twice", ["2"]),
        ("thirty million", ["30000000"]),
        ("a dozen", ["12"]),
        ("between ten and twenty", ["10", "20"]),
        ("about ten in total, around", ["10"]),
    ],
)
def test_spelled_out_quantities_are_numbers(phrase: str, value: list[str]) -> None:
    assert cc.numbers(f"I loaded {phrase} binders.") == value


@pytest.mark.parametrize(
    ("phrase", "value"),
    [
        ("after eight", ["8"]),
        ("a bit after nine", ["9"]),
        ("ten to five", ["10", "5"]),
        ("five to ten", ["5", "10"]),
        ("half past twelve", ["12"]),
        ("thirty\u2011two", ["32"]),
        ("thirty\u2013two", ["32"]),
    ],
)
def test_every_number_phrase_is_compared(phrase: str, value: list[str]) -> None:
    """Fail closed: spoken times are compared as numbers too, and any dash joins a compound number."""
    assert cc.numbers(f"It was {phrase}.") == value


@pytest.mark.parametrize(
    "replacement",
    [
        "seventy training binders",
        "twenty-one training binders",
        "about ten training binders",
        "training binders, about ten in total",
        "between ten and twenty training binders",
        "thirty million training binders",
        "five to ten training binders",
        "thirty\u2011two training binders",
        "thirty and a half training binders",
        "half a dozen training binders",
        "half the thirty training binders",
        "thirty and a fifth training binders",
        "thirty and a twelfth training binders",
        "thirty and a thousandth training binders",
        "30\u00bd training binders",
        "-30 training binders",
        "negative thirty training binders",
    ],
)
def test_a_changed_quantity_in_a_control_fails(replacement: str) -> None:
    """Transcript-level: F07's "thirty training binders" (cited against a record that says 30) changed to another
    quantity, spelled any way, fails the number check."""
    found = _mutate("TX-F07-C", "thirty training binders", replacement)
    numeric = ("disagrees with the quote", "is not in the cited ledger", "unsupported number phrase")
    assert any(any(n in p for n in numeric) for p in found), found


@pytest.mark.parametrize(
    "phrase",
    [
        "thirty and a half",
        "half a dozen",
        "two thirds",
        "1.5",
        "3/4",
        "half the thirty",
        "thirty and a fifth",
        "10 percent",
    ],
)
def test_fractional_quantities_are_rejected(phrase: str) -> None:
    assert cc.number_problems(f"I loaded {phrase} binders.", ["I loaded binders."], [])[0].startswith(
        "unsupported number phrase"
    )
    assert cc.unsupported_numbers("It was half past twelve.") == []


@pytest.mark.parametrize("apostrophe", ["'", "\u2019", "\u2018", "\u02bc"])
def test_a_contraction_negates_whatever_its_apostrophe(apostrophe: str) -> None:
    assert cc.polarity_problems(f"My badge didn{apostrophe}t open S-2.", ["Access granted to badge 40562 at S-2."])
    found = _mutate("TX-F07-C", "Then my badge opened S-2.", f"Then my badge didn{apostrophe}t open S-2.")
    assert any(p.startswith("polarity differs") for p in found), found


def test_no_time_on_the_wrong_row() -> None:
    assert cc.time_row_problems("The door opened at 19:38.", [], [DOOR]) == ["open goes with another time than 19:38"]
    assert cc.time_row_problems("The door opened at 19:12 and closed at 19:38.", [], [DOOR]) == []
    assert cc.time_row_problems("The door closed at 19:12 and opened at 19:38.", [], [DOOR])
    assert cc.time_row_problems("I was there from 19:38 until 19:12.", [], [DOOR]) == [
        "the span from 19:38 to 19:12 runs backwards"
    ]


def test_an_identifier_on_another_times_row_fails_against_a_real_record() -> None:
    """F09 doc-01: badge 70288 at 08:12, badge 70315 at 08:41. Swapping the badge numbers between the rows fails."""
    records = list(record_texts("F09").values())
    assert cc.time_row_problems("Badge 70315 was granted access at 08:41.", [], records) == []
    for wrong in (
        "Badge 70315 was granted access at 08:12.",
        "Badge 70315 was granted access through the north staff door at 08:12.",
        "At 08:12 the north staff door granted access to badge 70315 from the car park side.",
        "70315 entered at 08:12.",
    ):
        assert cc.time_row_problems(wrong, [], records) == ["70315 goes with another time than 08:12"], wrong


def test_coordinated_clauses_and_time_lists_are_checked() -> None:
    records = list(record_texts("F06").values())
    assert cc.time_row_problems("The 417 door opened at 19:12 and closed at 19:38.", [], records) == []
    assert cc.time_row_problems("The 417 door opened at 19:12 and closed at 19:12.", [], records) == [
        "clos goes with another time than 19:12"
    ]
    assert cc.time_row_problems("The 417 door opened at 19:12 and 19:38.", [], records) == [
        "open goes with another time than 19:38"
    ]


def test_a_long_clause_still_binds_its_event_to_its_time() -> None:
    records = list(record_texts("F06").values())
    assert cc.time_row_problems("The 417 door opened at the time I already mentioned, 19:12.", [], records) == []
    assert cc.time_row_problems("The 417 door opened at the time I already mentioned, 19:38.", [], records) == [
        "open goes with another time than 19:38"
    ]


def test_no_time_on_the_wrong_row_against_a_real_record() -> None:
    """The controls state no record-only clock times (their ledgers hold none), so the time-row check is proven on a
    real development record instead: F06 doc-01 has the 417 door opening at 19:12 and closing at 19:38."""
    records = list(record_texts("F06").values())
    assert cc.time_row_problems("The 417 door opened at 19:12.", [], records) == []
    assert cc.time_row_problems("The 417 door opened at 19:38.", [], records) == [
        "open goes with another time than 19:38"
    ]


def test_quotes_must_be_verbatim_released_and_not_a_column_line() -> None:
    texts = {"rec-03": "Copier log.\nTime | Job | Pages | Account\n" + COPIER_ROW}
    columns = {"Time | Job | Pages | Account"}
    ok = {"record_id": "rec-03", "quote": COPIER_ROW}
    assert cc.quote_problems([ok], texts, {"rec-03"}, columns) == []
    assert cc.quote_problems([ok], texts, set(), columns) == ["record not released in this interview"]
    assert cc.quote_problems([{**ok, "quote": "16:52 | Copy | 4 | L. Specht"}], texts, {"rec-03"}, columns) == [
        "quote not in the record"
    ]
    header = {"record_id": "rec-03", "quote": "Time | Job | Pages | Account"}
    assert "the quote is only a column line" in cc.quote_problems([header], texts, {"rec-03"}, columns)
    assert cc.quote_problems([ok, ok, ok], texts, {"rec-03"}, columns) == ["more than two quotes"]


def test_ledger_ids_must_exist_and_only_plain_ignorance_cites_none() -> None:
    ledger_ = {"f:01": "x"}
    assert cc.ledger_problems(["f:99"], ledger_) == ["cites an unknown ledger entry"]
    assert cc.ledger_problems(["f:01"], ledger_) == []
    assert cc.ledger_problems([], ledger_) == ["cites no ledger entry of the subject"]
    assert cc.ledger_problems([], ledger_, "I have not seen that camera review.", "perception") == []
    assert cc.ledger_problems([], ledger_, "I have not seen that camera review.", "fact") == [
        "cites no ledger entry of the subject"
    ]
    assert cc.ledger_problems([], ledger_, "I did not see anyone at the lift.", "perception") == [
        "cites no ledger entry of the subject"
    ]


def test_every_ledger_free_ignorance_claim_is_confirmed_by_the_review() -> None:
    """Whether the ledger really is silent is semantic: every turn holding a ledger-free ignorance sentence has a review
    that confirms its claims are ledger-backed (no false denial of something the ledger knows)."""
    found = 0
    for transcript_id in COOP_IDS:
        review = {e["turn"]: e for e in REVIEW[transcript_id]["exchanges"]}
        for e in fixtures.transcript(transcript_id)["exchanges"]:
            if any(not s["ledger"] for s in e["support"]):
                found += 1
                assert review[e["turn"]]["ledger_states_claims"] is True


def test_perception_claims_are_phrased_as_such_and_cite_no_record() -> None:
    assert cc.perception_problems("I did not see the pass itself.", "perception", []) == []
    assert cc.perception_problems("I did not see the pass itself.", "fact", []) == [
        "a perception or memory claim is marked as a fact"
    ]
    assert cc.perception_problems("The pass was issued.", "perception", []) == [
        "a perception claim is not phrased as one"
    ]
    record = {"record_id": "rec-01", "quote": "Pass issued to O. Mattick."}
    assert cc.perception_problems("I never saw the pass.", "perception", [record]) == [
        "a perception claim cites a record"
    ]
    assert cc.perception_problems("The pass was issued.", "claim", []) == ["unknown claim kind 'claim'"]


def _mutate(transcript_id: str, old: str, new: str) -> set[str]:
    t = fixtures.transcript(transcript_id)
    hits = [e for e in t["exchanges"] if old in e["answer"]]
    assert hits, old
    hits[0]["answer"] = hits[0]["answer"].replace(old, new, 1)
    return kinds(t)


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_edits_to_a_control_fail_the_mechanical_checks(transcript_id: str) -> None:
    """A record-cited sentence with a flipped polarity, an unreleased record and an unknown ledger entry each fail;
    editing any answer also invalidates its review (test_fixtures)."""
    t = fixtures.transcript(transcript_id)
    exchange, sentence, support = next(
        (e, s, sup)
        for e in t["exchanges"]
        for s, sup in zip(cc.sentences(e["answer"]), e["support"], strict=True)
        if sup["records"]
    )
    flipped = cc.NEGATORS.sub("", sentence, count=1) if cc.NEGATORS.search(sentence) else f"Not {sentence}"
    original = exchange["answer"]
    exchange["answer"] = original.replace(sentence, flipped, 1)
    assert any(p.startswith("polarity differs") for p in kinds(t))
    exchange["answer"] = original
    support["records"][0]["record_id"] = "rec-09"
    assert "record not released in this interview" in kinds(t)
    t = fixtures.transcript(transcript_id)
    t["exchanges"][0]["support"][0]["ledger"] = ["f:99"]
    assert "cites an unknown ledger entry" in kinds(t)


def test_a_changed_number_in_a_record_cited_sentence_fails() -> None:
    changed = []
    for transcript_id in COOP_IDS:
        t = fixtures.transcript(transcript_id)
        for e in t["exchanges"]:
            for s, sup in zip(cc.sentences(e["answer"]), e["support"], strict=True):
                if sup["records"] and cc.numbers(s):
                    n = next(w for w in cc.WORD.findall(s) if cc.numbers(w))
                    changed.append((transcript_id, s, s.replace(n, "99", 1)))
    assert changed
    for transcript_id, old, new in changed:
        assert any("99" in p for p in _mutate(transcript_id, old, new)), old
