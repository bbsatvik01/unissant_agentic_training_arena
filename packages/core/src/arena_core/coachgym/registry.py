"""The Coach Lab registry (D-036): append-only JSON-lines files under `coachlab/`, reviewed in git like code.

- `versions.jsonl`: version events. A gym run appends its challenger (with the holdout metrics of champion and
  challenger and the promotion verdict); `make coach-promote` appends `champion` for it and `retired` for the
  version it replaces. A version's status is its latest event. The official coaches (`prompts/manifests/A*.json`)
  are champions until a promotion retires them.
- `lessons.jsonl`: playbook events (`proposed`, then a human's `approved` or `rejected`).
- `experiments.jsonl`: one record per gym run: budget and spend, dataset hash and sizes, the champion's and the
  challenger's holdout metrics (before and after) and GEPA's validation-score series.

Lines are only ever appended; a line that does not parse fails the read (nothing is silently skipped). The
read functions are what arena-api's Coach Lab routes return.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from arena_core.agents.manifests import MANIFEST_DIR, CandidateManifest, committed_manifest
from arena_core.coachgym.playbook import Lesson, LessonStatus

LAB_DIR = "coachlab"
VERSIONS = f"{LAB_DIR}/versions.jsonl"
LESSONS = f"{LAB_DIR}/lessons.jsonl"
EXPERIMENTS = f"{LAB_DIR}/experiments.jsonl"
OFFICIAL_COACHES = ("A1", "A2", "A3")

VersionStatus = Literal["challenger", "champion", "retired"]


class RegistryError(ValueError):
    """A registry line that does not parse, or an event the registry refuses."""


class _Row(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class VersionEvent(_Row):
    version_id: str  # "<candidate_id>@<version>"
    candidate_id: str
    version: str
    status: VersionStatus
    at: str
    manifest_path: str
    manifest_sha256: str
    parent_sha256: str | None
    change_note: str
    run_id: str | None = None
    lesson_ids: tuple[str, ...] = ()
    metrics: dict[str, Any] | None = None
    verdict: dict[str, Any] | None = None
    by: str | None = None


class LessonEvent(_Row):
    event: Literal["proposed", "approved", "rejected"]
    lesson_id: str
    at: str
    by: str | None = None
    lesson: Lesson | None = None  # set on `proposed` only


class Experiment(_Row):
    run_id: str
    candidate_id: str
    mode: Literal["fake", "vertex"]
    champion_id: str
    challenger_id: str | None
    started_at: str
    finished_at: str
    budget_usd: str
    spent_usd: str
    dataset_sha256: str
    counts: dict[str, int]
    before: dict[str, Any] | None  # the champion's holdout metrics
    after: dict[str, Any] | None  # the challenger's holdout metrics
    series: list[dict[str, Any]]  # GEPA: per candidate found, metric calls so far and its validation score
    verdict: dict[str, Any] | None
    lessons_proposed: list[str]
    stop_reason: str


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read[T: _Row](root: Path, rel: str, model: type[T]) -> list[T]:
    path = root / rel
    if not path.is_file():
        return []
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            out.append(model.model_validate_json(line))
        except ValidationError as exc:
            msg = f"{rel}:{i}: not a valid {model.__name__} ({exc.error_count()} error(s))"
            raise RegistryError(msg) from exc
    return out


def _append(root: Path, rel: str, rows: Sequence[_Row]) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as out:
        for row in rows:
            out.write(row.model_dump_json() + "\n")


# ---------------------------------------------------------------- versions


def _official(root: Path) -> list[VersionEvent]:
    out = []
    for cid in OFFICIAL_COACHES:
        path = root / MANIFEST_DIR / f"{cid}.json"
        if not path.is_file():
            continue
        m = committed_manifest(cid, root)
        out.append(
            VersionEvent(
                version_id=f"{cid}@{m.version}",
                candidate_id=cid,
                version=m.version,
                status="champion",
                at="",
                manifest_path=f"{MANIFEST_DIR}/{cid}.json",
                manifest_sha256=m.sha256 or "",
                parent_sha256=m.lineage.parent_sha256,
                change_note=m.lineage.change_note,
            )
        )
    return out


def version_events(root: Path) -> list[VersionEvent]:
    return _read(root, VERSIONS, VersionEvent)


def current_versions(root: Path) -> dict[str, VersionEvent]:
    """Every known version at its latest event: the official coaches first, then the gym's events in order."""
    latest: dict[str, VersionEvent] = {v.version_id: v for v in _official(root)}
    for event in version_events(root):
        first = latest.get(event.version_id)
        # A status event keeps the first event's metrics and verdict unless it brings its own.
        keep = first is not None and event.metrics is None and event.verdict is None
        latest[event.version_id] = (
            event.model_copy(update={"metrics": first.metrics, "verdict": first.verdict}) if keep and first else event
        )
    return latest


def champion(root: Path, candidate_id: str) -> VersionEvent:
    champions = [
        v for v in current_versions(root).values() if v.candidate_id == candidate_id and v.status == "champion"
    ]
    if len(champions) != 1:
        msg = f"{candidate_id}: {len(champions)} champions on record (exactly one expected)"
        raise RegistryError(msg)
    return champions[0]


