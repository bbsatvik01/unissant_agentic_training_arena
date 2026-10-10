"""FX-COOP (S2 11.1): three cooperative truthful transcripts; code checks ledger IDs and quotes, the review the rest."""

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
def test_cited_ledger_ids_exist_and_quotes_are_verbatim_and_released(transcript_id: str) -> None:
    """S2 11.1, code side: every cited ledger ID exists in the variant; every cited quote is verbatim from a record
    released in the interview."""
    assert problems(fixtures.transcript(transcript_id)) == []


REVIEW = {r["id"]: r for r in fixtures.load("transcript_review")["transcripts"]}
SEMANTIC = ("consistent", "responsive", "visible", "ledger_states_claims", "quotes_state_facts", "uncontradicted")


@pytest.mark.parametrize("transcript_id", COOP_IDS)
def test_every_pair_has_a_current_passing_review(transcript_id: str) -> None:
    """S2 11.1, review side: every Q/A pair has a current passing independent review (consistency with the case,
    numbers, polarity, responsiveness, subject visibility), bound to the text; the case hash binding and the other
    transcripts are tested in test_fixtures."""
    review = REVIEW[transcript_id]
    t = fixtures.transcript(transcript_id)
    assert review["reviewed_text_sha256"] == fixtures.reviewed_text_sha256(t)
    assert [e["turn"] for e in review["exchanges"]] == [e["turn"] for e in t["exchanges"]]
    failing = [(e["turn"], k) for e in review["exchanges"] for k in SEMANTIC if e.get(k) is not True]
    assert failing == []


def test_an_unknown_ledger_id_fails() -> None:
    assert cc.ledger_problems(["f:01", "f:99"], {"f:01": "x"}) == ["cites an unknown ledger entry: f:99"]
    t = fixtures.transcript(COOP_IDS[0])
    t["exchanges"][0]["support"][0]["ledger"] = ["f:99"]
    assert "cites an unknown ledger entry: f:99" in kinds(t)


def test_a_quote_must_be_verbatim_and_released() -> None:
    texts = {"rec-03": "Copier log.\n16:52 | Copy | 3 | L. Specht"}
    ok = {"record_id": "rec-03", "quote": "16:52 | Copy | 3 | L. Specht"}
    assert cc.quote_problems([ok], texts, {"rec-03"}) == []
    assert cc.quote_problems([ok], texts, set()) == ["record not released in this interview: rec-03"]
    altered = {**ok, "quote": "16:52 | Copy | 4 | L. Specht"}
    assert cc.quote_problems([altered], texts, {"rec-03"}) == ["quote not in the record: rec-03"]
    t = fixtures.transcript(COOP_IDS[0])
    cited = next(s for e in t["exchanges"] for s in e["support"] if s["records"])
    cited["records"][0]["quote"] += " and more"
    assert any(p.startswith("quote not in the record") for p in kinds(t))


def test_support_entries_align_with_sentences() -> None:
    t = fixtures.transcript(COOP_IDS[0])
    t["exchanges"][0]["support"].append({"kind": "fact", "ledger": [], "records": []})
    assert "one support entry per sentence" in kinds(t)
