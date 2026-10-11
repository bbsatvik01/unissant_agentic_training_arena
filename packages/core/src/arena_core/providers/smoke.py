"""Vertex smoke: one real, paid `card`-type call through the full port and the database guard. The owner runs it.

    ARENA_GCP_PROJECT=cna-guardian ARENA_PUBLIC_DSN=... \\
      uv run --locked python -m arena_core.providers.smoke --confirm-paid-call

It is never run by `make check` or any test (tests drive `main` with a fake adapter and the in-memory guard). It
refuses to send unless `--confirm-paid-call` is given, the boot checks pass (no API key, project exactly
`cna-guardian`) and `ARENA_PUBLIC_DSN` names the arena_public credential. The call reserves its worst case against
`global` like every other call (X-05), so it fails closed (`cap`) until the owner has applied the budget plan.
Prints the attempt count, the token usage and the settled cost; exits 0 on a schema-valid reply, 1 otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from collections.abc import Callable, Mapping
from typing import Literal

from pydantic import BaseModel, Field

from arena_core.config import BootCheckError, refuse_gemini_api_keys, require_gcp_project
from arena_core.db.pool import dsn_connector
from arena_core.providers.errors import ProviderError
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, CallContext, Message, ModelAdapter
from arena_core.providers.vertex import vertex_adapter
from arena_core.spend.guard import DbSpendGuard, SpendGuard
from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel

DSN_VAR = "ARENA_PUBLIC_DSN"
PartsFactory = Callable[[Mapping[str, str]], tuple[ModelAdapter, SpendGuard]]


class SmokeReply(BaseModel):
    """A flat, bounded reply: proves response_json_schema, max_output_tokens and parsing end to end."""

    status: Literal["ok"]
    word: str = Field(max_length=20)


def smoke_call() -> AgentCall[SmokeReply]:
    return AgentCall(
        model=VertexModel.FLASH_LITE_35,
        thinking=ThinkingLevel.MINIMAL,
        system="You are a connectivity check. Answer with the JSON object only.",
        messages=(Message("user", 'Return status "ok" and one English word.'),),
        schema=SmokeReply,
        context=CallContext(
            call_type=CallType.CARD,
            purpose="experiment.latency",
            step_key=f"smoke:{uuid.uuid4()}",
        ),
    )


def runtime_parts(env: Mapping[str, str]) -> tuple[ModelAdapter, SpendGuard]:
    """The real adapter and the database guard on the arena_public credential."""
    dsn = env.get(DSN_VAR, "")
    if not dsn:
        msg = f"{DSN_VAR} is not set (the smoke reserves through the database guard)"
        raise BootCheckError(msg)
    return vertex_adapter(env), DbSpendGuard(dsn_connector(dsn))


def main(
    argv: list[str] | None = None,
    env: Mapping[str, str] | None = None,
    parts: PartsFactory = runtime_parts,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--confirm-paid-call", action="store_true", help="required: this sends one billed request")
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    if not args.confirm_paid_call:
        sys.stderr.write("refused: pass --confirm-paid-call to send one billed Vertex request\n")
        return 1
    try:
        refuse_gemini_api_keys(resolved)
        require_gcp_project(resolved)
        adapter, guard = parts(resolved)
    except BootCheckError as exc:
        sys.stderr.write(f"refused: {exc}\n")
        return 1
    try:
        result = asyncio.run(AgentPort(adapter=adapter, guard=guard).run(smoke_call()))
    except ProviderError as exc:
        sys.stderr.write(f"smoke failed: {type(exc).__name__}: {exc}\n")
        return 1
    sys.stdout.write(
        f"smoke ok: word={result.value.word!r} attempts={result.attempts} "
        f"input_tokens={result.usage.input_tokens} output_tokens={result.usage.output_tokens} "
        f"cost_usd={result.cost_usd} reservation={result.reservation_id}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
