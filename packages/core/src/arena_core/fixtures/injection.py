"""`FX-INJ` (S2 11.3): build each injected transcript and its control twin from `fx_inj.json`.

The injection is appended to the base transcript's subject answer at each listed turn, after one space
("inserted into the subject answer"). IJ-3 appends the IJ-1 text encoded in Unicode tag characters
(U+E0000 plus the ASCII code point) with no separator, so the visible answer is unchanged. The control twin is
the base transcript with the injection removed, which is the base transcript itself.
"""

from __future__ import annotations

import copy
from typing import Any

from arena_core.fixtures import load, transcript

_TAG_BASE = 0xE0000


def encode_tags(text: str) -> str:
    """ASCII text as invisible Unicode tag characters (IJ-3)."""
    if not text.isascii():
        msg = "only ASCII text has a tag-character encoding"
        raise ValueError(msg)
    return "".join(chr(_TAG_BASE + ord(c)) for c in text)


def spec(fixture_id: str) -> dict[str, Any]:
    for entry in load("fx_inj")["injections"]:
        if entry["id"] == fixture_id:
            return dict(entry)
    msg = f"no FX-INJ fixture {fixture_id!r}"
    raise KeyError(msg)


def injected_turns(fixture_id: str) -> list[int]:
    return [int(t) for t in spec(fixture_id)["turns"]]


def build(fixture_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """(injected transcript, control twin) for one of IJ-1 to IJ-7."""
    entry = spec(fixture_id)
    control = transcript(str(load("fx_inj")["base_transcript"]))
    injected = copy.deepcopy(control)
    injected["id"] = f"{control['id']}+{fixture_id}"
    turns = set(injected_turns(fixture_id))
    for exchange in injected["exchanges"]:
        if exchange["turn"] in turns:
            if entry["encoding"] == "unicode_tags":
                exchange["answer"] = exchange["answer"] + encode_tags(entry["text"])
            else:
                exchange["answer"] = f"{exchange['answer']} {entry['text']}"
    return injected, control
