"""Coach Lab routes (D-036) over a registry written through `arena_core.coachgym.registry`: read-only, behind the same
allowlist boundary as every other /api route."""

from __future__ import annotations

from dataclasses import replace
from http import HTTPStatus
from pathlib import Path

from arena_api.app import create_app, guard_config
from arena_core.agents.manifests import committed_manifest
from arena_core.coachgym import registry
from arena_core.coachgym.playbook import Lesson
from packages.core.tests.coachgym.support import gym_root
from services.api.tests.test_app import Harness


def harness(root: Path, *, allowlisted: bool = True) -> Harness:
    h = Harness() if allowlisted else Harness(identity=None)
    h.state = replace(h.state, coachlab_root=root)
    h.app = create_app(h.state, guard_config({}), phoenix_url=None)
    return h


def seed(root: Path) -> Lesson:
    lesson = Lesson(
        lesson_id="0123456789abcdef",
        text="Before calling an answer evasive, quote it and name the fact it leaves out.",
        candidate_id="A1",
        source_run_ids=("gym-1",),
        source_example_ids=("e" * 64,),
        source_trial_ids=("t-1",),
        created_at="2026-10-15T00:00:00+00:00",
    )
    registry.propose_lessons(root, [lesson])
    registry.review_lesson(root, lesson.lesson_id, "approved", "owner")
    a1 = committed_manifest("A1", root)
    registry.append_versions(
        root,
        [
            registry.VersionEvent(
                version_id="A1@1.2.0",
                candidate_id="A1",
                version="1.2.0",
                status="challenger",
                at="2026-10-15T01:00:00+00:00",
                manifest_path="prompts/manifests/gym/A1-1.2.0.json",
                manifest_sha256="b" * 64,
                parent_sha256=a1.sha256,
                change_note="Coach Gym run gym-1",
                run_id="gym-1",
                lesson_ids=(lesson.lesson_id,),
                metrics={"holdout": {"mean_score": 0.8}},
                verdict={"promote": True, "reasons": []},
            )
        ],
    )
    registry.append_experiment(
        root,
        registry.Experiment(
            run_id="gym-1",
            candidate_id="A1",
            mode="fake",
            champion_id="A1@1.1.0",
            challenger_id="A1@1.2.0",
            started_at="2026-10-15T00:30:00+00:00",
            finished_at="2026-10-15T01:00:00+00:00",
            budget_usd="2",
            spent_usd="0.41",
            dataset_sha256="c" * 64,
            counts={"train": 30, "val": 8, "holdout": 12, "canaries": 2},
            before={"mean_score": 0.6},
            after={"mean_score": 0.8},
            series=[{"candidate": 0, "parent": None, "metric_calls": 8, "val_score": 0.6}],
            verdict={"promote": True, "reasons": []},
            lessons_proposed=[],
            stop_reason="max_evals",
        ),
    )
    return lesson


def test_versions_lessons_and_experiments(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    lesson = seed(root)
    h = harness(root)
    r = h.get("/api/coach-lab/versions")
    assert r.status_code == HTTPStatus.OK
    rows = {v["id"]: v for v in r.json()["versions"]}
    assert (rows["A1@1.1.0"]["status"], rows["A1@1.1.0"]["official"]) == ("champion", True)
    challenger = rows["A1@1.2.0"]
    assert (challenger["status"], challenger["parent_id"]) == ("challenger", "A1@1.1.0")
    assert challenger["metrics"] == {"holdout": {"mean_score": 0.8}}
    lessons = h.get("/api/coach-lab/versions/A1@1.2.0/lessons")
    assert lessons.status_code == HTTPStatus.OK
    assert [(x["lesson_id"], x["status"], x["source_run_ids"]) for x in lessons.json()["lessons"]] == [
        (lesson.lesson_id, "approved", ["gym-1"])
    ]
    assert h.get("/api/coach-lab/versions/A1@9.9.9/lessons").status_code == HTTPStatus.NOT_FOUND
    experiments = h.get("/api/coach-lab/experiments").json()["experiments"]
    assert [(e["run_id"], e["before"], e["after"]) for e in experiments] == [
        ("gym-1", {"mean_score": 0.6}, {"mean_score": 0.8})
    ]


def test_an_empty_registry_shows_the_official_champions(tmp_path: Path) -> None:
    h = harness(gym_root(tmp_path))
    ids = [(v["id"], v["status"]) for v in h.get("/api/coach-lab/versions").json()["versions"]]
    assert ids == [("A1@1.1.0", "champion"), ("A2@1.1.0", "champion"), ("A3@1.1.0", "champion")]
    assert h.get("/api/coach-lab/experiments").json() == {"experiments": []}


def test_coach_lab_is_behind_the_allowlist(tmp_path: Path) -> None:
    h = harness(gym_root(tmp_path), allowlisted=False)
    for path in ("/api/coach-lab/versions", "/api/coach-lab/experiments", "/api/coach-lab/versions/A1@1.1.0/lessons"):
        assert h.get(path).status_code == HTTPStatus.FORBIDDEN
