"""A scripted fake model and the one-repair loop the acceptance tests drive (S2 10, 11: fake model port).

`ScriptedModel` returns canned replies in order and records every request it receives. `call_with_one_repair`
is the attempt rule S2 10 fixes for a schema failure: first try, one repair carrying the field-path errors, then
failure; it makes no real model call. The production loop (reservation, timeouts, transient retries, byte-cut
echo) is the agent port's (WP-05) and calls the same `output_errors` and `repair_message`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel

from arena_core.agents.coach_prompts import Prompt
from arena_core.agents.repair import output_errors, repair_message

Turn = tuple[str, str]


@dataclass
class ScriptedModel:
    replies: list[str]
    requests: list[tuple[str, list[Turn]]] = field(default_factory=list)

    def __call__(self, system: str, contents: list[Turn]) -> str:
        self.requests.append((system, list(contents)))
        return self.replies[len(self.requests) - 1]


@dataclass(frozen=True)
class Outcome[M: BaseModel]:
    value: M | None
    errors: list[str]
    attempts: int


def call_with_one_repair[T: BaseModel](
    model: ScriptedModel, prompt: Prompt, output: type[T], context: object
) -> Outcome[T]:
    contents: list[Turn] = [("user", prompt.user_message)]
    reply = model(prompt.system_instruction, contents)
    value, errors = output_errors(output, reply, context)
    if value is not None:
        return Outcome(value, [], 1)
    contents += [("model", reply), ("user", repair_message(errors))]
    reply = model(prompt.system_instruction, contents)
    value, errors = output_errors(output, reply, context)
    return Outcome(value, errors, 2)