def append_versions(root: Path, events: Sequence[VersionEvent]) -> None:
    """Append version events. A `challenger` event names a new version only: reusing a version id already on
    record (another run's challenger, a champion, an official version) is refused, so a status is never
    overwritten by a second run's result."""
    known = set(current_versions(root))
    for event in events:
        if event.status == "challenger" and event.version_id in known:
            msg = f"{event.version_id} is already on record; a challenger needs a new version"
            raise RegistryError(msg)
        known.add(event.version_id)
    _append(root, VERSIONS, events)


def versions_view(root: Path) -> list[dict[str, Any]]:
    """`GET /api/coach-lab/versions`: every version with its status, parent, holdout metrics and verdict."""
    current = current_versions(root)
    by_sha = {v.manifest_sha256: v.version_id for v in current.values()}
    return [
        {
            "id": v.version_id,
            "candidate_id": v.candidate_id,
            "version": v.version,
            "status": v.status,
            "official": v.run_id is None,
            "parent_id": by_sha.get(v.parent_sha256 or ""),
            "manifest_sha256": v.manifest_sha256,
            "manifest_path": v.manifest_path,
            "change_note": v.change_note,
            "run_id": v.run_id,
            "created_at": v.at or None,
            "lesson_ids": list(v.lesson_ids),
            "metrics": v.metrics,
            "verdict": v.verdict,
        }
        for v in sorted(current.values(), key=lambda v: (v.candidate_id, [int(p) for p in v.version.split(".")]))
    ]


def manifest_of(root: Path, event: VersionEvent) -> CandidateManifest:
    return CandidateManifest.model_validate(json.loads((root / event.manifest_path).read_text(encoding="utf-8")))


# ---------------------------------------------------------------- lessons


def lesson_events(root: Path) -> list[LessonEvent]:
    return _read(root, LESSONS, LessonEvent)


def lessons(root: Path) -> dict[str, tuple[Lesson, LessonStatus]]:
    """Every lesson with its status (its latest event)."""
    out: dict[str, tuple[Lesson, LessonStatus]] = {}
    for e in lesson_events(root):
        if e.event == "proposed":
            if e.lesson is None or e.lesson.lesson_id != e.lesson_id:
                msg = f"{LESSONS}: proposed event {e.lesson_id} without its lesson"
                raise RegistryError(msg)
            out.setdefault(e.lesson_id, (e.lesson, "pending"))
        elif e.lesson_id in out:
            out[e.lesson_id] = (out[e.lesson_id][0], e.event)
        else:
            msg = f"{LESSONS}: {e.event} event for unknown lesson {e.lesson_id}"
            raise RegistryError(msg)
    return out


def propose_lessons(root: Path, new: Sequence[Lesson]) -> None:
    known = lessons(root)
    rows = [
        LessonEvent(event="proposed", lesson_id=x.lesson_id, at=now(), lesson=x)
        for x in new
        if x.lesson_id not in known
    ]
    _append(root, LESSONS, rows)


def review_lesson(root: Path, lesson_id: str, decision: Literal["approved", "rejected"], by: str) -> None:
    """A human's decision on a pending lesson (a decided lesson is never re-decided: append-only history)."""
    known = lessons(root)
    if lesson_id not in known:
        msg = f"no lesson {lesson_id}"
        raise RegistryError(msg)
    if known[lesson_id][1] != "pending":
        msg = f"lesson {lesson_id} is already {known[lesson_id][1]}"
        raise RegistryError(msg)
    if not by.strip():
        msg = "a lesson review names its reviewer"
        raise RegistryError(msg)
    _append(root, LESSONS, [LessonEvent(event=decision, lesson_id=lesson_id, at=now(), by=by.strip())])


def approved_lessons(root: Path, candidate_id: str) -> list[Lesson]:
    return [x for x, status in lessons(root).values() if status == "approved" and x.candidate_id == candidate_id]


def lessons_view(root: Path, version_id: str) -> dict[str, Any] | None:
    """`GET /api/coach-lab/versions/{id}/lessons`: the lessons rendered into that version, with their status
    today; None for an unknown version."""
    current = current_versions(root)
    if version_id not in current:
        return None
    known = lessons(root)
    rows = []
    for lid in current[version_id].lesson_ids:
        lesson, status = known[lid]
        rows.append({**lesson.model_dump(mode="json"), "status": status})
    return {"version_id": version_id, "lessons": rows}


def pending_view(root: Path) -> list[dict[str, Any]]:
    return [{**x.model_dump(mode="json"), "status": s} for x, s in lessons(root).values() if s == "pending"]


# ---------------------------------------------------------------- experiments


def append_experiment(root: Path, experiment: Experiment) -> None:
    _append(root, EXPERIMENTS, [experiment])


def experiments_view(root: Path) -> list[dict[str, Any]]:
    """`GET /api/coach-lab/experiments`: every gym run, newest first, with its before/after metrics and series."""
    rows = list(enumerate(_read(root, EXPERIMENTS, Experiment)))
    # Newest first; two runs started in the same second keep their file (append) order, reversed.
    return [r.model_dump(mode="json") for _, r in sorted(rows, key=lambda p: (p[1].started_at, p[0]), reverse=True)]


def taken_versions(root: Path, candidate_id: str) -> set[str]:
    return {v.version for v in current_versions(root).values() if v.candidate_id == candidate_id}


def as_json(rows: Mapping[str, Any] | Sequence[Any]) -> str:
    return json.dumps(rows, indent=2, sort_keys=True) + "\n"
