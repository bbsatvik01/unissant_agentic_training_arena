"""ACE-style coaching playbook (D-036; arXiv:2510.04618): append-only lessons with human review.

The reflector (an LLM call, `scripts/coach_gym/reflect.py`) proposes short lessons from the train-side failures
of a run and from the turns where a human calibration label disagrees with the referee. The curator here is code:
it cleans each proposal, refuses one that names no source example from the reflector's own input, refuses a
reference-only string (canary tokens, holdout case ids), drops near-duplicates of a lesson already on file (ACE's
delta update, so the playbook grows without rewriting or collapsing what is there) and files the rest as
`pending`. Only a human moves a lesson to `approved` (or `rejected`); only approved lessons are rendered into a
new coach version's playbook section. kayba-ai/agentic-context-engine itself is not used: it requires litellm,
which the dependency policy bans; this is the curator step of its pattern, nothing more.
"""

from __future__ import annotations

import difflib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from arena_core.contracts.citations import normalize
from arena_core.contracts.rendered import clean
from arena_core.ids import sha256_hex

LessonStatus = Literal["pending", "approved", "rejected"]
MIN_CHARS = 20
MAX_CHARS = 300
MAX_RENDERED = 20
NEAR_DUPLICATE = 0.85  # difflib ratio at or above which a proposal repeats a lesson already on file
PLAYBOOK_HEADER = (
    "Coaching playbook. Human-approved lessons from earlier development runs. Apply them only when the transcript"
    " itself supports it; they never replace a citation."
)


class Lesson(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    lesson_id: str
    text: str = Field(min_length=MIN_CHARS, max_length=MAX_CHARS)
    candidate_id: str
    source_run_ids: tuple[str, ...]
    source_example_ids: tuple[str, ...] = Field(min_length=1)
    source_trial_ids: tuple[str, ...]
    created_at: str


@dataclass(frozen=True)
class Proposal:
    """One reflector proposal: the lesson text and the example ids it says it came from."""

    text: str
    example_ids: tuple[str, ...]


def _key(text: str) -> str:
    return normalize(text).casefold()


def lesson_id(text: str) -> str:
    return sha256_hex(_key(text))[:16]


def _near(text: str, others: Iterable[str]) -> bool:
    key = _key(text)
    return any(key == _key(o) or difflib.SequenceMatcher(None, key, _key(o)).ratio() >= NEAR_DUPLICATE for o in others)


@dataclass(frozen=True)
class Curated:
    accepted: list[Lesson]
    refused: list[str]  # one reason per refused proposal (never the proposal text)


@dataclass(frozen=True)
class CurateContext:
    """`trial_of`: example id -> trial id for every example the reflector was shown (its only valid sources)."""

    existing: Sequence[Lesson]
    candidate_id: str
    run_id: str
    trial_of: Mapping[str, str]
    forbidden: Sequence[str]
    created_at: str


def curate(proposals: Sequence[Proposal], ctx: CurateContext) -> Curated:
    """Clean, check and dedupe the reflector's proposals; the accepted ones are new `pending` lessons."""
    existing, trial_of = ctx.existing, ctx.trial_of
    banned = [f for f in ctx.forbidden if f]
    accepted: list[Lesson] = []
    refused: list[str] = []
    for i, proposal in enumerate(proposals):
        text = clean(proposal.text)
        sources = tuple(sorted({e for e in proposal.example_ids if e in trial_of}))
        if not MIN_CHARS <= len(text) <= MAX_CHARS:
            refused.append(f"proposal {i}: length {len(text)} outside {MIN_CHARS}-{MAX_CHARS} characters")
        elif not sources:
            refused.append(f"proposal {i}: names no example the reflector was shown")
        elif any(b in text for b in banned):
            refused.append(f"proposal {i}: contains a reference-only string")
        elif _near(text, [lesson.text for lesson in [*existing, *accepted]]):
            refused.append(f"proposal {i}: repeats a lesson already on file")
        else:
            accepted.append(
                Lesson(
                    lesson_id=lesson_id(text),
                    text=text,
                    candidate_id=ctx.candidate_id,
                    source_run_ids=(ctx.run_id,),
                    source_example_ids=sources,
                    source_trial_ids=tuple(sorted({trial_of[e] for e in sources})),
                    created_at=ctx.created_at,
                )
            )
    return Curated(accepted, refused)


def rendered(lessons: Sequence[Lesson]) -> list[Lesson]:
    """The lessons a playbook section shows: oldest first, at most `MAX_RENDERED`."""
    return sorted(lessons, key=lambda lesson: (lesson.created_at, lesson.lesson_id))[:MAX_RENDERED]


def render(lessons: Sequence[Lesson]) -> str:
    """The playbook section of a coach prompt (`rendered(lessons)`). Empty text when there is no approved lesson
    (the version then carries no playbook file)."""
    chosen = rendered(lessons)
    if not chosen:
        return ""
    return PLAYBOOK_HEADER + "\n" + "".join(f"- {lesson.text}\n" for lesson in chosen)
