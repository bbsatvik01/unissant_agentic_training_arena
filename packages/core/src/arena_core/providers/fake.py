"""Zero-spend fake adapter: ARENA_MODEL_MODE=fake and every test (S5 10.4).

It never touches the network. Each attempt takes the next scripted outcome (reply text, a `ProviderCallError`, or a
function of the request) or, with no script left, the canned reply registered for the request's schema title. Every
request is captured, so tests assert exactly what would have been sent. Reservation, dispatch and settlement still run
through the guard (S5 10.4): usage defaults to zero tokens, so a fake call settles $0 and an unapplied plan still
fails closed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from arena_core.providers.errors import ConfigError, ProviderCallError
from arena_core.providers.types import ModelRequest, RawCompletion, Usage

Outcome = str | ProviderCallError | Callable[[ModelRequest], str]


@dataclass
class FakeAdapter:
    script: list[Outcome] = field(default_factory=list)
    canned: Mapping[str, str] = field(default_factory=dict)  # schema title -> reply text
    usage: Usage | None = field(default_factory=Usage)  # None: the reply reports no usage
    delay_s: float = 0.0
    requests: list[ModelRequest] = field(default_factory=list)
    timeouts: list[float] = field(default_factory=list)

    async def generate(self, request: ModelRequest, *, timeout_s: float) -> RawCompletion:
        self.requests.append(request)
        self.timeouts.append(timeout_s)
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        if self.script:
            outcome = self.script.pop(0)
        else:
            title = request.json_schema.get("title")
            if not isinstance(title, str) or title not in self.canned:
                msg = f"fake adapter has no canned reply for schema {title!r}"
                raise ConfigError(msg)
            outcome = self.canned[title]
        if isinstance(outcome, ProviderCallError):
            raise outcome
        text = outcome if isinstance(outcome, str) else outcome(request)
        return RawCompletion(text=text, usage=self.usage, finish_reason="STOP")
