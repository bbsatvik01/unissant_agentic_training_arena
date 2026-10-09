"""Committed prompt snapshots (S2 AT-COACH-2, AT-SUBJ-1, AT-VOICE-1): byte-identical renders of fixed fixtures.

A snapshot is never written by a test run: a missing or different file fails. After a deliberate prompt change
(a new prompt version, S2 3.3), write `render_snapshot(prompt)` for the changed renders with a one-off script and
review the diff before committing it.
"""

from __future__ import annotations

from pathlib import Path

from arena_core.agents.coach_prompts import Prompt

SNAPSHOT_DIR = Path(__file__).resolve().parent


def render_snapshot(prompt: Prompt | str) -> str:
    if isinstance(prompt, str):
        return prompt if prompt.endswith("\n") else prompt + "\n"
    return f"=== system_instruction ===\n{prompt.system_instruction}\n=== user_message ===\n{prompt.user_message}\n"


def snapshot(name: str, prompt: Prompt | str) -> None:
    path = SNAPSHOT_DIR / f"{name}.txt"
    assert path.is_file(), f"no committed snapshot {path.name}"
    assert render_snapshot(prompt) == path.read_text(encoding="utf-8"), f"render differs from snapshot {path.name}"
