"""The colleague NPC catalogue (``npcs.json``, next to this file): who each NPC is, how they talk and which voice
speaks for them. Every voice is one ``POST /api/tts`` can speak (``voice.catalogue.speaker_for``): a prebuilt Gemini
voice, or a persona key of the room's voice catalogue once a voice is designed for the NPC."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from arena_core.voice.catalogue import PERSONAS, PersonaVoice, speaker_for

NPC_ID = re.compile(r"^[a-z][a-z_]{1,31}$")
MAX_NAME_CHARS = 60
MAX_ROLE_CHARS = 120
MAX_PERSONALITY_CHARS = 600
CATALOGUE_PATH = Path(__file__).with_name("npcs.json")


class NpcCatalogueError(ValueError):
    """``npcs.json`` holds a malformed entry."""


@dataclass(frozen=True)
class Npc:
    npc_id: str
    name: str
    role: str
    personality: str
    voice: str  # a prebuilt Gemini voice or a persona key of arena_core.voice.catalogue (POST /api/tts speaks it)


def _text(entry: Mapping[str, Any], npc_id: str, name: str, limit: int) -> str:
    value = entry.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        msg = f"{npc_id}.{name} must be 1 to {limit} characters"
        raise NpcCatalogueError(msg)
    return value.strip()


def parse(doc: Mapping[str, Any], voices: Mapping[str, PersonaVoice] = PERSONAS) -> dict[str, Npc]:
    raw = doc.get("npcs")
    if not isinstance(raw, dict) or not raw:
        msg = "npcs must be a non-empty object"
        raise NpcCatalogueError(msg)
    out: dict[str, Npc] = {}
    for npc_id, entry in raw.items():
        if not isinstance(npc_id, str) or not NPC_ID.fullmatch(npc_id) or not isinstance(entry, dict):
            msg = f"{npc_id!r} must be a lower-case id with an object"
            raise NpcCatalogueError(msg)
        voice = entry.get("voice")
        if not isinstance(voice, str) or speaker_for(voice, voices) is None:
            msg = f"{npc_id}.voice must be a prebuilt voice or a persona of the voice catalogue"
            raise NpcCatalogueError(msg)
        out[npc_id] = Npc(
            npc_id=npc_id,
            name=_text(entry, npc_id, "name", MAX_NAME_CHARS),
            role=_text(entry, npc_id, "role", MAX_ROLE_CHARS),
            personality=_text(entry, npc_id, "personality", MAX_PERSONALITY_CHARS),
            voice=str(voice),
        )
    return out


def load() -> dict[str, Npc]:
    return parse(json.loads(CATALOGUE_PATH.read_text(encoding="utf-8")))


NPCS: dict[str, Npc] = load()
