"""The room's voice catalogue (stage 8): who speaks with which voice and how (``personas.json``, next to this file).

A line names either a prebuilt Gemini voice (spoken plainly) or a persona key (``subject:<display name>``,
``coach:<desk>``, ``investigator``). A persona speaks with its designed voice once ``scripts/design_voices.py`` has
stored one in the project (``voice_id``), else with its prebuilt fallback, always with its own short delivery style.
Every persona's description and style come from public, role-free traits (apparent age, work, region, the case
family's speaking style without its affect), so a subject sounds the same whether truthful or not (PRB-4). No voice
is replicated from a real person.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any

from arena_core.voice.prebuilt import PREBUILT_VOICES

#: A designed voice id as the Voices API returns it.
VOICE_ID_PREFIX = "voice_"
MAX_DESCRIPTION_CHARS = 400
MAX_STYLE_CHARS = 120


class CatalogueError(ValueError):
    """``personas.json`` holds a malformed entry."""


@dataclass(frozen=True)
class PersonaVoice:
    key: str
    prebuilt: str
    gender: str
    language_code: str
    description: str
    style: str
    voice_id: str | None


@dataclass(frozen=True)
class Speaker:
    """What one line is synthesized with: the voice the request names (a prebuilt name or a designed voice id) and
    the delivery style (None: none)."""

    voice: str
    style: str | None


def _text(entry: Mapping[str, Any], key: str, name: str, limit: int) -> str:
    value = entry.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        msg = f"{key}.{name} must be 1 to {limit} characters"
        raise CatalogueError(msg)
    return value


def parse(doc: Mapping[str, Any]) -> dict[str, PersonaVoice]:
    """The catalogue, every entry checked: a known prebuilt fallback, a designed id or null, bounded texts."""
    raw = doc.get("personas")
    if not isinstance(raw, dict) or not raw:
        msg = "personas must be a non-empty object"
        raise CatalogueError(msg)
    out: dict[str, PersonaVoice] = {}
    for key, entry in raw.items():
        if not isinstance(entry, dict):
            msg = f"{key} must be an object"
            raise CatalogueError(msg)
        prebuilt = entry.get("prebuilt")
        if prebuilt not in PREBUILT_VOICES:
            msg = f"{key}.prebuilt must be a prebuilt voice"
            raise CatalogueError(msg)
        voice_id = entry.get("voice_id")
        if voice_id is not None and (not isinstance(voice_id, str) or not voice_id.startswith(VOICE_ID_PREFIX)):
            msg = f"{key}.voice_id must be null or a stored voice id ({VOICE_ID_PREFIX}...)"
            raise CatalogueError(msg)
        gender = entry.get("gender")
        if gender not in ("male", "female"):
            msg = f"{key}.gender must be male or female"
            raise CatalogueError(msg)
        out[key] = PersonaVoice(
            key=key,
            prebuilt=str(prebuilt),
            gender=str(gender),
            language_code=_text(entry, key, "language_code", 16),
            description=_text(entry, key, "description", MAX_DESCRIPTION_CHARS),
            style=_text(entry, key, "style", MAX_STYLE_CHARS),
            voice_id=voice_id,
        )
    return out


def load() -> dict[str, PersonaVoice]:
    text = resources.files("arena_core.voice").joinpath("personas.json").read_text(encoding="utf-8")
    return parse(json.loads(text))


PERSONAS: dict[str, PersonaVoice] = load()


def speaker_for(name: str, personas: Mapping[str, PersonaVoice] = PERSONAS) -> Speaker | None:
    """The voice and style a line asks for: a persona's (designed voice when stored, else its prebuilt fallback,
    with its style), a prebuilt voice plainly, or None for an unknown name."""
    persona = personas.get(name)
    if persona is not None:
        return Speaker(voice=persona.voice_id or persona.prebuilt, style=persona.style)
    if name in PREBUILT_VOICES:
        return Speaker(voice=name, style=None)
    return None
