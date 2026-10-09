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
def test_every_sentence_passes_the_four_s2_11_1_checks(transcript_id: str) -> None:
    """Known to the subject; agrees with any released record cited for the same fact; not contradicted by any record
    of the variant; perception and memory claims phrased as such and backed by the ledger only."""
    assert problems(fixtures.transcript(transcript_id)) == []


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_the_controls_state_facts_records_also_state(transcript_id: str) -> None:
    """A control that cited no record anywhere would test nothing: most fact sentences cite a released record."""
    support = [s for e in fixtures.transcript(transcript_id)["exchanges"] for s in e["support"]]
    facts = [s for s in support if s["kind"] == "fact"]
    assert sum(bool(s["records"]) for s in facts) * 2 > len(facts)


# ---------------------------------------------------------------- regressions: each check fails on its own defect

KNOWN = ["You did not use the copier."]
COPIER_ROW = "16:52 | Copy | 3 | L. Specht"


def test_the_cold_gate_example_fails_on_polarity() -> None:
    """A quote that says the opposite of the sentence fails agreement even when the ledger matches the sentence."""
    assert cc.knowledge_problems("I did not use the copier.", KNOWN) == []
    found = cc.agreement_problems("I did not use the copier.", ["I used the copier."], set())
    assert "polarity differs from the quote" in found


def test_an_unrelated_supporting_quote_fails() -> None:
    found = cc.agreement_problems("I closed the valve in the riser closet.", ["Walk-up copying is enabled."], set())
    assert any(p.startswith("the quote is not about the sentence") for p in found)


def test_a_contradicting_number_in_the_quote_fails() -> None:
    found = cc.agreement_problems("The copier ran one job at 16:58 for Specht.", [COPIER_ROW], set())
    assert "16:58 disagrees with the quote" in found


def test_knowledge_is_never_borrowed_from_a_record() -> None:
    """A word only the record holds is not known to the subject, however well the record supports it."""
    sentence = "The copier ran one job for Specht."
    assert "Specht is not known to the subject" in cc.knowledge_problems(sentence, KNOWN)
    assert "16:52 is not known to the subject" in cc.knowledge_problems("Specht copied at 16:52.", ["Specht copied."])


def test_polarity_must_match_the_ledger() -> None:
    assert "polarity differs from the ledger" in cc.knowledge_problems("I used the copier.", KNOWN)


def test_a_record_time_attached_to_something_else_contradicts_it() -> None:
    rows = ["19:12 | Room 417 door contact | Door opened\n19:38 | Room 417 door contact | Door closed"]
    found = cc.contradiction_problems("The door opened at 19:38 and closed at 19:12.", rows)
    assert any(p.startswith("contradicts a record") for p in found)
    assert cc.contradiction_problems("The door opened at 19:12 and closed at 19:38.", rows) == []
    assert cc.contradiction_problems("I was there from 19:38 until 19:12.", rows) == [
        "contradicts a record: the span from 19:38 to 19:12 runs backwards"
    ]


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


def test_a_duty_and_a_column_line_are_not_support() -> None:
    duty = cc.agreement_problems("I met the visitor in the lobby.", ["please meet the visitor in the lobby"], set())
    assert "a duty in the quote is stated as an event" in duty
    reported = "I was asked to meet the visitor in the lobby."
    assert cc.agreement_problems(reported, ["please meet the visitor in the lobby"], set()) == []
    header = "Date | Name | Card | Reason | Out | In"
    assert "the quote is only a column line" in cc.agreement_problems("Date name card reason out.", [header], {header})


def _mutate(transcript_id: str, old: str, new: str) -> set[str]:
    t = fixtures.transcript(transcript_id)
    hits = [e for e in t["exchanges"] if old in e["answer"]]
    assert hits, old
    hits[0]["answer"] = hits[0]["answer"].replace(old, new, 1)
    return kinds(t)


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_edits_to_a_control_fail(transcript_id: str) -> None:
    """A word no ledger holds, a flipped polarity, an unreleased record and an unknown ledger entry each fail."""
    t = fixtures.transcript(transcript_id)
    first = cc.sentences(t["exchanges"][0]["answer"])[0]
    word = next(w for w in cc.WORD.findall(first) if cc.content(w))
    assert any("Zebrafish" in p for p in _mutate(transcript_id, word, "Zebrafish"))
    assert "polarity differs from the ledger" in _mutate(transcript_id, first, first.replace(" was ", " was not ", 1))
    t = fixtures.transcript(transcript_id)
    cited = next((e, s) for e in t["exchanges"] for s in e["support"] if s["records"])
    cited[1]["records"][0]["record_id"] = "rec-09"
    assert "record not released in this interview" in kinds(t)
    t = fixtures.transcript(transcript_id)
    t["exchanges"][0]["support"][0]["ledger"] = ["f:99"]
    assert "cites no ledger entry of the subject, or an unknown one" in kinds(t)


def test_swapped_times_in_the_controls_fail() -> None:
    swapped: list[tuple[str, str, str, str]] = []
    for transcript_id in COOP_IDS:
        texts = record_texts(fixtures.transcript(transcript_id)["family_id"]).values()
        rows = cc.rows_of(texts)
        for e in fixtures.transcript(transcript_id)["exchanges"]:
            for sentence in cc.sentences(e["answer"]):
                starts = {
                    t: r.partition(" | ")[2] for t in cc.TIME.findall(sentence) for r, _ in rows if r.startswith(t)
                }
                pairs = [(a, b) for a in starts for b in starts if a < b and starts[a] != starts[b]]
                swapped.extend((transcript_id, sentence, a, b) for a, b in pairs[:1])
    for transcript_id, sentence, first, second in swapped:
        flipped = sentence.replace(first, "@@").replace(second, first).replace("@@", second)
        assert _mutate(transcript_id, sentence, flipped), sentence


def _one_sentence(answer: str, support: dict[str, Any]) -> dict[str, Any]:
    return {
        "family_id": "F06",
        "variant": "truthful",
        "exchanges": [
            {
                "turn": 1,
                "question": "We have Copier MF-417 job log, Room 417. Can you tell me about it?",
                "released_before": ["doc-01"],
                "answer": answer,
                "protected": [],
                "support": [support],
            }
        ],
    }


def test_ignorance_needs_no_ledger_entry_but_nothing_else_does() -> None:
    """S2 6.3: what is not in the ledger the subject does not know. "I have not seen the copier job log." stands on
    the ledger's silence; a fact, or a perception with content of its own, still needs a ledger entry."""
    plain = {"kind": "perception", "ledger": [], "records": []}
    assert problems(_one_sentence("I have not seen the copier job log.", plain)) == []
    assert problems(_one_sentence("I do not know anything about the copier job log.", plain)) == []
    claimed = "cites no ledger entry of the subject, or an unknown one"
    assert claimed in kinds(_one_sentence("I did not see anyone use the copier.", plain))
    assert claimed in kinds(_one_sentence("I have not seen the copier job log.", {**plain, "kind": "fact"}))
    assert "zebrafish is not known to the subject" in kinds(_one_sentence("I have not seen the zebrafish log.", plain))
