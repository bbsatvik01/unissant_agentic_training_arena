"""`make export-run` (D-021): `scripts/export_run.py` writes the recording the projection builds for the acting
user's trial, and refuses a trial that is not theirs."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from arena_core.identity import user_id_for
from packages.core.tests.turns.fakedb import FakeArenaDb
from packages.core.tests.turns.test_orchestrator import Rig
from scripts import export_run

EMAIL = "a@example.test"


def _env(tmp_path: Path) -> dict[str, str]:
    users = tmp_path / "users.toml"
    users.write_text(f'[[users]]\nemail = "{EMAIL}"\ndisplay_name = "A"\nroles = ["investigator"]\n', encoding="utf-8")
    return {
        "ARENA_ROLE": "api",
        "ARENA_ENV": "local",
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_PUBLIC_DSN": "postgresql://arena_public@127.0.0.1:1/x",
        "ARENA_DEV_USER": EMAIL,
        "ARENA_USERS_FILE": str(users),
    }


def test_export_writes_the_recording(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rig = Rig()
    rig.turn()
    seen: list[UUID] = []

    async def export(_connect: object, actor: UUID, trial: UUID) -> dict[str, Any] | None:
        seen.append(actor)
        db: FakeArenaDb = rig.db
        return await export_run.export_from(db, trial)

    monkeypatch.setattr(export_run, "export", export)
    out = tmp_path / "recordings" / "t.json"
    assert export_run.main(["--trial", str(rig.db.trial_id), "--out", str(out)], _env(tmp_path)) == 0
    rec = json.loads(out.read_text(encoding="utf-8"))
    assert rec["format"] == "arena.recording.v2"
    assert rec["trial_id"] == str(rig.db.trial_id)
    assert seen == [user_id_for(EMAIL)]


def test_export_refuses_a_trial_that_is_not_the_users() -> None:
    db = FakeArenaDb()
    assert asyncio.run(export_run.export_from(db, uuid4())) is None


def test_export_main_reports_an_unknown_trial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def nothing(*_a: object) -> None:
        return None

    monkeypatch.setattr(export_run, "export", nothing)
    assert export_run.main(["--trial", str(uuid4()), "--out", str(tmp_path / "x.json")], _env(tmp_path)) == 1
    assert not (tmp_path / "x.json").exists()
