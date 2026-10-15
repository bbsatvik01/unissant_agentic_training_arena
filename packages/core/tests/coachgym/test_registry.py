"""The append-only Coach Lab registry and the views the API serves."""

from __future__ import annotations

from pathlib import Path

import pytest

from arena_core.agents.manifests import committed_manifest
from arena_core.coachgym import registry
from arena_core.coachgym.playbook import Lesson
from packages.core.tests.coachgym.support import gym_root


def _lesson(i: int, candidate: str = "A1") -> Lesson:
    return Lesson(
        lesson_id=f"{i:016x}",
        text=f"Lesson {i}: quote the answer before calling it evasive.",
        candidate_id=candidate,
        source_run_ids=("gym-1",),
        source_example_ids=("e" * 64,),
        source_trial_ids=("t-1",),
        created_at=registry.now(),
    )


def _challenger(root: Path, version: str = "1.2.0", lessons: tuple[str, ...] = ()) -> registry.VersionEvent:
    a1 = committed_manifest("A1", root)
    return registry.VersionEvent(
        version_id=f"A1@{version}",
        candidate_id="A1",
        version=version,
        status="challenger",
        at=registry.now(),
        manifest_path=f"prompts/manifests/gym/A1-{version}.json",
        manifest_sha256="b" * 64,
        parent_sha256=a1.sha256,
        change_note="gym run",
        run_id="gym-1",
        lesson_ids=lessons,
        metrics={"holdout": {"mean_score": 0.7}},
        verdict={"promote": True, "reasons": []},
    )


def test_the_official_coaches_are_the_champions_of_an_empty_registry(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    view = registry.versions_view(root)
    assert [(v["id"], v["status"], v["official"]) for v in view] == [
        ("A1@1.1.0", "champion", True),
        ("A2@1.1.0", "champion", True),
        ("A3@1.1.0", "champion", True),
    ]
    assert registry.champion(root, "A1").manifest_sha256 == committed_manifest("A1", root).sha256
    assert registry.experiments_view(root) == []


def test_a_challenger_then_a_promotion_by_appended_events(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    registry.append_versions(root, [_challenger(root)])
    by_id = {v["id"]: v for v in registry.versions_view(root)}
    assert by_id["A1@1.2.0"]["status"] == "challenger"
    assert by_id["A1@1.2.0"]["parent_id"] == "A1@1.1.0"
    assert by_id["A1@1.2.0"]["official"] is False
    assert registry.taken_versions(root, "A1") == {"1.1.0", "1.2.0"}
    old, new = registry.champion(root, "A1"), registry.current_versions(root)["A1@1.2.0"]
    registry.append_versions(
        root,
        [
            old.model_copy(update={"status": "retired", "by": "owner"}),
            new.model_copy(update={"status": "champion", "by": "owner", "metrics": None, "verdict": None}),
        ],
    )
    by_id = {v["id"]: v for v in registry.versions_view(root)}
    assert by_id["A1@1.1.0"]["status"] == "retired"
    assert by_id["A1@1.2.0"]["status"] == "champion"
    assert by_id["A1@1.2.0"]["metrics"] == {"holdout": {"mean_score": 0.7}}  # kept from its challenger event
    assert registry.champion(root, "A1").version == "1.2.0"
    lines = (root / registry.VERSIONS).read_text(encoding="utf-8").splitlines()
    assert len(lines) == len(["challenger", "retired", "champion"])  # appended, never rewritten


def test_two_champions_is_an_error(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    registry.append_versions(root, [_challenger(root).model_copy(update={"status": "champion"})])
    with pytest.raises(registry.RegistryError, match="2 champions"):
        registry.champion(root, "A1")


def test_lessons_lifecycle_and_the_version_view(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    one, two, other = _lesson(1), _lesson(2), _lesson(3, "A2")
    registry.propose_lessons(root, [one, two, other])
    registry.propose_lessons(root, [one])  # proposing again files nothing
    assert [x["lesson_id"] for x in registry.pending_view(root)] == [one.lesson_id, two.lesson_id, other.lesson_id]
    registry.review_lesson(root, one.lesson_id, "approved", "owner")
    registry.review_lesson(root, two.lesson_id, "rejected", "owner")
    with pytest.raises(registry.RegistryError, match="already approved"):
        registry.review_lesson(root, one.lesson_id, "rejected", "owner")
    with pytest.raises(registry.RegistryError, match="names its reviewer"):
        registry.review_lesson(root, other.lesson_id, "approved", " ")
    with pytest.raises(registry.RegistryError, match="no lesson"):
        registry.review_lesson(root, "0" * 16, "approved", "owner")
    assert registry.approved_lessons(root, "A1") == [one]
    assert registry.approved_lessons(root, "A2") == []
    registry.append_versions(root, [_challenger(root, lessons=(one.lesson_id,))])
    view = registry.lessons_view(root, "A1@1.2.0")
    assert view is not None
    assert [(x["lesson_id"], x["status"]) for x in view["lessons"]] == [(one.lesson_id, "approved")]
    assert registry.lessons_view(root, "A1@9.9.9") is None
    assert registry.lessons_view(root, "A1@1.1.0") == {"version_id": "A1@1.1.0", "lessons": []}


def test_experiments_newest_first(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    for i, started in enumerate(["2026-10-15T01:00:00+00:00", "2026-10-15T03:00:00+00:00"]):
        registry.append_experiment(
            root,
            registry.Experiment(
                run_id=f"gym-{i}",
                candidate_id="A1",
                mode="fake",
                champion_id="A1@1.1.0",
                challenger_id=None,
                started_at=started,
                finished_at=started,
                budget_usd="1",
                spent_usd="0",
                dataset_sha256="c" * 64,
                counts={"train": 1},
                before=None,
                after=None,
                series=[],
                verdict={"promote": False, "reasons": ["x"]},
                lessons_proposed=[],
                stop_reason="max_evals",
            ),
        )
    assert [e["run_id"] for e in registry.experiments_view(root)] == ["gym-1", "gym-0"]


def test_a_line_that_does_not_parse_fails_the_read(tmp_path: Path) -> None:
    root = gym_root(tmp_path)
    (root / registry.LESSONS).write_text('{"event": "approved"}\n', encoding="utf-8")
    with pytest.raises(registry.RegistryError, match=r"lessons.jsonl:1"):
        registry.lessons(root)
    (root / registry.LESSONS).write_text(
        registry.LessonEvent(event="approved", lesson_id="x", at="t").model_dump_json() + "\n", encoding="utf-8"
    )
    with pytest.raises(registry.RegistryError, match="unknown lesson"):
        registry.lessons(root)
    (root / registry.LESSONS).write_text(
        registry.LessonEvent(event="proposed", lesson_id="x", at="t").model_dump_json() + "\n", encoding="utf-8"
    )
    with pytest.raises(registry.RegistryError, match="without its lesson"):
        registry.lessons(root)
