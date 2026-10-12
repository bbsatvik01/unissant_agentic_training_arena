"""`scripts/dev_tournament_demo.py` (D-021): the roster it freezes names exactly the candidate rows
`check_roster` validated -- the ids `register_candidate` returns for those manifests -- never a newest-version
lookup by name that could pick a manifest no one checked."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import CandidateManifest
from arena_tournament import lifecycle
from scripts import dev_tournament_demo as demo


class _Db:
    def __init__(self, *_args: object, **_kwargs: object) -> None:
        pass

    async def dev_cases(self) -> list[dict[str, Any]]:
        return [{"family_code": "F01", "variant_id": uuid4()} for _ in range(2)]

    async def candidate(self, kind: str, name: str) -> None:
        msg = f"never called: a newest-version lookup of {kind} {name}"
        raise AssertionError(msg)


def test_the_roster_uses_the_ids_of_the_exact_manifests_check_roster_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registered: dict[tuple[str, str], UUID] = {}
    checked: list[str] = []
    seen: dict[str, Any] = {}

    async def register_candidate(_connect: object, manifest: CandidateManifest) -> UUID:
        key = (manifest.candidate_id, manifest.version)
        registered.setdefault(key, uuid4())
        return registered[key]

    def build_roster(_specs: object, assistants: Sequence[UUID], subjects: Sequence[UUID], *, seed: int) -> list[Any]:
        seen.update(assistants=tuple(assistants), subjects=tuple(subjects), seed=seed)
        return []

    async def noop(*_args: object, **_kwargs: object) -> UUID:
        return uuid4()

    monkeypatch.setattr(demo, "check_roster", lambda ms: checked.extend(f"{m.candidate_id}@{m.version}" for m in ms))
    monkeypatch.setattr(lifecycle, "register_candidate", register_candidate)
    for name in ("create_tournament", "add_planned_trials", "freeze_tournament", "open_tournament"):
        monkeypatch.setattr(lifecycle, name, noop)
    monkeypatch.setattr(demo, "build_roster", build_roster)
    monkeypatch.setattr(demo, "ArenaDb", _Db)

    asyncio.run(demo.set_up_tournament("postgresql://r@127.0.0.1:1/x", "postgresql://p@127.0.0.1:1/x", ["F01"], 7))

    by_name = {name: uid for (name, _version), uid in registered.items()}
    assert seen["assistants"] == tuple(by_name[n] for n in demo.OFFICIAL_ASSISTANTS)
    assert seen["subjects"] == tuple(by_name[n] for n in demo.OFFICIAL_SUBJECTS)
    assert sorted(checked) == sorted(f"{n}@{v}" for n, v in registered)
