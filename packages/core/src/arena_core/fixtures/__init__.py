"""Development fixtures of S2 11.1, as data files packaged beside this module.

- `fx_guard_clean.json`: `FX-GUARD-CLEAN`, clean subject sentences, near misses included (S2 6.9, AT-SUBJ-6).
- `fx_relay_neutral.json`, `fx_relay_bad.json`: `FX-RELAY-NEUTRAL`, `FX-RELAY-BAD` (S2 8.2, AT-HAR-1, AT-HAR-2).
- `fx_dem_neutral.json`: `FX-DEM-NEUTRAL`, neutral coach claims (S2 4.4 demeanor lexicon).
- `fx_ex.json`: `FX-EX`, the slide 8 exchange (S2 11.2 EV-COACH-1).
- `dev_transcripts.json`: ten scripted development transcripts (replay-script questions, plain rendering),
  shared by `FX-COOP`, `FX-STYLE-PAIRS` and `FX-INJ`.
- `fx_coop.json`: `FX-COOP`, the three cooperative truthful transcripts (S2 11.2 EV-COACH-2).
- `fx_inj.json`: `FX-INJ`, IJ-1 to IJ-7 over one base transcript; `injection.py` builds each and its control
  twin (S2 11.3, AT-SUBJ-5).
- `transcript_review.json`: the recorded independent review of every scripted transcript (a fresh read-only Codex
  session per transcript): per exchange, consistent with the variant's canonical facts and responsive to its
  question, bound to the reviewed text by `reviewed_text_sha256`.
- `fx_style_pairs.json`: `FX-STYLE-PAIRS`, the ten transcripts; `style.py` renders the styled member (S2 11.6).

Every case is synthetic and every file is development data (SCN-12). Nothing here is read by a hidden-tournament
code path.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from arena_core.ids import canonical_sha256

FIXTURE_DIR = Path(__file__).resolve().parent  # packaged beside this module
_NAME = re.compile(r"[a-z][a-z0-9_]*")


def load(name: str) -> dict[str, Any]:
    """One fixture file by its stem (`fx_guard_clean`); a name with any path syntax is refused."""
    if not _NAME.fullmatch(name):
        msg = f"not a fixture name: {name!r}"
        raise ValueError(msg)
    data: dict[str, Any] = json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))
    return data


def transcript(transcript_id: str) -> dict[str, Any]:
    """One development transcript of `dev_transcripts.json` by its ID (`TX-F01-T`)."""
    for entry in load("dev_transcripts")["transcripts"]:
        if entry["id"] == transcript_id:
            return dict(entry)
    msg = f"no development transcript {transcript_id!r}"
    raise KeyError(msg)


def reviewed_text_sha256(transcript: dict[str, Any]) -> str:
    """The hash a review is bound to: family, variant, and every exchange's turn, question and answer. Any edit to
    a reviewed answer changes it, so the review must be redone."""
    exchanges = [[e["turn"], e["question"], e["answer"]] for e in transcript["exchanges"]]
    return canonical_sha256([transcript["family_id"], transcript["variant"], exchanges])
