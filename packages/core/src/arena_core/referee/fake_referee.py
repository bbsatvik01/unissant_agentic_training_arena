"""Canned referee replies for `ARENA_MODEL_MODE=fake` (S5 10.4): zero-spend, schema-valid ref_subj.v5 and
ref_asst.v2, written from the request itself -- the same pattern as `packages/core/arena_core/turns/
fake_coach.py` (WP-13): a fixed reply cannot serve every trial, since R1 must judge every transcript turn
and R2 (or R3's investigator call) must answer exactly the flags, follow-ups and citations the request
actually names. A reply that does not match the request's own `RefAsstContext`/`RefSubjContext` fails the
port's structured-output validation and repairs into a `ProviderFailedError` (a 502 at the route) instead
of succeeding -- these exist so a local fake run exercises the whole pipeline end to end.

The one fake referee module (WP-14/WP-17): `referee_subject`/`r3_subject` share
`RefereeSubjectReport`'s schema title, and `referee_assistant`/`r3_investigator` share
`RefereeAssistantReport`'s, so one reply function per schema serves R1, R2 and both of R3's calls -- keyed
here exactly as `FakeAdapter.canned` expects (S2 7.1-7.3, 7.5). Shared under `arena_core` (not a service
package) because arena-referee and arena-tournament both construct a `FakeAdapter` in fake mode, and
`check_roles` refuses arena-tournament importing arena-referee's own package directly (S5 1.2 item 2).
"""

from __future__ import annotations

import json
import re

from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.providers.types import ModelRequest
from arena_core.scoring.rubric import CHECKS

MIN_QUOTE_WORDS = 3

# S2 1's salted untrusted-data boundary (agents/untrusted.py): every field drawn from raw case content --
# records, documents, the transcript, flags, follow-ups -- reaches the prompt only inside
# `<untrusted_{kind}_{salt}>...</untrusted_{kind}_{salt}>`, salt a fresh 8 hex chars per call. Extracting a
# turn/flag/follow-up line from the RAW prompt text (scanning end to end) risks matching the same line shape
# inside a DIFFERENT section -- a record's or an initial document's own body can legitimately contain a line
# that reads like "doc-01" alone, or "t01 | ...", or "t01 Subject: ..." -- which would make the reply answer
# something never actually asked and fail RefAsstContext/RefSubjContext's own completeness check. Each
# extractor below is scoped to its own tagged block first; nothing is read outside it.
_SALT = r"[0-9a-f]{8}"
_ANSWER_LINE = re.compile(r"^(t\d{2}) Subject: (.+)$", re.MULTILINE)
_FLAG_REF_LINE = re.compile(r"^(t\d{2}\.f\d) \|", re.MULTILINE)
_FOLLOWUP_LINE = re.compile(r"^(t\d{2}) \|", re.MULTILINE)
_CITATION_LINE = re.compile(r"^(t\d{2}|rec-\d{2}|doc-0[1-4])$", re.MULTILINE)

# Every rubric sub-check an assistant report must answer once (S2 7.3; S3 2.11): fixed by the dev rubric's
# own registry, never by the request's content, so there is nothing to extract from the prompt for this one.
_REQUIRED_SUBCHECK_IDS = sorted({s for ids in CHECKS.values() for s in ids} - PER_QUESTION_SUBCHECKS)


def _user(request: ModelRequest) -> str:
    return request.messages[-1].text if request.messages else ""


def _tagged(text: str, kind: str) -> str:
    """The one `<untrusted_{kind}_{salt}>...</untrusted_{kind}_{salt}>` block's own content, or "" if the
    request carries none -- never anything outside it."""
    match = re.search(rf"<untrusted_{kind}_{_SALT}>\n(.*?)\n</untrusted_{kind}_{_SALT}>", text, re.DOTALL)
    return match.group(1) if match else ""


def _citations_block(text: str) -> str:
    """`finding_citations` (referee_prompts._citation_lines) is rendered directly, not inside an untrusted
    tag: it is code-derived from a validated `StoredFinding`'s own `cited_turns`/`cited_records`, never raw
    case text (S2 1's "trusted blocks carry only code-validated identifiers and counts"). Scoped instead by
    the assistant template's own static headers either side of it (assistant.user.v2.txt)."""
    match = re.search(r"Finding citations:\n(.*?)\n\nApplicability triggers:", text, re.DOTALL)
    return match.group(1) if match else ""


def _quote_of(answer: str) -> str:
    """A verbatim, >= 3-word prefix of `answer` (S2 4.4.1's `quote_ok`, MIN_QUOTE_WORDS), or the whole
    answer when it is shorter -- always a real quote, never a label the quote-check would blank."""
    words = answer.split()
    return answer if len(words) <= MIN_QUOTE_WORDS else " ".join(words[:MIN_QUOTE_WORDS])


def referee_subject_reply(request: ModelRequest) -> str:
    """ref_subj.v5 (R1 or `r3_subject`): one clean, responsive judgment per transcript turn, each quoting a
    real span of that turn's own answer (so the quote check passes and the label is never a generic "no
    quote given")."""
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
        for turn_id, answer in _ANSWER_LINE.findall(_tagged(text, "transcript"))
    ]
    report = {"schema_version": "ref_subj.v5", "turns": turns, "trajectory": {"self_consistent": True, "conflicts": []}}
    return json.dumps(report)


def referee_assistant_reply(request: ModelRequest) -> str:
    """ref_asst.v2 (R2 or `r3_investigator`): a flag-support, follow-up and citation verdict for exactly
    what the request names (RefAsstContext checks every one is answered once and none extra), plus every
    rubric sub-check this dev placeholder defines, each passing -- a clean, unremarkable interview."""
    text = _user(request)
    flags = [
        {"flag_ref": ref, "quote_relevant": True, "claim_holds": True, "content_based": True, "no_outside_facts": True}
        for ref in _FLAG_REF_LINE.findall(_tagged(text, "flags"))
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
        for turn_id in _FOLLOWUP_LINE.findall(_tagged(text, "followups"))
    ]
    citations = [{"cite": cite, "supports_basis": True} for cite in _CITATION_LINE.findall(_citations_block(text))]
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
FAKE_REFEREE_REPLIES = {
    "RefereeSubjectReport": referee_subject_reply,
    "RefereeAssistantReport": referee_assistant_reply,
}
