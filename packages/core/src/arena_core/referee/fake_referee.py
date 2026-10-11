"""Canned referee replies for `ARENA_MODEL_MODE=fake` (S5 10.4): zero-spend, schema-valid ref_subj.v5 and
ref_asst.v2, so a fake-mode run exercises the real R1/R2 scoring pipeline (score_trial, score_corpus_trial,
score_replay_trial, WP-17) and not just a `ConfigError` ("no canned reply").

R1's report needs one entry per subject turn, in order (`RefSubjContext.subject_turn_ids`), and R2's needs
one entry per flag, follow-up, finding citation and non-per-question rubric sub-check
(`RefAsstContext`). A fixed reply cannot satisfy either, since both depend on the trial, so each reply is
read back from the request's own rendered prompt (`prompts/referee/subject.user.v1.txt` and
`assistant.user.v1.txt`), the same way `turns/fake_coach.py` reads a card's exchange number: every id the
report must cover is already printed in the request in a fixed, parseable place.

Every judgment is deliberately neutral (label `responsive`, every check `pass`/true, no conflicts): these
exist to exercise the pipeline end to end, not to coach or label realistically.
"""

from __future__ import annotations

import json
import re

from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.providers.types import ModelRequest
from arena_core.scoring.rubric import CHECKS

_LAST_SUBJECT_TURN = re.compile(r"t01 to (t\d{2})\b")
_UNTRUSTED_BLOCK = re.compile(r"<untrusted_{tag}_(\w+)>(.*?)</untrusted_{tag}_\1>", re.DOTALL)
_FOLLOWUP_TURN = re.compile(r"^(t\d{2})\s*\|", re.MULTILINE)
_CITATIONS_BLOCK = re.compile(r"Finding citations:\n(.*?)\n\nApplicability triggers:", re.DOTALL)
# Every rubric sub-check but the five answered per question through `FollowupVerdict`'s own fields, not
# `subchecks` (S2 7.3; a per-question id in `subchecks` is itself a validation error).
_OVERALL_SUBCHECKS = tuple(s for ids in CHECKS.values() for s in ids if s not in PER_QUESTION_SUBCHECKS)


def _user(request: ModelRequest) -> str:
    return request.messages[-1].text if request.messages else ""


def _untrusted_block(text: str, tag: str) -> str:
    pattern = re.compile(_UNTRUSTED_BLOCK.pattern.format(tag=re.escape(tag)), re.DOTALL)
    match = pattern.search(text)
    return match.group(2) if match else ""


def _turn_judgment(turn_id: str) -> dict[str, object]:
    return {
        "turn_id": turn_id,
        "label": "responsive",
        "eva_subtype": None,
        "pfq_reason": None,
        "requested_fact_ids": [],
        "asked_fact_status": "unknown",
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


def referee_subject_reply(request: ModelRequest) -> str:
    """ref_subj.v5 (S2 7.2): one neutral `responsive` judgment per subject turn (R1)."""
    match = _LAST_SUBJECT_TURN.search(_user(request))
    last_n = int(match.group(1)[1:]) if match else 1
    turns = [_turn_judgment(f"t{n:02d}") for n in range(1, last_n + 1)]
    report = {
        "schema_version": "ref_subj.v5",
        "turns": turns,
        "trajectory": {"self_consistent": True, "conflicts": []},
    }
    return json.dumps(report)


def _followup_verdicts(text: str) -> list[dict[str, object]]:
    block = _untrusted_block(text, "followups")
    return [
        {
            "turn_id": turn_id,
            "question_type": "open",
            "not_leading": True,
            "well_framed": True,
            "no_loaded_wording": True,
            "on_objective": True,
            "builds_on_previous": True,
        }
        for turn_id in _FOLLOWUP_TURN.findall(block)
    ]


def _citation_verdicts(text: str) -> list[dict[str, object]]:
    match = _CITATIONS_BLOCK.search(text)
    if match is None:
        return []
    lines = [line.strip() for line in match.group(1).splitlines() if line.strip() and line.strip() != "none"]
    return [{"cite": cite, "supports_basis": True} for cite in lines]


def referee_assistant_reply(request: ModelRequest) -> str:
    """ref_asst.v2 (S2 7.3): no flags (the fake card never proposes one), one neutral verdict per follow-up
    and per finding citation the request names, and every overall rubric sub-check `na` (R2, R3's
    `r3_investigator`)."""
    text = _user(request)
    subchecks = [{"id": sub_id, "result": "na", "turn_ids": []} for sub_id in _OVERALL_SUBCHECKS]
    report = {
        "schema_version": "ref_asst.v2",
        "flags": [],
        "followups": _followup_verdicts(text),
        "citations": _citation_verdicts(text),
        "subchecks": subchecks,
    }
    return json.dumps(report)


# Schema title -> reply writer, for `providers.mode.model_adapter(canned=...)`.
FAKE_REFEREE_REPLIES = {
    "RefereeSubjectReport": referee_subject_reply,
    "RefereeAssistantReport": referee_assistant_reply,
}
