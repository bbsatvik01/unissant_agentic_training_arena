"""Canned replies for `ARENA_MODEL_MODE=fake` gym runs (zero spend, S5 10.4): the coach's fake card, a reflection
that returns the current strategy with one sentence added, and one lesson citing the first example shown. A fake
run exercises every step (search, holdout grading, reflector, curator, registry); since the fake card does not
read the strategy, its challenger never wins and nothing is promotable from a fake run.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

from arena_core.providers.types import ModelRequest
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from scripts.coach_gym.optimize import MAX_STRATEGY_CHARS

FAKE_ADDITION = "Before any verdict, name the turn and quote the words it rests on."
FAKE_LESSON = "Before calling an answer evasive, name the fact it leaves out and quote the answer exactly."
_FENCED = re.compile(r"```\n?(.*?)```", re.DOTALL)
_SHOWN_ID = re.compile(r"^\[([0-9a-f]{16})\]", re.MULTILINE)


def _user(request: ModelRequest) -> str:
    return request.messages[-1].text if request.messages else ""


def instruction_reply(request: ModelRequest) -> str:
    match = _FENCED.search(_user(request))
    current = match.group(1).strip() if match else ""
    text = f"{current}\n{FAKE_ADDITION}".strip()[:MAX_STRATEGY_CHARS]
    return json.dumps({"instruction": text})


def lessons_reply(request: ModelRequest) -> str:
    shown = _SHOWN_ID.findall(_user(request))
    lessons = [{"text": FAKE_LESSON, "example_ids": shown[:1]}] if shown else []
    return json.dumps({"lessons": lessons})


FAKE_GYM_REPLIES: dict[str, str | Callable[[ModelRequest], str]] = {
    **FAKE_COACH_REPLIES,
    "GymInstruction": instruction_reply,
    "GymLessons": lessons_reply,
}
