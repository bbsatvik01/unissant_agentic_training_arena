"""Isolation-gate evidence assembly (S3 9): FX-I01, FX-I02 through WP-16's evidence layer, on top of WP-15's
pure `isolation_result`/`canary_audit` (already covered end to end in `scoring/test_ranking.py`)."""

from __future__ import annotations

import hashlib

import pytest

from arena_core.referee.isolation import (
    IsolationEvidence,
    combined_corpus_scan_evidence,
    corpus_scan_evidence,
    count_canary_hits,
    ig4_evidence,
    ig4_report,
    ig5_evidence,
    ig6_evidence,
    report_evidence,
)
from arena_core.scenario.corpus import Family, build_corpus, family_canaries


def hidden_family() -> Family:
    return {
        "family_id": "FHID",
        "variants": {
            "truthful": {
                "case_id": "C-TRUTH0001",
                "public_packet": {"presentation": {"display_name": "Jo Rivers"}, "ground_rules": ["x"]},
                "private_packet": {"canary": "CANARY-aaa111", "role": "truthful"},
                "evaluator_packet": {"canary": "CANARY-bbb222", "variant": "truthful"},
            },
            "deceptive": {
                "case_id": "C-DECEP0002",
                "public_packet": {"presentation": {"display_name": "Jo Rivers"}, "ground_rules": ["x"]},
                "private_packet": {"canary": "CANARY-ccc333", "role": "deceptive"},
                "evaluator_packet": {"canary": "CANARY-ddd444", "variant": "deceptive"},
            },
        },
    }


def test_fx_i01_isolation_fail_blocks_ranking_through_the_evidence_layer() -> None:
    passing = report_evidence(passed=True, report_text="pgtap ok")
    failing = report_evidence(passed=False, report_text="pgtap: 1 failure")
    evidence = IsolationEvidence(
        items={
            "IG-1": passing,
            "IG-2": failing,  # the failing item (FX-I01: "IG-2 failed")
            "IG-3": passing,
            "IG-4": passing,
            "IG-5": passing,
            "IG-6": passing,
        }
    )
    result = evidence.result()
    assert result.passed is False


def test_fx_i02_a_canary_hit_attributed_to_one_candidate_fails_the_gate_for_all() -> None:
    canary = ig6_evidence({"A1": 1, "A2": 0, "A3": 0})
    assert canary.passed is False
    assert canary.culprit == "A1"

    clean = ig6_evidence({"A1": 0, "A2": 0, "A3": 0})
    assert clean.passed is True
    assert clean.culprit is None


def test_ig6_rejects_a_negative_count_rather_than_let_it_cancel_a_real_hit() -> None:
    # Without the guard, canary_audit's sum(...) == 0 would let a -1 cancel a genuine +1 hit and pass.
    with pytest.raises(ValueError, match="negative"):
        ig6_evidence({"A1": 1, "A2": -1})


def test_family_canaries_are_exactly_the_four_canary_strings() -> None:
    canaries = family_canaries(hidden_family())
    assert canaries == {"CANARY-aaa111", "CANARY-bbb222", "CANARY-ccc333", "CANARY-ddd444"}


def test_count_canary_hits_scans_each_candidate_s_own_texts_only() -> None:
    canaries = family_canaries(hidden_family())
    hits = count_canary_hits(
        canaries,
        {
            "A1": ["a clean finding", "CANARY-aaa111 leaked here"],
            "A2": ["nothing suspicious"],
        },
    )
    assert hits == {"A1": 1, "A2": 0}


def test_count_canary_hits_counts_every_occurrence_in_every_text() -> None:
    canaries = family_canaries(hidden_family())
    hits = count_canary_hits(canaries, {"A1": ["CANARY-aaa111 and CANARY-bbb222", "CANARY-aaa111 again"]})
    assert hits == {"A1": 3}


def test_ig4_passes_only_when_the_seal_verifies_and_nothing_scans_hidden() -> None:
    corpus = build_corpus(hidden_family(), frozenset())
    clean_scan = corpus_scan_evidence(corpus, {"prompts/coach.md": "All cases are synthetic."})
    passed, _ = ig4_evidence(seal_verifies=True, scan=clean_scan)
    assert passed is True

    passed, _ = ig4_evidence(seal_verifies=False, scan=clean_scan)
    assert passed is False

    dirty_scan = corpus_scan_evidence(corpus, {"prompts/leak.md": "Case C-DECEP0002 shows CANARY-ccc333."})
    assert dirty_scan.passed is False
    passed, _ = ig4_evidence(seal_verifies=True, scan=dirty_scan)
    assert passed is False


