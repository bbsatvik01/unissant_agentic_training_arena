"""Builders for the scorer tests: recorded referee outputs (zero model calls) and stored card.v1 payloads."""

from __future__ import annotations

import copy
from collections.abc import Iterable, Sequence
from typing import Any

import numpy as np

from arena_core.contracts.adapter import Card, adapt_card
from arena_core.contracts.citations import Record, Turn, content_text
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import (
    CitationVerdict,
    FlagVerdict,
    FollowupVerdict,
    RefereeSubjectReport,
    SubcheckVerdict,
)
from arena_core.scoring.flags import TrialRows

WORK_ITEM = "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
SHA = "a" * 64

# ---------------------------------------------------------------- the worked case FAC-DEV-01 (S3 2.10)

REC02_CONTENT = {
    "body": "Lab B panel alarm log for the evening of the entry.",
    "table": {
        "columns": ["Time", "Panel", "Event"],
        "rows": [["21:00-22:30", "Lab B", "Lab B panel: no alarm events 21:00-22:30, 2026-03-14."]],
    },
}
DOC01_CONTENT = {"body": "Badge record: Lab B entry at 21:40 on 2026-03-14 by the lab technician."}


def records(rec02_after: int | None = 3) -> dict[str, Record]:
    out = {"doc-01": Record(content_text(DOC01_CONTENT))}
    if rec02_after is not None:
        out["rec-02"] = Record(content_text(REC02_CONTENT), released_after=rec02_after)
    return out


def trial(answers: dict[int, str], rec02_after: int | None = 3) -> TrialRows:
    return TrialRows({n: Turn(a) for n, a in answers.items()}, records(rec02_after))


# ---------------------------------------------------------------- referee outputs


def fv(turn: int, qtype: str, **checks: bool) -> FollowupVerdict:
    """One per-question verdict; every check passes unless named False."""
    base = {
        "not_leading": True,
        "well_framed": True,
        "no_loaded_wording": True,
        "on_objective": True,
        "builds_on_previous": True,
    }
    base.update(checks)
    return FollowupVerdict.model_validate({"turn_id": f"t{turn:02d}", "question_type": qtype, **base})


def sub(check: str, result: str, turns: Iterable[int] = ()) -> SubcheckVerdict:
    return SubcheckVerdict.model_validate({"id": check, "result": result, "turn_ids": [f"t{t:02d}" for t in turns]})


def subs(**results: str) -> list[SubcheckVerdict]:
    """`subs(c2a="pass", ...)`: keyword `cNx` -> check `Nx`."""
    return [sub(k[1:], v) for k, v in results.items()]


def cites(**supports: bool) -> tuple[CitationVerdict, ...]:
    """`cites(t04=True, rec_02=True)`."""
    return tuple(
        CitationVerdict.model_validate({"cite": k.replace("_", "-"), "supports_basis": v}) for k, v in supports.items()
    )


def finding(**overrides: object) -> StoredFinding:
    base: dict[str, Any] = {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [],
        "cited_records": [],
        "corroboration_needed": ["the work order"],
        "rationale": "The reason for entry is not yet established.",
        "alternative_explanations": None,
        "last_revised_turn": None,
    }
    base.update(overrides)
    return StoredFinding.model_validate(base)


def judgment(turn: int, **overrides: object) -> dict[str, Any]:
    out: dict[str, Any] = {
        "turn_id": f"t{turn:02d}",
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
    if overrides.get("label") == "evasion":
        out["eva_subtype"] = "appeal_to_routine"
    if overrides.get("label") == "poorly_framed_question":
        out["pfq_reason"] = "compound"
    out.update(overrides)
    return out


def report(turns: list[dict[str, Any]], conflicts: Sequence[tuple[int, list[int]]] = ()) -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": turns,
            "trajectory": {
                "self_consistent": not conflicts,
                "conflicts": [
                    {"turn_id": f"t{later:02d}", "earlier_turn_ids": [f"t{e:02d}" for e in earlier]}
                    for later, earlier in conflicts
                ],
            },
        }
    )


def verdict(ref: str, **overrides: bool) -> FlagVerdict:
    base = {"quote_relevant": True, "claim_holds": True, "content_based": True, "no_outside_facts": True}
    base.update(overrides)
    return FlagVerdict.model_validate({"flag_ref": ref, **base})


# ---------------------------------------------------------------- stored card.v1 payloads (S2 4.1)


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
    if kind in ("gap", "non_responsive", "possible_evasion"):
        out["missing_fact"] = "the task that required entry"
    out.update(claim)
    return out


def stored_card(turn: int, flags: list[dict[str, Any]], demeanor: tuple[int, ...] = (), valid: bool = True) -> Card:
    """A `coach_card` payload read through the one adapter; `demeanor` lists 1-based flag indexes the S2 4.4
    lexicon marked."""
    refs = [f"t{turn:02d}.f{i}" for i in range(1, len(flags) + 1)]
    payload: dict[str, Any] = {
        "schema_version": "card.v1",
        "turn_id": f"t{turn:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open question."},
        "answer_category": "responsive",
        "flags": [{**copy.deepcopy(f), "flag_ref": r} for f, r in zip(flags, refs, strict=True)],
        "follow_up": {
            "question": "What task required entry?",
            "tactic": "funnel_probe",
            "purpose": "Ask for the task.",
            "record_request": None,
        },
        "finding": {
            **finding().model_dump(),
            "last_revised_turn": turn,
        },
        "boundary_notice": False,
        "commit_requested": False,
        "card_seq": turn,
        "turn_no": turn,
        "candidate_sha256": SHA,
        "validation": {
            "valid": valid,
            "flags": {
                r: {"citation_ok": True, "demeanor_based": i in demeanor, "duplicate": False}
                for i, r in enumerate(refs, start=1)
            },
            "demeanor_in_rationale": False,
        },
        "latency_ms": 1500,
        "work_item": WORK_ITEM,
        "transcript_version": 2 * turn,
    }
    return adapt_card(payload)


def ri(rng: np.random.Generator, lo: int, hi: int) -> int:
    """A seeded integer in [lo, hi] for the property tests (numpy's generator, not `random`)."""
    return int(rng.integers(lo, hi + 1))
