"""Shared fixtures for the Coach Gym tests: dev trials built from the committed family F01 with a synthetic
transcript, cards built the way the gym stores them, and a fake coach whose behavior follows its strategy text."""

from __future__ import annotations

import json
import re
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

from arena_core.coachgym.examples import Example, Role, TrialRecord
from arena_core.coachgym.metric import CardRun
from arena_core.contracts.coaching import CoachingCard, StoredCard
from arena_core.providers.types import ModelRequest
from arena_core.turns.coach import CardMeta, coach_inputs, store_card

REPO = Path(__file__).resolve().parents[4]
FAMILY = json.loads((REPO / "cases/dev/F01.json").read_text(encoding="utf-8"))
EVASIVE = "I do not recall where I went after that, it was a long day."
PLAIN = "I logged work order {n} in the binder and then went on to the next room."
REC_01 = next(
    a for a in FAMILY["variants"]["truthful"]["evaluator_packet"]["evidence_artifacts"] if a["artifact_id"] == "rec-01"
)
MARKER = "Flag an answer that leaves out where the subject went as possible_evasion."
CANARY = FAMILY["variants"]["truthful"]["evaluator_packet"]["canary"]


def packet(role: Role, case_id: str | None = None) -> dict[str, Any]:
    out = dict(FAMILY["variants"][role]["public_packet"])
    if case_id is not None:
        out["case_id"] = case_id
    return out


@dataclass(frozen=True)
class Spec:
    family_code: str = "F01"
    split: str = "dev"
    turns: int = 4
    evasive: Sequence[int] = (2, 3)
    referee: Mapping[int, str] | None = None
    human: Mapping[int, str] | None = None
    case_id: str | None = None
    release_after: int | None = None


def trial(role: Role, spec: Spec | None = None) -> TrialRecord:
    """A trial on F01's `role` variant; on a deceptive trial the `evasive` turns get an evasive answer, and R1
    labels those turns evasion unless `referee` says otherwise."""
    spec = spec or Spec()
    family_code, split, turns, evasive = spec.family_code, spec.split, spec.turns, spec.evasive
    referee, human, case_id, release_after = spec.referee, spec.human, spec.case_id, spec.release_after
    bad = set(evasive) if role == "deceptive" else set()
    transcript = [
        {
            "turn_no": n,
            "question": f"What did you do at step {n} of the shift?",
            "answer": EVASIVE if n in bad else PLAIN.format(n=n),
        }
        for n in range(1, turns + 1)
    ]
    labels = (
        dict(referee)
        if referee is not None
        else {n: ("evasion" if n in bad else "responsive") for n in range(1, turns + 1)}
    )
    released = []
    if release_after is not None:
        released.append(
            {
                "record_id": "rec-01",
                "title": REC_01["title"],
                "content": REC_01["content"],
                "after_exchanges": release_after,
            }
        )
    return TrialRecord(
        trial_id=str(uuid4()),
        family_code=family_code,
        split=split,
        role=role,
        public_packet=packet(role, case_id),
        released=released,
        transcript=transcript,
        referee_labels=labels,
        human_labels=dict(human or {}),
    )


def _finding(n: int, deceptive: bool) -> dict[str, Any]:
    if deceptive:
        return {
            "label": "deceptive",
            "likelihood": "likely",
            "confidence": "moderate",
            "basis_flag_refs": [f"t{n:02d}.f1"],
            "cited_turns": [n],
            "cited_records": [],
            "corroboration_needed": [],
            "rationale": "The answer leaves out where the subject went, a point the subject could answer.",
        }
    return {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [n],
        "cited_records": [],
        "corroboration_needed": ["the work orders for that shift"],
        "rationale": "The account so far has not been tested against the records.",
    }


@dataclass(frozen=True)
class CardSpec:
    flag_turn: int | None = None
    quote: str = EVASIVE
    deceptive: bool = False
    missing_fact: str = "where the subject went next"
    follow_up: str = "Can you walk me through what happened next, step by step?"
    kind: str = "possible_evasion"


def card_dict(n: int, spec: CardSpec | None = None) -> dict[str, Any]:
    spec = spec or CardSpec()
    flag_turn, quote, deceptive = spec.flag_turn, spec.quote, spec.deceptive
    missing_fact, follow_up, kind = spec.missing_fact, spec.follow_up, spec.kind
    flags = []
    if flag_turn is not None:
        flags.append(
            {
                "kind": kind,
                "turn_id": f"t{flag_turn:02d}",
                "quote": quote,
                "missing_fact": missing_fact,
                "conflict_turn_id": None,
                "conflict_quote": None,
                "conflict_record_id": None,
                "conflict_record_quote": None,
            }
        )
    return {
        "schema_version": "card.v1",
        "turn_id": f"t{n:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open, neutral question."},
        "answer_category": "possible_evasion" if flags else "responsive",
        "flags": flags,
        "follow_up": {
            "question": follow_up,
            "tactic": "funnel_probe",
            "purpose": "Get the next step.",
            "record_request": None,
        },
        "finding": _finding(n, deceptive),
        "boundary_notice": False,
        "commit_requested": False,
    }


def stored(example: Example, raw: Mapping[str, Any]) -> StoredCard:
    """The card as the gym stores it: validated against the example's citation context, post-checked."""
    inputs = coach_inputs(example.context, "card", example.turn)
    card = CoachingCard.model_validate(raw, context=inputs.citations)
    return store_card(card, inputs, CardMeta(100, uuid4(), 0, "a" * 64))


def run_of(example: Example, raw: Mapping[str, Any], latency: int = 100, cost: str = "0.001") -> CardRun:
    return CardRun(stored(example, raw), None, latency, Decimal(cost))


_EXCHANGE = re.compile(r"^Exchange (\d+) of \d+\.", re.MULTILINE)


def strategic_card(request: ModelRequest) -> str:
    """A fake coach that flags the current evasive answer only when its strategy text carries `MARKER` (so a
    better strategy really does score better), and otherwise writes the plain fake card."""
    user = request.messages[-1].text
    n = int(m.group(1)) if (m := _EXCHANGE.search(user)) else 1
    line = re.search(rf"^t{n:02d} Subject: (.*)$", user, re.MULTILINE)
    evasive = line is not None and EVASIVE in line.group(1)
    if MARKER in request.system and evasive:
        return json.dumps(card_dict(n, CardSpec(flag_turn=n, deceptive=True)))
    return json.dumps(card_dict(n))


def instruction_with_marker(request: ModelRequest) -> str:
    """A fake reflection model that adds `MARKER` to the strategy it was shown."""
    user = request.messages[-1].text
    current = user[user.find("```") + 3 : user.find("```", user.find("```") + 3)].strip()
    return json.dumps({"instruction": f"{current}\n{MARKER}"})


def gym_root(tmp: Path) -> Path:
    """A repository root for gym tests: the committed prompts, manifests and holdout, nothing else."""
    root = tmp / "repo"
    shutil.copytree(REPO / "prompts", root / "prompts")
    (root / "coachlab").mkdir(parents=True)
    shutil.copy(REPO / "coachlab" / "holdout.json", root / "coachlab" / "holdout.json")
    return root
