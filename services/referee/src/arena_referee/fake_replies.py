"""Canned referee replies for `ARENA_MODEL_MODE=fake` (S5 10.4): zero-spend, schema-valid ref_subj.v5 and
ref_asst.v2, written from the request itself -- the same pattern as `packages/core/arena_core/turns/
fake_coach.py` (WP-13): a fixed reply cannot serve every trial, since R1 must judge every transcript turn
and R2 (or R3's investigator call) must answer exactly the flags, follow-ups and citations the request
actually names. A reply that does not match the request's own `RefAsstContext`/`RefSubjContext` fails the
port's structured-output validation and repairs into a `ProviderFailedError` (a 502 at the route) instead
of succeeding -- these exist so a local fake run exercises the whole pipeline end to end.

`referee_subject` and `r3_subject` share `RefereeSubjectReport`'s schema title; `referee_assistant` and
`r3_investigator` share `RefereeAssistantReport`'s -- one reply function per schema serves all four
purposes, keyed here exactly as `FakeAdapter.canned` expects (S2 7.1-7.3, 7.5).
"""

from __future__ import annotations

import json
import re

from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.providers.types import ModelRequest
from arena_core.scoring.rubric import CHECKS

MIN_QUOTE_WORDS = 3

_ANSWER_LINE = re.compile(r"^(t\d{2}) Subject: (.+)$", re.MULTILINE)
_INVESTIGATOR_LINE = re.compile(r"^(t\d{2}) Investigator: ", re.MULTILINE)
_FLAG_REF_LINE = re.compile(r"^(t\d{2}\.f\d) \|", re.MULTILINE)
_FOLLOWUP_LINE = re.compile(r"^(t\d{2}) \|", re.MULTILINE)
_CITATION_LINE = re.compile(r"^(t\d{2}|rec-\d{2}|doc-0[1-4])$", re.MULTILINE)

# Every rubric sub-check an assistant report must answer once (S2 7.3; S3 2.11): fixed by the dev rubric's
# own registry, never by the request's content, so there is nothing to extract from the prompt for this one.
_REQUIRED_SUBCHECK_IDS = sorted({s for ids in CHECKS.values() for s in ids} - PER_QUESTION_SUBCHECKS)


def _user(request: ModelRequest) -> str:
    return request.messages[-1].text if request.messages else ""


def _quote_of(answer: str) -> str:
    """A verbatim, >= 3-word prefix of `answer` (S2 4.4.1's `quote_ok`, MIN_QUOTE_WORDS), or the whole
    answer when it is shorter -- always a real quote, never a label the quote-check would blank."""
    words = answer.split()
    return answer if len(words) <= MIN_QUOTE_WORDS else " ".join(words[:MIN_QUOTE_WORDS])


def subject_reply(request: ModelRequest) -> str:
    """ref_subj.v5: one clean, responsive judgment per transcript turn, each quoting a real span of that
    turn's own answer (so the quote check passes and the label is never a generic "no quote given")."""
    text = _user(request)
    turns = [
        {
            "turn_id": turn_id,
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
            "evidence_quote": _quote_of(answer.strip()),
        }
        for turn_id, answer in _ANSWER_LINE.findall(text)
    ]
    report = {"schema_version": "ref_subj.v5", "turns": turns, "trajectory": {"self_consistent": True, "conflicts": []}}
    return json.dumps(report)


def assistant_reply(request: ModelRequest) -> str:
    """ref_asst.v2: a flag-support, follow-up and citation verdict for exactly what the request names (the
    rater's RefAsstContext checks every one is answered once and none extra), plus every rubric sub-check
    this dev placeholder defines, each passing -- a clean, unremarkable interview in fake mode."""
    text = _user(request)
    flags = [
        {"flag_ref": ref, "quote_relevant": True, "claim_holds": True, "content_based": True, "no_outside_facts": True}
        for ref in _FLAG_REF_LINE.findall(text)
    ]
    followups = [
        {
            "turn_id": turn_id,
            "question_type": "open",
            "not_leading": True,
            "well_framed": True,
            "no_loaded_wording": True,
            "on_objective": True,
            "builds_on_previous": True,
        }
        for turn_id in _FOLLOWUP_LINE.findall(text)
    ]
    citations = [{"cite": cite, "supports_basis": True} for cite in _CITATION_LINE.findall(text)]
    subchecks = [{"id": sub_id, "result": "pass", "turn_ids": []} for sub_id in _REQUIRED_SUBCHECK_IDS]
    report = {
        "schema_version": "ref_asst.v2",
        "flags": flags,
        "followups": followups,
        "citations": citations,
        "subchecks": subchecks,
    }
    return json.dumps(report)


# Schema title -> reply writer, for `providers.mode.model_adapter(canned=...)`.
FAKE_REFEREE_REPLIES = {"RefereeSubjectReport": subject_reply, "RefereeAssistantReport": assistant_reply}
