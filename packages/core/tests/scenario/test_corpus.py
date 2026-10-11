"""Hidden-content scan corpus (S1 10.4): AC-S1-33 on a development family relabeled as hidden (F02), with F01
and F03 as the development reference -- exactly the spec's own worked fixture (S1 10.4 narrative)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from arena_core.scenario.corpus import build_corpus, dev_reference_grams, scan

REPO = Path(__file__).resolve().parents[4]
EX4 = (
    "All cases are synthetic. Evasive wording alone does not prove a violation. "
    "A simulated score is not a finding about a real person."
)


def family(code: str) -> dict[str, Any]:
    data = json.loads((REPO / f"docs/spec/seed-families/{code}.json").read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def test_the_ex4_ground_rules_and_a_development_fixture_give_zero_hits() -> None:
    f02 = family("F02")
    reference = dev_reference_grams([family("F01"), family("F03")])
    corpus = build_corpus(f02, reference)

    assert scan(corpus, EX4) == []

    f01_opening = family("F01")["variants"]["truthful"]["public_packet"]["opening_question"]
    assert scan(corpus, f01_opening) == []


def test_without_the_development_subtraction_shared_boilerplate_can_hit() -> None:
    f02 = family("F02")
    corpus_no_subtraction = build_corpus(f02, frozenset())
    f01_opening = family("F01")["variants"]["truthful"]["public_packet"]["opening_question"]
    # F01's opening question shares the "Can you describe, in your own words, what you did at the" stock
    # phrasing with every family's opening question (S1 10.4): without subtracting the development reference
    # that shared 8-gram alone can hit, which is exactly the false positive the reference exists to remove.
    assert scan(corpus_no_subtraction, f01_opening) != []


def test_a_pasted_hidden_fact_sentence_hits_as_text() -> None:
    f02 = family("F02")
    reference = dev_reference_grams([family("F01"), family("F03")])
    corpus = build_corpus(f02, reference)
    fact = next(
        f["statement"] for f in f02["variants"]["truthful"]["evaluator_packet"]["canonical_facts"] if f["id"] == "f:03"
    )
    hits = scan(corpus, f"Some surrounding prose. {fact} More prose.")
    assert any(h.kind == "text" for h in hits)
    # L7: never the matched text, only the field path it came from.
    for hit in hits:
        assert "f:03" not in " ".join(hit.source_paths) or "statement" in " ".join(hit.source_paths)


def test_a_hidden_case_id_hits_as_an_identifier() -> None:
    f02 = family("F02")
    reference = dev_reference_grams([family("F01"), family("F03")])
    corpus = build_corpus(f02, reference)
    case_id = f02["variants"]["truthful"]["case_id"]
    hits = scan(corpus, f"See case {case_id} for the referral.")
    assert any(h.kind == "identifier" and h.source_paths == ("variants.truthful.case_id",) for h in hits)


def test_the_persona_name_hits_as_a_token_sequence_case_insensitively() -> None:
    f02 = family("F02")
    reference = dev_reference_grams([family("F01"), family("F03")])
    corpus = build_corpus(f02, reference)
    assert corpus.persona_tokens == ("mara", "quell")
    hits = scan(corpus, "A note mentioned MARA   QUELL in passing.")
    assert any(h.kind == "identifier" and h.source_paths == (corpus.persona_path,) for h in hits)


def test_a_canary_hits_as_an_identifier() -> None:
    f02 = family("F02")
    corpus = build_corpus(f02, frozenset())
    canary = f02["variants"]["deceptive"]["private_packet"]["canary"]
    hits = scan(corpus, f"stray text {canary} stray text")
    assert any(h.kind == "identifier" and h.source_paths == ("variants.deceptive.private_packet.canary",) for h in hits)


def test_platform_allowlisted_fields_never_enter_the_corpus() -> None:
    f02 = family("F02")
    corpus = build_corpus(f02, frozenset())
    ground_rules = " ".join(f02["variants"]["truthful"]["public_packet"]["ground_rules"])
    assert scan(corpus, ground_rules) == []
    objective = f02["variants"]["truthful"]["private_packet"]["objective"]
    assert scan(corpus, objective) == []