def test_ig4_evidence_distinguishes_different_hit_paths_with_the_same_count() -> None:
    # Codex finding #12: `hit_paths` must be part of the hashed evidence -- a family_id leak and a persona-
    # name leak, each with exactly one hit in one file, must never hash identically; an operator diagnosing
    # a failure needs to tell WHICH field leaked, not just that something did.
    corpus = build_corpus(hidden_family(), frozenset())
    family_id_leak = corpus_scan_evidence(corpus, {"prompts/a.md": "FHID"})
    persona_leak = corpus_scan_evidence(corpus, {"prompts/a.md": "Jo Rivers"})
    assert family_id_leak.hit_paths != persona_leak.hit_paths
    _, hash_a = ig4_evidence(seal_verifies=True, scan=family_id_leak)
    _, hash_b = ig4_evidence(seal_verifies=True, scan=persona_leak)
    assert hash_a != hash_b


def test_ig4_report_never_carries_the_matched_text() -> None:
    corpus = build_corpus(hidden_family(), frozenset())
    scan = corpus_scan_evidence(corpus, {"prompts/leak.md": "Case C-DECEP0002 shows CANARY-ccc333."})
    assert "CANARY-ccc333" not in scan.report_text
    assert "C-DECEP0002" not in scan.report_text
    assert scan.hit_paths  # the field paths that matched are reported instead


def test_the_ig4_report_is_exactly_what_the_hash_covers_and_names_paths_not_text() -> None:
    corpus = build_corpus(hidden_family(), frozenset())
    scan = corpus_scan_evidence(corpus, {"prompts/leak.md": "Case C-DECEP0002 shows CANARY-ccc333."})
    report = ig4_report(seal_verifies=True, scan=scan)
    _, evidence_hash = ig4_evidence(seal_verifies=True, scan=scan)
    assert hashlib.sha256(report.encode()).hexdigest() == evidence_hash
    assert "prompts/leak.md|" in report
    assert all(path in report for path in scan.hit_paths)
    assert "CANARY-ccc333" not in report
    assert "C-DECEP0002" not in report


def test_ig5_fails_closed_on_any_unverified_commitment_or_chain_break() -> None:
    passed, _ = ig5_evidence(chain_verifies=True, corpus_seal_verifies=True, commitments={"t1": True, "t2": True})
    assert passed is True
    passed, _ = ig5_evidence(chain_verifies=True, corpus_seal_verifies=True, commitments={"t1": True, "t2": False})
    assert passed is False
    passed, _ = ig5_evidence(chain_verifies=False, corpus_seal_verifies=True, commitments={})
    assert passed is False


def second_hidden_family() -> Family:
    return {
        "family_id": "FHID2",
        "variants": {
            "truthful": {
                "case_id": "C-OTHER0001",
                "public_packet": {"presentation": {"display_name": "Sam Okafor"}, "ground_rules": ["x"]},
                "private_packet": {"canary": "CANARY-eee555", "role": "truthful"},
                "evaluator_packet": {"canary": "CANARY-fff666", "variant": "truthful"},
            },
            "deceptive": {
                "case_id": "C-OTHER0002",
                "public_packet": {"presentation": {"display_name": "Sam Okafor"}, "ground_rules": ["x"]},
                "private_packet": {"canary": "CANARY-ggg777", "role": "deceptive"},
                "evaluator_packet": {"canary": "CANARY-hhh888", "variant": "deceptive"},
            },
        },
    }


def test_combined_scan_catches_a_second_family_s_persona_a_single_corpus_would_miss() -> None:
    corpus_1 = build_corpus(hidden_family(), frozenset())
    corpus_2 = build_corpus(second_hidden_family(), frozenset())
    # A scan against only the first family's corpus never sees the second family's persona name leaking.
    single = corpus_scan_evidence(corpus_1, {"prompts/leak.md": "A note mentioned Sam Okafor by name."})
    assert single.passed is True
    combined = combined_corpus_scan_evidence(
        (corpus_1, corpus_2), {"prompts/leak.md": "A note mentioned Sam Okafor by name."}
    )
    assert combined.passed is False


def test_report_evidence_hashes_the_report_text_deterministically() -> None:
    a = report_evidence(passed=True, report_text="same text")
    b = report_evidence(passed=True, report_text="same text")
    c = report_evidence(passed=True, report_text="different text")
    assert a == b
    assert a[1] != c[1]
