"""The one quote predicate and citation check (S2 4.4.1, D6) on the shared fixture file."""

from __future__ import annotations

from typing import Any

import pytest

from arena_core.contracts.citations import (
    Cite,
    Record,
    Turn,
    cites_of,
    content_text,
    finding_citation_ok,
    flag_citations_ok,
    normalize,
    quote_ok,
)

from .conftest import load_fixture

FIXTURE = load_fixture("citations.json")


def _text(case: dict[str, Any]) -> str:
    return str(case["text"]) if "text" in case else content_text(case["content"])


@pytest.mark.parametrize("case", FIXTURE["quote_cases"], ids=lambda c: c["id"])
def test_quote_ok_on_every_shared_quote_case(case: dict[str, Any]) -> None:
    assert quote_ok(case["quote"], _text(case)) is case["expected"]


def _trial() -> tuple[dict[int, Turn], dict[str, Record]]:
    trial = FIXTURE["trial"]
    turns = {int(n): Turn(t["answer"], t["partial"]) for n, t in trial["turns"].items()}
    records = {rid: Record(content_text(r["content"]), r["released_after"]) for rid, r in trial["records"].items()}
    return turns, records


@pytest.mark.parametrize("case", FIXTURE["citation_cases"], ids=lambda c: c["id"])
def test_flag_citations_ok_on_every_shared_citation_case(case: dict[str, Any]) -> None:
    turns, records = _trial()
    flag = case["flag"]
    assert flag_citations_ok(flag["kind"], cites_of(flag), turns, records, case["card_turn"]) is case["expected"]


def test_the_fixture_covers_every_case_of_the_s2_table() -> None:
    ids = {c["id"] for c in FIXTURE["quote_cases"]} | {c["id"] for c in FIXTURE["citation_cases"]}
    s2_table = {f"CQ-{n}" for n in range(1, 10)} | {"CQ-10a", "CQ-10b", "CQ-11", "CQ-12a", "CQ-12b"}
    assert s2_table <= ids


def test_normalize_folds_dashes_quotes_and_whitespace_but_keeps_case() -> None:
    assert normalize("  \u201cA\u201d\u2014b\u2019s\t\n C  ") == '"A"-b\'s C'
    assert normalize("\u2010\u2011\u2012\u2013\u2014\u2015\u2212") == "-------"


def test_cites_of_returns_the_main_citation_first_and_the_conflict_second() -> None:
    base = {"quote": "a b c", "turn_id": "t03", "conflict_quote": None, "conflict_turn_id": None}
    assert cites_of({**base, "kind": "gap"}) == [Cite("a b c", turn_no=3)]
    contradiction = {**base, "kind": "contradiction", "conflict_quote": "d e f", "conflict_turn_id": "t01"}
    assert cites_of(contradiction) == [Cite("a b c", turn_no=3), Cite("d e f", turn_no=1)]
    conflict = {**base, "kind": "evidence_conflict", "conflict_record_quote": "x y z", "conflict_record_id": "doc-01"}
    assert cites_of(conflict) == [Cite("a b c", turn_no=3), Cite("x y z", record_id="doc-01")]


def test_finding_citations_need_a_committed_answer_or_a_released_record() -> None:
    turns, records = _trial()
    assert finding_citation_ok(turns, records, 5, 5, 5)
    assert not finding_citation_ok(turns, records, 4, 4, 5)  # future turn
    assert not finding_citation_ok(turns, records, 6, 6, 6)  # partial answer
    assert not finding_citation_ok(turns, records, 6, 6, 9)  # no such turn
    assert finding_citation_ok(turns, records, 1, 0, "doc-01")  # initial document from the start
    assert not finding_citation_ok(turns, records, 3, 2, "rec-02")  # released after exchange 3
    assert finding_citation_ok(turns, records, 3, 3, "rec-02")
    assert not finding_citation_ok(turns, records, 3, 3, "rec-05")  # never released


def test_a_record_citation_without_a_record_id_never_matches() -> None:
    turns, records = _trial()
    assert not flag_citations_ok("evidence_conflict", [Cite("a b c")], turns, records, 4)
