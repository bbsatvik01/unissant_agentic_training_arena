"""Instructor mode on the referee origin (UI v2, D-036): the role gate, the class from the allowlist, assignments
and notes, through a real ASGI call. The SQL is faked at `arena_referee.instructor`'s own functions here and runs
against the real migrated schema in `it_admin.py` (make db-test)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Iterable
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI

from arena_core.identity import load_allowlist, user_id_for
from arena_referee import instructor
from arena_referee.app import create_app
from services.referee.tests.test_app import BASE_ENV, HOST_HEADER, ORIGIN

TEACHER = "teacher@example.com"
TRAINEE = "trainee@example.com"
ADMIN = "admin@example.com"
VARIANT = uuid4()
TRIAL = uuid4()
NOTED = "2026-10-15T00:00:00+00:00"


def run[T](aw: Awaitable[T]) -> T:
    async def go() -> T:
        return await aw

    return asyncio.run(go())


def _users(tmp_path: Path) -> Path:
    path = tmp_path / "users.toml"
    path.write_text(
        f'[[users]]\nemail = "{TEACHER}"\ndisplay_name = "Teacher"\nroles = ["instructor"]\n'
        f'[[users]]\nemail = "{TRAINEE}"\ndisplay_name = "Bea Trainee"\nroles = ["investigator"]\n'
        f'[[users]]\nemail = "{ADMIN}"\ndisplay_name = "Admin"\nroles = ["admin", "trainer"]\n'
    )
    return path


def _app(tmp_path: Path, user: str = TEACHER) -> FastAPI:
    return create_app({**BASE_ENV, "ARENA_USERS_FILE": str(_users(tmp_path)), "ARENA_DEV_USER": user})


class FakeStore:
    def __init__(self) -> None:
        self.assigned: list[tuple[UUID, UUID, UUID]] = []
        self.notes: list[tuple[UUID, UUID, int, str]] = []

    async def class_progress(self, _connect: object, users: Iterable[instructor.Trainee]) -> list[dict[str, Any]]:
        return [{"user_id": str(t.user_id), "display_name": t.display_name} for t in users]

    async def dev_variant(self, _connect: object, case_id: str) -> UUID | None:
        return VARIANT if case_id == "C-AAAAAAAA" else None

    async def assign(self, _connect: object, user: UUID, variant: UUID, by: UUID) -> dict[str, Any]:
        self.assigned.append((user, variant, by))
        return {"assignment_id": "a1", "assigned_at": "2026-10-15T00:00:00+00:00"}

    async def training_trial(self, _connect: object, trial: UUID) -> bool:
        return trial == TRIAL

    async def annotate(self, _connect: object, trial: UUID, author: UUID, t_ms: int, text: str) -> dict[str, Any]:
        self.notes.append((trial, author, t_ms, text))
        return {"annotation_id": "n1", "t_ms": t_ms, "text": text, "created_at": "2026-10-15T00:00:00+00:00"}


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeStore:
    fake = FakeStore()
    for name in ("class_progress", "dev_variant", "assign", "training_trial", "annotate"):
        monkeypatch.setattr(instructor, name, getattr(fake, name))
    return fake


async def _call(app: FastAPI, method: str, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        me = await client.get("/api/me", headers={"host": HOST_HEADER})
        csrf = me.json().get("csrf_token", "")
        client.cookies.set("arena_console_csrf", csrf)
        headers = {"host": HOST_HEADER, "origin": ORIGIN, "sec-fetch-site": "same-origin", "x-arena-console-csrf": csrf}
        return await client.request(method, path, json=body, headers=headers)


def test_the_class_is_the_allowlists_investigators(tmp_path: Path, store: FakeStore) -> None:
    del store
    r = run(_call(_app(tmp_path), "GET", "/api/instructor/class"))
    assert r.status_code == httpx.codes.OK, r.text
    assert r.json() == {"trainees": [{"user_id": str(user_id_for(TRAINEE)), "display_name": "Bea Trainee"}]}


def test_an_instructor_opens_the_console_and_others_are_refused_instructor_mode(
    tmp_path: Path, store: FakeStore
) -> None:
    me = run(_call(_app(tmp_path), "GET", "/api/me"))
    assert me.json()["roles"] == ["instructor"]
    for user in (ADMIN, TRAINEE):
        app = _app(tmp_path, user)
        assert run(_call(app, "GET", "/api/instructor/class")).status_code == httpx.codes.FORBIDDEN
        body = {"user_id": str(user_id_for(TRAINEE)), "case_id": "C-AAAAAAAA"}
        assert run(_call(app, "POST", "/api/instructor/assignments", body)).status_code == httpx.codes.FORBIDDEN
        note = {"t_ms": 5, "text": "x"}
        assert run(_call(app, "POST", f"/api/trials/{TRIAL}/annotations", note)).status_code == httpx.codes.FORBIDDEN
    assert store.assigned == []
    assert store.notes == []


def test_an_assignment_names_a_trainee_and_a_dev_case(tmp_path: Path, store: FakeStore) -> None:
    app = _app(tmp_path)
    trainee = str(user_id_for(TRAINEE))
    r = run(_call(app, "POST", "/api/instructor/assignments", {"user_id": trainee, "case_id": "C-AAAAAAAA"}))
    assert r.status_code == httpx.codes.OK, r.text
    assert r.json() == {
        "assignment_id": "a1",
        "assigned_at": "2026-10-15T00:00:00+00:00",
        "user_id": trainee,
        "case_id": "C-AAAAAAAA",
    }
    assert store.assigned == [(user_id_for(TRAINEE), VARIANT, user_id_for(TEACHER))]
    unknown_case = {"user_id": trainee, "case_id": "C-BBBBBBBB"}
    assert run(_call(app, "POST", "/api/instructor/assignments", unknown_case)).status_code == httpx.codes.NOT_FOUND
    not_trainee = {"user_id": str(user_id_for(ADMIN)), "case_id": "C-AAAAAAAA"}
    assert run(_call(app, "POST", "/api/instructor/assignments", not_trainee)).status_code == httpx.codes.NOT_FOUND
    bad = {"user_id": trainee, "case_id": "F01"}
    assert run(_call(app, "POST", "/api/instructor/assignments", bad)).status_code == httpx.codes.UNPROCESSABLE_ENTITY
    assert len(store.assigned) == 1


def test_a_note_goes_on_a_training_trial_only(tmp_path: Path, store: FakeStore) -> None:
    app = _app(tmp_path)
    r = run(_call(app, "POST", f"/api/trials/{TRIAL}/annotations", {"t_ms": 4200, "text": "Good open question."}))
    assert r.status_code == httpx.codes.OK, r.text
    assert r.json() == {"annotation_id": "n1", "t_ms": 4200, "text": "Good open question.", "created_at": NOTED}
    assert store.notes == [(TRIAL, user_id_for(TEACHER), 4200, "Good open question.")]
    other = run(_call(app, "POST", f"/api/trials/{uuid4()}/annotations", {"t_ms": 1, "text": "x"}))
    assert other.status_code == httpx.codes.NOT_FOUND
    for body in ({"t_ms": -1, "text": "x"}, {"t_ms": 1, "text": ""}, {"t_ms": 1, "text": "x" * 2001}, {"t_ms": 1}):
        resp = run(_call(app, "POST", f"/api/trials/{TRIAL}/annotations", body))
        assert resp.status_code == httpx.codes.UNPROCESSABLE_ENTITY, body
    assert len(store.notes) == 1


def test_trainees_are_sorted_and_only_investigators(tmp_path: Path) -> None:
    allowlist = load_allowlist(_users(tmp_path))
    assert [t.display_name for t in instructor.trainees(allowlist)] == ["Bea Trainee"]
