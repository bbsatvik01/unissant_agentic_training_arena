"""`arena_tournament.main`: the CLI's own wiring (`load_manifests`, `build_runner`, `run_tournament`),
never exercised by `test_main.py` (which stubs `run_tournament` itself) or by it_tournament.py (which
builds its own runner directly, injecting the fake adapter a different way)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import committed_manifest
from arena_core.db.arena import ArenaDb
from arena_tournament import main
from arena_tournament.runner import RunSummary, TournamentRunner


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


class _FakeManifestDb:
    def __init__(self, planned: list[dict[str, Any]], manifests: dict[UUID, dict[str, Any]]) -> None:
        self._planned = planned
        self._manifests = manifests

    async def planned_trials(self, _tournament: UUID) -> list[dict[str, Any]]:
        return self._planned

    async def manifest(self, candidate: UUID) -> dict[str, Any] | None:
        return self._manifests.get(candidate)


def test_load_manifests_reads_every_assistant_and_subject_candidate_once() -> None:
    a1, s1 = uuid4(), uuid4()
    coach = committed_manifest("A1")
    planned = [
        {"assistant_candidate_id": a1, "subject_candidate_id": s1},
        {"assistant_candidate_id": a1, "subject_candidate_id": s1},  # repeated: still read a1/s1 once each
    ]
    db = _FakeManifestDb(
        planned, {a1: {"manifest": coach.model_dump(mode="json")}, s1: {"manifest": coach.model_dump(mode="json")}}
    )
    out = run(main.load_manifests(cast("ArenaDb", db), uuid4()))
    assert set(out) == {a1, s1}


def test_load_manifests_raises_when_a_roster_candidate_has_no_readable_manifest() -> None:
    a1 = uuid4()
    db = _FakeManifestDb([{"assistant_candidate_id": a1, "subject_candidate_id": None}], {})
    with pytest.raises(RuntimeError, match="no readable manifest"):
        run(main.load_manifests(cast("ArenaDb", db), uuid4()))


GOOD_ENV = {
    "ARENA_ROLE": "tournament",
    "ARENA_GCP_PROJECT": "cna-guardian",
    "ARENA_PUBLIC_DSN": "postgresql://arena_public@127.0.0.1:1/x",
    "ARENA_ENV": "local",
    "ARENA_BIND_HOST": "127.0.0.1",
    "ARENA_MODEL_MODE": "fake",
    "ARENA_LOCAL_CALLER_TOKEN": "it-main-wiring-caller",
}


def test_build_runner_wires_a_runner_with_empty_manifests_and_no_live_connection() -> None:
    """`dsn_connector` is lazy (opens on first use, never at construction), so this proves the wiring
    without a database: db/port/orchestrator/referee all build, manifests start empty (`run_tournament`
    fills them once it knows which tournament it is running)."""
    runner = main.build_runner(GOOD_ENV)
    assert isinstance(runner, TournamentRunner)
    assert runner.manifests == {}


def test_run_tournament_fills_manifests_before_running(monkeypatch: pytest.MonkeyPatch) -> None:
    tournament_id = uuid4()
    coach = committed_manifest("A1")
    candidate = uuid4()
    summary = RunSummary(tournament_id=tournament_id, outcomes={"completed": 1}, closed=True)
    seen_run: list[UUID] = []
    real_build_runner = main.build_runner  # fake_build_runner replaces main.build_runner below

    def fake_build_runner(_env: object) -> TournamentRunner:
        runner = real_build_runner(GOOD_ENV)

        async def fake_run(tid: UUID) -> RunSummary:
            seen_run.append(tid)
            assert runner.manifests == {candidate: coach}
            return summary

        monkeypatch.setattr(runner, "run", fake_run)
        return runner

    async def fake_load_manifests(_db: object, _tournament: UUID) -> dict[UUID, Any]:
        return {candidate: coach}

    monkeypatch.setattr(main, "build_runner", fake_build_runner)
    monkeypatch.setattr(main, "load_manifests", fake_load_manifests)
    assert run(main.run_tournament(GOOD_ENV, tournament_id)) == summary
    assert seen_run == [tournament_id]
