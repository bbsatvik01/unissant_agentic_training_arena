"""Designing the catalogue's voices (stage 8, ``scripts/design_voices.py``): each persona without a stored voice gets
one, created from its own description through the Voices API, behind the spend guard exactly like a spoken line:
reserve on the request's measured bytes (call kind ``voice_design``), dispatch, one send, record its usage (the
description as text in, the voice sample as audio out), settle. The new id is written back to ``personas.json`` at
once, so a later failure never loses a voice already paid for.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID, uuid4

from arena_core.db.calls import ModelCallRequest, UsageReport, UsageStatus
from arena_core.providers.errors import ProviderCallError
from arena_core.providers.types import Usage
from arena_core.spend.guard import GuardSession, SpendGuard
from arena_core.voice.catalogue import PersonaVoice
from arena_core.voice.tts import BUDGET_BUCKET, TTS_MODEL

VOICE_DESIGN_CALL_KIND = "voice_design"
VOICE_DESIGN_PURPOSE = "voice_design"


class Designed(Protocol):
    @property
    def voice_id(self) -> str: ...
    @property
    def sample(self) -> bytes: ...
    @property
    def sample_mime(self) -> str: ...
    @property
    def usage(self) -> Usage | None: ...


class Designer(Protocol):
    async def design(self, description: str, display_name: str, gender: str, language_code: str) -> Designed: ...


@dataclass(frozen=True)
class Tools:
    """What a design needs: the Voices API, the spend guard, and the request measure it is reserved on."""

    designer: Designer
    guard: SpendGuard
    measure: Callable[[str, str, str, str], int]


@dataclass(frozen=True)
class Outcome:
    key: str
    voice_id: str | None
    error: str | None


def display_name(persona: PersonaVoice) -> str:
    """The stored voice's display name: the persona key, readable in the project's voice list."""
    return f"arena {persona.key}"[:64]


async def design_one(persona: PersonaVoice, tools: Tools, keep: Callable[[str, Designed], None]) -> Designed:
    """One persona's voice. The new voice is kept (``keep``) the moment the reply names it, before the usage is
    recorded and the hold settled, so a failure in that accounting never loses a voice already paid for."""
    name = display_name(persona)
    request = ModelCallRequest(
        key=f"voice_design:{persona.key[:60]}:{uuid4().hex[:16]}",
        bucket=BUDGET_BUCKET,
        model=TTS_MODEL,
        call_kind=VOICE_DESIGN_CALL_KIND,
        purpose=VOICE_DESIGN_PURPOSE,
        trial_id=None,
        actor_user_id=None,
        input_bytes=tools.measure(persona.description, name, persona.gender, persona.language_code),
    )
    async with tools.guard.session() as session:
        reservation = await session.reserve(request)
        try:
            await session.dispatch(reservation.id)
        except BaseException:
            await session.settle(reservation.id, "released")
            raise
        started = time.monotonic()
        try:
            out = await tools.designer.design(persona.description, name, persona.gender, persona.language_code)
        except ProviderCallError as exc:
            await _record(session, reservation.id, exc.usage, "error", started)
            unknown = exc.usage is None and exc.maybe_billed
            await session.settle(reservation.id, "usage_unknown" if unknown else "committed")
            raise
        keep(persona.key, out)
        await _record(session, reservation.id, out.usage, "ok", started)
        await session.settle(reservation.id, "committed" if out.usage is not None else "usage_unknown")
        return out


async def _record(
    session: GuardSession, reservation_id: UUID, usage: Usage | None, status: UsageStatus, started: float
) -> None:
    await session.record(
        UsageReport(
            reservation_id=reservation_id,
            seq=1,
            model=TTS_MODEL,
            input_tokens=usage.input_tokens if usage is not None else 0,
            output_tokens=0,
            thinking_tokens=0,
            audio_output_tokens=usage.output_tokens if usage is not None else 0,
            status=status,
            latency_ms=int((time.monotonic() - started) * 1000),
            trace_id=None,
            span_id=None,
        )
    )


def write_voice_id(catalogue_path: Path, key: str, voice_id: str) -> None:
    """Store one persona's new voice id in ``personas.json`` (the file's other content untouched)."""
    doc: dict[str, Any] = json.loads(catalogue_path.read_text(encoding="utf-8"))
    doc["personas"][key]["voice_id"] = voice_id
    tmp = catalogue_path.with_suffix(".json.part")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(catalogue_path)


async def design_missing(
    personas: Mapping[str, PersonaVoice],
    tools: Tools,
    *,
    on_designed: Callable[[str, Designed], None],
    only: frozenset[str] | None = None,
) -> list[Outcome]:
    """Design every persona that has no stored voice yet (or only those named), one at a time. ``on_designed`` keeps
    each new voice at once (the script writes its id to ``personas.json``); a failure is reported and the next
    persona goes on."""
    outcomes: list[Outcome] = []
    for key, persona in personas.items():
        if persona.voice_id is not None or (only is not None and key not in only):
            continue
        try:
            out = await design_one(persona, tools, on_designed)
        except ProviderCallError as exc:
            outcomes.append(Outcome(key, None, f"{exc.kind}: {exc}"))
            continue
        outcomes.append(Outcome(key, out.voice_id, None))
    return outcomes
