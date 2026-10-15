"""The playbook's reflector (ACE's critic role, D-036): one Gemini call through the agent port that turns a run's
train-side failures and the human-versus-referee label disagreements into short, general lessons. The curator
(`arena_core.coachgym.playbook.curate`) decides what is filed; a human decides what is approved. Holdout examples
are never shown to the reflector.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from arena_core.coachgym.examples import Example
from arena_core.coachgym.metric import Grade
from arena_core.coachgym.playbook import MAX_CHARS, Proposal
from arena_core.contracts.rendered import clean
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, CallContext, CallType, Message, ThinkingLevel, VertexModel
from scripts.coach_gym.evaluate import Meter, run_metered
from scripts.coach_gym.optimize import HoldoutLeakError

PURPOSE_REFLECT = "coach_gym.reflect"
MAX_FAILURES = 12
MAX_DISAGREEMENTS = 8
REFLECTOR_SYSTEM = (
    "You are the critic of a coaching assistant that watches investigative interviews and writes, after each"
    " answer, flags on the subject's answers with exact quotes, a running finding and one neutral follow-up"
    " question. Below are cases where its card fell short, and turns where a human rater and the automatic referee"
    " disagreed about whether an answer was evasive. Propose at most five short, general lessons (one or two"
    " sentences each) that would help on unseen cases. A lesson never names a case, a person, an id or a quote,"
    " never relies on demeanor or tone, and never tells the assistant to flag without a citation. For each lesson"
    " list the example ids (the bracketed ids below) it comes from."
)


class LessonDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, StringConstraints(min_length=1, max_length=MAX_CHARS)]
    example_ids: Annotated[list[Annotated[str, StringConstraints(max_length=64)]], Field(max_length=5)]


class GymLessons(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lessons: Annotated[list[LessonDraft], Field(max_length=5)]


@dataclass(frozen=True)
class ReflectorInput:
    text: str
    trial_of: dict[str, str]  # example id -> trial id, every example shown


def _turn(example: Example, n: int) -> str:
    rows = [r for r in example.context["transcript"] if int(r["turn_no"]) == n]
    if not rows:
        return ""
    return f"Q: {clean(rows[0]['question'])[:300]} A: {clean(rows[0]['answer'])[:400]}"


def reflector_input(graded: Sequence[tuple[Example, Grade]], pool: Sequence[Example]) -> ReflectorInput:
    """The worst-scoring graded (non-canary) examples and the disagreement turns of `pool`, train side only."""
    for example in [*(e for e, _ in graded), *pool]:
        if example.partition == "holdout":
            msg = "a holdout example reached the reflector"
            raise HoldoutLeakError(msg)
    worst = sorted(
        ((e, g) for e, g in graded if not e.canary and g.score < 1), key=lambda p: (p[1].score, p[0].example_id)
    )
    seen: set[str] = set()
    lines: list[str] = []
    trial_of: dict[str, str] = {}
    for e, g in worst:
        if e.example_id in seen or len(seen) >= MAX_FAILURES:
            continue
        seen.add(e.example_id)
        trial_of[e.example_id] = e.trial_id
        lines.append(f"[{e.example_id[:16]}] exchange {e.turn}. {_turn(e, e.turn)}\nFeedback: {g.feedback}")
    shown = 0
    for e in sorted(pool, key=lambda x: x.example_id):
        for d in e.reference.disagreements:
            if d.turn != e.turn or shown >= MAX_DISAGREEMENTS or e.canary:
                continue
            shown += 1
            trial_of[e.example_id] = e.trial_id
            lines.append(
                f"[{e.example_id[:16]}] turn t{d.turn:02d}: the referee labeled it {d.referee}, a human rater"
                f" labeled it {d.human}. {_turn(e, d.turn)}"
            )
    return ReflectorInput("\n\n".join(lines), trial_of)


def proposals(drafts: GymLessons, shown: ReflectorInput) -> list[Proposal]:
    """Map the reflector's short ids (the bracketed 16-character prefixes) back to full example ids."""
    full = {eid[:16]: eid for eid in shown.trial_of}
    return [Proposal(d.text, tuple(full[i] for i in d.example_ids if i in full)) for d in drafts.lessons]


async def reflect(port: AgentPort, meter: Meter, run_id: str, shown: ReflectorInput) -> list[Proposal]:
    if not shown.text:
        return []
    call = AgentCall(
        model=VertexModel.FLASH_LITE_35,
        thinking=ThinkingLevel.MINIMAL,
        system=REFLECTOR_SYSTEM,
        messages=(Message("user", shown.text),),
        schema=GymLessons,
        context=CallContext(
            call_type=CallType.FINAL,
            purpose=PURPOSE_REFLECT,
            step_key=f"coach_gym:{run_id}:lessons:{uuid4().hex}",
            split="dev",
        ),
    )
    value, _ = await run_metered(port, meter, call)
    return [] if value is None else proposals(value, shown)
