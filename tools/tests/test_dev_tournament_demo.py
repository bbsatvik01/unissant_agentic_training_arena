"""`scripts/dev_tournament_demo.py` (D-021): the roster it freezes names exactly the candidate rows
`check_roster` validated -- the ids `register_candidate` returns for those manifests -- never a newest-version
lookup by name that could pick a manifest no one checked."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import CandidateManifest
from arena_tournament import lifecycle
from arena_tournament.runner import RunSummary
from scripts import dev_tournament_demo as demo


class _Db:
    status = "draft"
    planned: tuple[dict[str, Any], ...] = ()

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        pass

    async def tournament_status(self, _tournament: UUID) -> str:
        return self.status

    async def planned_trials(self, _tournament: UUID) -> list[dict[str, Any]]:
        return list(self.planned)

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


@pytest.mark.parametrize(
    ("status", "planned", "expected"),
    [
        ("draft", [], ["add_planned_trials", "freeze_tournament", "open_tournament"]),
        ("draft", [{"planned_trial_id": "x"}], ["freeze_tournament", "open_tournament"]),
        ("frozen", [{"planned_trial_id": "x"}], ["open_tournament"]),
        ("running", [{"planned_trial_id": "x"}], []),
        ("sealed", [{"planned_trial_id": "x"}], []),
    ],
)
def test_a_rerun_runs_only_the_setup_steps_still_missing(
    monkeypatch: pytest.MonkeyPatch, status: str, planned: list[dict[str, Any]], expected: list[str]
) -> None:
    """`scripts/dev.sh tournament` again with the same seed (e.g. after an interruption) finds its tournament
    past draft: add_planned_trials and freeze_tournament refuse a non-draft one (S4), so they never run then."""
    calls: list[str] = []

    def recorder(name: str) -> Callable[..., Awaitable[UUID]]:
        async def call(*_args: object, **_kwargs: object) -> UUID:
            calls.append(name)
            return uuid4()

        return call

    db = type("Db", (_Db,), {"status": status, "planned": tuple(planned)})
    monkeypatch.setattr(demo, "check_roster", lambda _ms: None)
    monkeypatch.setattr(lifecycle, "register_candidate", recorder("register_candidate"))
    for name in ("create_tournament", "add_planned_trials", "freeze_tournament", "open_tournament"):
        monkeypatch.setattr(lifecycle, name, recorder(name))
    monkeypatch.setattr(demo, "build_roster", lambda *_a, **_k: [])
    monkeypatch.setattr(demo, "ArenaDb", db)

    asyncio.run(demo.set_up_tournament("postgresql://r@127.0.0.1:1/x", "postgresql://p@127.0.0.1:1/x", ["F01"], 7))
    assert [c for c in calls if c not in ("register_candidate", "create_tournament")] == expected


def test_main_refuses_without_both_dsns(capsys: pytest.CaptureFixture[str]) -> None:
    assert demo.main([], env={"ARENA_PUBLIC_DSN": "postgresql://p@127.0.0.1:1/x"}) == 1
    assert "needs ARENA_REFEREE_DSN and ARENA_PUBLIC_DSN" in capsys.readouterr().err


@pytest.mark.parametrize("closed", [True, False])
def test_main_runs_the_job_with_only_the_tournament_roles_env(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], *, closed: bool
) -> None:
    """The job gets the tournament role's own boot contract (S5 1.3), never the operator's referee DSN."""
    tournament, trial = uuid4(), uuid4()
    seen: dict[str, Any] = {}

    async def set_up(_ref: str, _pub: str, families: Sequence[str], seed: int) -> UUID:
        seen.update(families=list(families), seed=seed)
        return tournament

    async def run_tournament(env: dict[str, str], tid: UUID) -> RunSummary:
        seen.update(env=env, tid=tid)
        return RunSummary(tid, {"completed": 6}, closed)

    class _Db:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def planned_trials(self, _t: UUID) -> list[dict[str, Any]]:
            return [{"planned_trial_id": "p1"}, {"planned_trial_id": "p2"}]

        async def planned_trial_attempts(self, _t: UUID) -> dict[str, list[dict[str, Any]]]:
            return {"p2": [{"trial_id": str(trial)}]}

    monkeypatch.setattr(demo, "set_up_tournament", set_up)
    monkeypatch.setattr(demo, "run_tournament", run_tournament)
    monkeypatch.setattr(demo, "ArenaDb", _Db)
    env = {
        "ARENA_REFEREE_DSN": "postgresql://r@127.0.0.1:1/x",
        "ARENA_PUBLIC_DSN": "postgresql://p@127.0.0.1:1/x",
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_ROLE": "referee",
    }
    seed = 3
    assert demo.main(["--families", "F02", "--seed", str(seed)], env=env) == (0 if closed else 1)
    assert seen["families"] == ["F02"]
    assert seen["seed"] == seed
    assert seen["tid"] == tournament
    assert seen["env"] == {
        "ARENA_ROLE": "tournament",
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_PUBLIC_DSN": "postgresql://p@127.0.0.1:1/x",
    }
    assert f"scripts/dev.sh export-run {trial}" in capsys.readouterr().out
