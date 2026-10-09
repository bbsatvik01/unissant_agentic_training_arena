"""Builders for stored card.v1 payloads used by the contract tests (S2 4.1 with its code-filled fields)."""

from __future__ import annotations

import copy
from typing import Any

WORK_ITEM = "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
SHA = "a" * 64


def flag(kind: str, turn_id: str, quote: str, **claim: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "kind": kind,
        "turn_id": turn_id,
        "quote": quote,
        "missing_fact": None,
        "conflict_turn_id": None,
        "conflict_quote": None,
        "conflict_record_id": None,
        "conflict_record_quote": None,
    }
    out.update(claim)
    return out


def finding(**overrides: object) -> dict[str, Any]:
    out: dict[str, Any] = {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [],
        "cited_records": [],
        "corroboration_needed": ["the work order"],
        "rationale": "The reason for entry is not yet established.",
    }
    out.update(overrides)
    return out


def model_card(turn: int, flags: list[dict[str, Any]], **overrides: object) -> dict[str, Any]:
    """card.v1 as the model writes it."""
    out: dict[str, Any] = {
        "schema_version": "card.v1",
        "turn_id": f"t{turn:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open question."},
        "answer_category": "responsive",
        "flags": copy.deepcopy(flags),
        "follow_up": {
            "question": "What task required entry?",
            "tactic": "funnel_probe",
            "purpose": "Ask for the task.",
            "record_request": None,
        },
        "finding": finding(),
        "boundary_notice": False,
        "commit_requested": False,
    }
    out.update(overrides)
    return out


def stored_card(
    turn: int,
    flags: list[dict[str, Any]],
    demeanor: tuple[int, ...] = (),
    valid: bool = True,
    **overrides: object,
) -> dict[str, Any]:
    """A `coach_card` payload: the model card plus code-filled fields; `demeanor` lists 1-based flag indexes
    the S2 4.4 lexicon marked."""
    card = model_card(turn, flags, **overrides)
    refs = [f"t{turn:02d}.f{i}" for i in range(1, len(flags) + 1)]
    for f, ref in zip(card["flags"], refs, strict=True):
        f["flag_ref"] = ref
    card["finding"] = {**card["finding"], "alternative_explanations": None, "last_revised_turn": turn}
    card.update(
        card_seq=turn,
        turn_no=turn,
        candidate_sha256=SHA,
        validation={
            "valid": valid,
            "flags": {
                ref: {"citation_ok": True, "demeanor_based": i in demeanor, "duplicate": False}
                for i, ref in enumerate(refs, start=1)
            },
            "demeanor_in_rationale": False,
        },
        latency_ms=1500,
        work_item=WORK_ITEM,
        transcript_version=2 * turn,
    )
    return card


def judgment(turn: str, **overrides: object) -> dict[str, Any]:
    out: dict[str, Any] = {
        "turn_id": turn,
        "label": "responsive",
        "eva_subtype": None,
        "pfq_reason": None,
        "requested_fact_ids": [],
        "asked_fact_status": "known",
        "uncertainty_expressed": False,
        "innocent_explanation_offered": False,
        "record_conflict_ids": [],
        "no_contradiction": True,
        "no_invention": True,
        "violated_fact_ids": [],
        "uncertainty_respected": True,
        "disclosure_policy_respected": True,
        "in_character": True,
        "style_followed": True,
        "platform_attack": False,
        "evidence_quote": "",
    }
    out.update(overrides)
    return out
