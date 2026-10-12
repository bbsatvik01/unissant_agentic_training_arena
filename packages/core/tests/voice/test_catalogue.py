"""The voice catalogue (stage 8): every speaking persona is well formed, sounds the same whatever the subject's role
(PRB-4: no role or stress word in any prompt or style), and resolves to its designed voice once stored."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from arena_core.voice import catalogue
from arena_core.voice.catalogue import CatalogueError, Speaker, parse, speaker_for

ENTRY = {
    "prebuilt": "Kore",
    "gender": "female",
    "language_code": "en-US",
    "description": "A clerk in her forties with a clear voice.",
    "style": "formal and brief",
    "voice_id": None,
}
DEV_SUBJECTS = 9  # the nine dev families' subjects
# Words that would make a voice a role or stress cue (PRB-4).
STRESS = re.compile(
    r"\b(nervous|anxious|anxiety|stress\w*|tense|shaky|deceptive|truthful|lying|liar|guilty|evasive)\b", re.I
)


def test_the_shipped_catalogue_covers_every_dev_subject_the_coaches_and_the_investigator() -> None:
    keys = set(catalogue.PERSONAS)
    assert {"coach:question", "coach:flags", "coach:follow_up", "investigator"} <= keys
    assert sum(k.startswith("subject:") for k in keys) >= DEV_SUBJECTS


def test_no_prompt_or_style_carries_a_role_or_stress_cue() -> None:
    for persona in catalogue.PERSONAS.values():
        assert not STRESS.search(persona.description), persona.key
        assert not STRESS.search(persona.style), persona.key


def test_a_persona_resolves_to_its_designed_voice_once_stored_else_its_prebuilt_and_always_its_style() -> None:
    plain = parse({"personas": {"subject:A": ENTRY}})
    assert speaker_for("subject:A", plain) == Speaker("Kore", "formal and brief")
    designed = parse({"personas": {"subject:A": {**ENTRY, "voice_id": "voice_abc123"}}})
    assert speaker_for("subject:A", designed) == Speaker("voice_abc123", "formal and brief")
    assert speaker_for("Puck", plain) == Speaker("Puck", None)
    assert speaker_for("subject:B", plain) is None


@pytest.mark.parametrize(
    "bad",
    [
        {"prebuilt": "Nope"},
        {"voice_id": "abc"},
        {"gender": "x"},
        {"description": ""},
        {"style": "x" * 121},
        {"language_code": 3},
    ],
)
def test_a_malformed_entry_is_refused(bad: dict[str, object]) -> None:
    with pytest.raises(CatalogueError):
        parse({"personas": {"subject:A": {**ENTRY, **bad}}})


def test_a_malformed_document_is_refused() -> None:
    docs: tuple[dict[str, object], ...] = ({}, {"personas": {}}, {"personas": {"x": "y"}})
    for doc in docs:
        with pytest.raises(CatalogueError):
            parse(doc)


def test_every_voice_the_web_cast_asks_for_is_in_the_catalogue_or_prebuilt() -> None:
    cast = Path(__file__).resolve().parents[4] / "web" / "src" / "lib" / "world" / "cast.ts"
    asked = set(re.findall(r'gemini: "([^"]+)"', cast.read_text(encoding="utf-8")))
    assert asked, "no voices found in cast.ts"
    unknown = {v for v in asked if speaker_for(v) is None}
    assert not unknown
    assert {v for v in asked if ":" in v or v == "investigator"} <= set(catalogue.PERSONAS)
