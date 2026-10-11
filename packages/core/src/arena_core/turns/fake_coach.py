"""Canned coach replies for `ARENA_MODEL_MODE=fake` (S5 10.4): zero-spend, schema-valid card.v1 and deep.v1.

A card must name the exchange it was requested for and a deep update must list every released record, so a
fixed text cannot serve every turn: each reply is written from the request itself (the user message's
"Exchange N of 12." line and the record ids inside its released-records block). The cards carry no flag, so no
quote check can fail; they exist so a local run exercises the whole pipeline, not to coach.
"""

from __future__ import annotations

import json
import re

from arena_core.providers.types import ModelRequest

_EXCHANGE = re.compile(r"^Exchange (\d+) of \d+\.", re.MULTILINE)
_RECORDS = re.compile(r"<untrusted_records_\w+>(.*?)</untrusted_records_\w+>", re.DOTALL)
_RECORD_ID = re.compile(r"\brec-0[1-6]\b")


def _user(request: ModelRequest) -> str:
    return request.messages[-1].text if request.messages else ""


def _exchange(request: ModelRequest) -> int:
    match = _EXCHANGE.search(_user(request))
    return int(match.group(1)) if match else 1


def _finding(n: int) -> dict[str, object]:
    return {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [n],
        "cited_records": [],
        "corroboration_needed": ["check the account against the case records"],
        "rationale": "The account so far has not been tested against the records.",
    }


def card_reply(request: ModelRequest) -> str:
    n = _exchange(request)
    card = {
        "schema_version": "card.v1",
        "turn_id": f"t{n:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open, neutral question."},
        "answer_category": "responsive",
        "flags": [],
        "follow_up": {
            "question": "Can you walk me through what happened next, step by step?",
            "tactic": "funnel_probe",
            "purpose": "Get the next part of the account in the subject's own words.",
            "record_request": None,
        },
        "finding": _finding(n),
        "boundary_notice": False,
        "commit_requested": False,
    }
    return json.dumps(card)


def deep_reply(request: ModelRequest) -> str:
    n = _exchange(request)
    block = _RECORDS.search(_user(request))
    released = sorted(set(_RECORD_ID.findall(block.group(1)))) if block else []
    update = {
        "schema_version": "deep.v1",
        "as_of_turn": f"t{n:02d}",
        "finding": _finding(n),
        "evidence_coverage": [{"record_id": r, "status": "raised_not_tested", "turn_ids": []} for r in released],
        "open_gaps": [],
        "disclosure_plan": {"record_id": None, "step": "hold"},
    }
    return json.dumps(update)


# Schema title -> reply writer, for `providers.mode.model_adapter(canned=...)`.
FAKE_COACH_REPLIES = {"CoachingCard": card_reply, "DeepUpdate": deep_reply}
