"""`create_app` (S5 1, 10.1, 10.3): the D10 guard on every request, the console, review and internal
scoring/debrief routes, dispatched through a real ASGI call (`httpx.ASGITransport`, not
`starlette.testclient` -- its `httpx` deprecation warning fails under this repo's `-W error`). The
internal pipelines (`score_trial`, `publish_session_debrief`) are faked at the route's own import site
(they are proven directly in `test_scoring.py`/`test_debrief.py`); this file is the HTTP wiring: D10,
identity, status codes and body shapes.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Mapping
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
from fastapi import FastAPI

from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.identity import DevIdentity, user_id_for
from arena_core.referee.pipeline import ValidityDecision
from arena_core.scoring.ranking import IG_ITEMS, isolation_result
from arena_core.scoring.rubric import lineage_checked_sha256
from arena_referee import admin_db, db
from arena_referee.app import create_app
from arena_referee.debrief import SessionNotEndedError
from arena_referee.isolation import IsolationGateRequest
from arena_referee.reveal import PublishContext
from arena_referee.routes import admin as admin_route
from arena_referee.routes import debrief as debrief_route
from arena_referee.routes import reveal as reveal_route
from arena_referee.routes import score as score_route
from arena_referee.routes import tournaments as tournaments_route
from arena_referee.scoring import ScoreResult

ORIGIN = "http://127.0.0.1:8082"
HOST_HEADER = "127.0.0.1:8082"
# Fixture value only: this test hashes it itself below, exactly as a real caller's credential is hashed.
CALLER_CREDENTIAL = "test-caller-credential"
CALLER_HASH = hashlib.sha256(CALLER_CREDENTIAL.encode()).hexdigest()
ADMIN_EMAIL = "admin@example.com"
VIEWER_EMAIL = "viewer@example.com"

BASE_ENV: Mapping[str, str] = {
    "ARENA_ROLE": "referee",
    "ARENA_GCP_PROJECT": "cna-guardian",
    "ARENA_REFEREE_DSN": "postgresql://referee:x@127.0.0.1:1/db",
    "ARENA_ENV": "local",
    "ARENA_BIND_HOST": "127.0.0.1",
    "ARENA_MODEL_MODE": "fake",
    "ARENA_LOCAL_CALLERS": CALLER_HASH,
    "ARENA_GIT_SHA": "f" * 40,  # fixture value only: a real deployment's own commit sha
}


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


def _write_users_file(tmp_path: Path) -> Path:
    path = tmp_path / "users.toml"
    path.write_text(
        "[[users]]\n"
        f'email = "{ADMIN_EMAIL}"\n'
        'display_name = "Admin User"\n'
        'roles = ["admin", "trainer"]\n'
        "[[users]]\n"
        f'email = "{VIEWER_EMAIL}"\n'
        'display_name = "Viewer User"\n'
        'roles = ["investigator"]\n'
    )
    return path


def make_app(tmp_path: Path, *, dev_user: str = ADMIN_EMAIL) -> FastAPI:
    env = {**BASE_ENV, "ARENA_USERS_FILE": str(_write_users_file(tmp_path)), "ARENA_DEV_USER": dev_user}
    return create_app(env)


def _identity(email: str, roles: frozenset[str]) -> DevIdentity:
    return DevIdentity(user_id=user_id_for(email), email=email, display_name=email, roles=roles)


async def _get(
    app: FastAPI, path: str, *, host: str | None = HOST_HEADER, headers: dict[str, str] | None = None
) -> httpx.Response:
    request_headers = dict(headers or {})
    if host is not None:
        request_headers["host"] = host
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN) as client:
        return await client.get(path, headers=request_headers)


async def _post(
    app: FastAPI,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> httpx.Response:
    request_headers = {"host": HOST_HEADER, **(headers or {})}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, cookies=cookies) as client:
        return await client.post(path, json=json or {}, headers=request_headers)


IG123_NAMES = ((1, "privilege_tests"), (2, "route_tests"), (3, "assistant_context"))


async def _post_no_body(app: FastAPI, path: str, *, headers: dict[str, str], cookies: dict[str, str]) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN, cookies=cookies) as client:
        return await client.post(path, headers={"host": HOST_HEADER, **headers})


def _browser_post_headers(csrf: str) -> dict[str, str]:
    return {"origin": ORIGIN, "sec-fetch-site": "same-origin", "x-arena-csrf": csrf}


FORBIDDEN = 403
UNAUTHORIZED = 401
DNS_REBINDING = 421
NOT_FOUND = 404
UNPROCESSABLE = 422


# ---------------------------------------------------------------- D10: Host, health


def test_create_app_refuses_to_boot_without_arena_git_sha(tmp_path: Path) -> None:
    # Codex finding #3: a silent "0"*40 default would let every misconfigured deployment share one fake
    # identity for isolation-gate and leaderboard evidence, defeating S3 9's code-version binding.
    env = {**BASE_ENV, "ARENA_USERS_FILE": str(_write_users_file(tmp_path)), "ARENA_DEV_USER": ADMIN_EMAIL}
    del env["ARENA_GIT_SHA"]
    with pytest.raises(RuntimeError, match="ARENA_GIT_SHA"):
        create_app(env)


def test_debrief_provenance_uses_the_rubric_hash_not_the_prompt_manifest_hash(tmp_path: Path) -> None:
    """`rubric_sha256` (S3 2.11: lexicon, prompt texts and model ids) is a different provenance concern
    than the referee agent manifest's own hash (R1/R2's system prompts) -- conflating them would make a
    rubric-only change invisible in a published debrief's provenance."""
    app = make_app(tmp_path)
    provenance = app.state.debrief_deps.provenance
    assert provenance.rubric_sha256 == lineage_checked_sha256()
    assert provenance.rubric_sha256 != provenance.r3_prompt_sha256[0]


def test_health_passes_the_host_check_and_needs_no_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_get(app, "/api/health"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"ok": True}


def test_a_foreign_host_is_refused_421_before_any_route(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_get(app, "/api/health", host="evil.example"))
    assert resp.status_code == DNS_REBINDING


# ---------------------------------------------------------------- console (S5 5.5)


def test_get_me_mints_a_csrf_cookie_and_returns_the_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_get(app, "/api/me"))
    assert resp.status_code == httpx.codes.OK
    body = resp.json()
    assert body["display_name"] == "Admin User"
    assert sorted(body["roles"]) == ["admin", "trainer"]
    assert "csrf_token" in body
    assert "arena_csrf" in resp.cookies


def test_get_me_refuses_an_identity_without_a_console_role(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)
    resp = run(_get(app, "/api/me"))
    assert resp.status_code == FORBIDDEN


def test_get_me_refuses_when_there_is_no_identity_at_all(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    app.state.identity = None
    resp = run(_get(app, "/api/me"))
    assert resp.status_code == FORBIDDEN


def test_get_config_succeeds_for_an_admin_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_get(app, "/api/config"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"phoenix_url": None, "paused": False}


# ---------------------------------------------------------------- review queue (S3 7.3)

LAB_PAYLOAD: dict[str, Any] = {
    "task": "T-LAB",
    "item_id": str(uuid4()),
    "initial_documents": [],
    "released": [],
    "transcript": [{"turn_no": 1, "question": "Why were you there?", "answer": "A work order.", "partial": False}],
    "facts": [{"id": "f:01", "class": "FREE", "text": "A fact that is long enough.", "certainty": "certain"}],
    "uncertainty": [],
    "gates": [],
    "permitted_behaviors": [],
    "canonical_facts": [{"id": "f:01", "statement": "A canonical fact, long enough to pass validation."}],
}

LAB_SUBMISSION: dict[str, Any] = {
    "task": "T-LAB",
    "turns": [
        {
            "turn_id": "t01",
            "label": "responsive",
            "eva_subtype": None,
            "pfq_reason": None,
            "no_contradiction": True,
            "no_invention": True,
            "uncertainty_respected": True,
            "disclosure_policy_respected": True,
            "in_character": True,
            "platform_attack": False,
        }
    ],
}


def test_list_review_items_needs_a_trainer_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)  # investigator only, not trainer
    resp = run(_get(app, "/api/review/items"))
    assert resp.status_code == FORBIDDEN


def test_list_review_items_returns_the_rater_s_queue(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_list(_connect: object, _rater: UUID) -> list[dict[str, Any]]:
        return [{"item_id": str(uuid4()), "task": "T-LAB", "submitted": False}]

    monkeypatch.setattr(db, "list_review_items", fake_list)
    resp = run(_get(app, "/api/review/items"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json()["items"][0]["task"] == "T-LAB"


def test_get_review_item_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_get(_connect: object, _item_id: UUID, _rater: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    resp = run(_get(app, f"/api/review/items/{uuid4()}"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json()["task"] == "T-LAB"


def test_get_review_item_not_assigned_is_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_get(_connect: object, _item_id: UUID, _rater: UUID) -> None:
        return None

    monkeypatch.setattr(db, "get_review_item", fake_get)
    resp = run(_get(app, f"/api/review/items/{uuid4()}"))
    assert resp.status_code == NOT_FOUND


def test_submit_review_item_succeeds_with_a_valid_d10_request(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_get(_connect: object, _item_id: UUID, _rater: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    async def fake_submit(
        _connect: object, _item_id: UUID, _rater: UUID, submission: Mapping[str, Any]
    ) -> dict[str, Any]:
        return {"status": "submitted", "task": submission["task"]}

    monkeypatch.setattr(db, "get_review_item", fake_get)
    monkeypatch.setattr(db, "submit_review_item", fake_submit)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/review/items/{uuid4()}",
            json=LAB_SUBMISSION,
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"status": "submitted", "task": "T-LAB"}


def test_submit_review_item_without_csrf_is_refused_by_d10(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_post(app, f"/api/review/items/{uuid4()}", json=LAB_SUBMISSION, headers={"origin": ORIGIN}))
    assert resp.status_code == FORBIDDEN


def test_submit_review_item_not_assigned_is_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_get(_connect: object, _item_id: UUID, _rater: UUID) -> None:
        return None

    monkeypatch.setattr(db, "get_review_item", fake_get)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/review/items/{uuid4()}",
            json=LAB_SUBMISSION,
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == NOT_FOUND


def test_submit_review_item_rejects_a_malformed_submission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_get(_connect: object, _item_id: UUID, _rater: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/review/items/{uuid4()}",
            json={"task": "T-LAB"},  # missing "turns"
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == UNPROCESSABLE


# ---------------------------------------------------------------- internal routes (D10 caller policy)


def _caller_headers() -> dict[str, str]:
    return {"authorization": f"Bearer {CALLER_CREDENTIAL}"}


def test_score_route_needs_the_internal_caller_token(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score"))
    assert resp.status_code == UNAUTHORIZED


def test_score_route_refuses_a_browser_even_with_the_right_token(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    headers = {**_caller_headers(), "origin": ORIGIN}
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=headers))
    assert resp.status_code == FORBIDDEN


def test_score_route_reports_the_verdict(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    async def fake_score_trial(_deps: object, _trial_id: str, _ctx: object) -> ScoreResult:
        return ScoreResult(
            subject_report=_fake_subject_report(),
            assistant_report=_fake_assistant_report(),
            validity=ValidityDecision(verdict="valid", deciding_turns=(), auto_recordable=True, reason="clean"),
        )

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "interactive"

    app = make_app(tmp_path)
    monkeypatch.setattr(score_route, "score_trial", fake_score_trial)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"verdict": "valid", "auto_recordable": True}


def test_score_route_maps_a_lookup_error_to_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    async def fake_score_trial(_deps: object, trial_id: str, _ctx: object) -> ScoreResult:
        msg = f"no trial {trial_id}"
        raise LookupError(msg)

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "interactive"

    app = make_app(tmp_path)
    monkeypatch.setattr(score_route, "score_trial", fake_score_trial)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == NOT_FOUND


def test_score_route_rejects_an_unknown_trial_before_scoring(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> None:
        return None

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == NOT_FOUND


def test_score_route_refuses_a_non_interactive_trial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """S5 5.3: corpus and replay trials have a different call shape and are WP-16/WP-17's to wire; this
    route refuses them with a clear error rather than silently mis-scoring them."""

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay_corpus"

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == UNPROCESSABLE


def test_debrief_route_publishes_and_returns_the_payload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    async def fake_publish(_deps: object, _ctx: object, session_id: str) -> dict[str, Any]:
        return {"schema_version": "debrief.v1", "session_id": session_id}

    app = make_app(tmp_path)
    monkeypatch.setattr(debrief_route, "publish_session_debrief", fake_publish)
    session_id = str(uuid4())
    resp = run(_post(app, f"/internal/sessions/{session_id}/debrief", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"schema_version": "debrief.v1", "session_id": session_id}


def test_debrief_route_maps_a_lookup_error_to_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    async def fake_publish(_deps: object, _ctx: object, session_id: str) -> dict[str, Any]:
        msg = f"no session {session_id}"
        raise LookupError(msg)

    app = make_app(tmp_path)
    monkeypatch.setattr(debrief_route, "publish_session_debrief", fake_publish)
    resp = run(_post(app, f"/internal/sessions/{uuid4()}/debrief", headers=_caller_headers()))
    assert resp.status_code == NOT_FOUND


CONFLICT = 409


def test_debrief_route_maps_a_session_not_ended_error_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_publish(_deps: object, _ctx: object, session_id: str) -> dict[str, Any]:
        msg = f"session {session_id}'s trial has status 'running', not yet ended"
        raise SessionNotEndedError(msg)

    app = make_app(tmp_path)
    monkeypatch.setattr(debrief_route, "publish_session_debrief", fake_publish)
    resp = run(_post(app, f"/internal/sessions/{uuid4()}/debrief", headers=_caller_headers()))
    assert resp.status_code == CONFLICT


def _fake_subject_report() -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {"schema_version": "ref_subj.v5", "turns": [], "trajectory": {"self_consistent": True, "conflicts": []}}
    )


def _fake_assistant_report() -> RefereeAssistantReport:
    return RefereeAssistantReport.model_validate(
        {"schema_version": "ref_asst.v2", "flags": [], "followups": [], "citations": [], "subchecks": []}
    )


# ---------------------------------------------------------------- reveal, corrections, isolation gate (WP-16)

PASSING_ISOLATION = isolation_result({item: (True, f"{item}-hash") for item in IG_ITEMS})
REVEAL_RESULT = db.RevealResult(manifest_id=str(uuid4()), manifest_sha256="a" * 64, manifest_version=1)


async def _hidden_split(_connect: object, _tournament_id: str) -> str:
    return "hidden"


class _Blocked(psycopg.Error):
    """A stand-in for the AR020/AR021 SQL exception `ledger.reveal` raises; psycopg's own `Error.sqlstate`
    is a plain class attribute, so overriding it here needs no real connection or `ErrorInfo`."""

    sqlstate = "AR020"


def test_reveal_route_needs_an_admin_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)
    me_admin = run(_get(make_app(tmp_path), "/api/me"))
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/reveal",
            headers=_browser_post_headers(me_admin.json()["csrf_token"]),
        )
    )
    assert resp.status_code == FORBIDDEN


def test_reveal_route_publishes_and_returns_the_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_fetch_isolation(_connect: object, _git_sha: str) -> object:
        return PASSING_ISOLATION

    async def fake_reveal_and_publish(_connect: object, _tournament_id: str, _ctx: object) -> db.RevealResult:
        return REVEAL_RESULT

    monkeypatch.setattr(reveal_route, "fetch_fresh_isolation_result", fake_fetch_isolation)
    monkeypatch.setattr(db, "fetch_tournament_split", _hidden_split)
    monkeypatch.setattr(reveal_route, "reveal_and_publish", fake_reveal_and_publish)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/reveal",
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {
        "manifest_id": REVEAL_RESULT.manifest_id,
        "manifest_sha256": REVEAL_RESULT.manifest_sha256,
        "manifest_version": 1,
    }


def test_reveal_route_maps_a_blocked_precondition_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_fetch_isolation(_connect: object, _git_sha: str) -> object:
        return PASSING_ISOLATION

    async def fake_reveal_and_publish(_connect: object, _tournament_id: str, _ctx: object) -> db.RevealResult:
        msg = "reveal follows scoring"
        raise _Blocked(msg)

    monkeypatch.setattr(reveal_route, "fetch_fresh_isolation_result", fake_fetch_isolation)
    monkeypatch.setattr(db, "fetch_tournament_split", _hidden_split)
    monkeypatch.setattr(reveal_route, "reveal_and_publish", fake_reveal_and_publish)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/reveal",
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == CONFLICT


def test_correction_route_publishes_a_corrected_board(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)
    corrected = db.RevealResult(manifest_id=str(uuid4()), manifest_sha256="b" * 64, manifest_version=2)

    async def fake_fetch_isolation(_connect: object, _git_sha: str) -> object:
        return PASSING_ISOLATION

    async def fake_correction(_connect: object, _tournament_id: str, _ctx: object) -> db.RevealResult:
        return corrected

    monkeypatch.setattr(reveal_route, "fetch_fresh_isolation_result", fake_fetch_isolation)
    monkeypatch.setattr(db, "fetch_tournament_split", _hidden_split)
    monkeypatch.setattr(reveal_route, "seal_correction_and_publish", fake_correction)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/corrections",
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json()["manifest_version"] == corrected.manifest_version


class _SqlConn:
    """A fake connection answering by SQL substring (first match wins), recording every statement."""

    def __init__(self, answers: list[tuple[str, list[tuple[Any, ...]]]]) -> None:
        self.answers = answers
        self.executed: list[str] = []

    async def execute(self, query: str, _params: tuple[Any, ...] = ()) -> _SqlCursor:
        self.executed.append(query)
        return _SqlCursor(next((rows for key, rows in self.answers if key in query), []))

    def transaction(self) -> contextlib.AbstractAsyncContextManager[None]:
        return contextlib.nullcontext()


class _SqlCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self.rows)


def test_a_dev_tournament_opens_and_reveals_with_no_hidden_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Codex r3 #2: a dev open records no gate results and there is no hidden seal; reveal must still pass the
    # dev gate (IG-5, IG-6 live) and never read the hidden seal or a hidden corpus.
    dev_family = {"family_id": "F01", "variants": {"truthful": {"private_packet": {"canary": "CANARY-F01"}}}}
    conn = _SqlConn(
        [
            ("from arena.tournaments", [("dev",)]),
            ("distinct on (check_name)", [(f"ig{k}_{n}", True, f"h{k}") for k, n in IG123_NAMES]),
            ("from sealed.family_ingests", [(json.dumps(dev_family),)]),
            ("ledger.verify_chain", [(None,)]),
            ("ledger.corpus_seals", [(True,)]),
        ]
    )

    @contextlib.asynccontextmanager
    async def connect() -> AsyncIterator[_SqlConn]:
        yield conn

    seen: list[PublishContext] = []

    async def fake_reveal_and_publish(_connect: object, _tournament_id: str, ctx: PublishContext) -> db.RevealResult:
        seen.append(ctx)
        return REVEAL_RESULT

    app = make_app(tmp_path)
    app.state.connect = connect
    monkeypatch.setattr(reveal_route, "reveal_and_publish", fake_reveal_and_publish)
    csrf = run(_get(app, "/api/me")).json()["csrf_token"]
    tournament = uuid4()
    post = {"headers": _browser_post_headers(csrf), "cookies": {"arena_csrf": csrf}}
    opened = run(_post_no_body(app, f"/api/admin/tournaments/{tournament}/open", **post))
    assert opened.json() == {"opened": True, "gated": False}
    resp = run(_post(app, f"/api/admin/tournaments/{tournament}/reveal", **post))
    assert resp.status_code == httpx.codes.OK, resp.text
    assert seen[0].isolation.passed
    assert sorted(seen[0].isolation.items) == ["IG-1", "IG-2", "IG-3", "IG-5", "IG-6"]
    assert not any("hidden_seal" in q or "hidden_split_seals" in q for q in conn.executed)
    assert sum("insert into arena.isolation_checks" in q for q in conn.executed) == len(seen[0].isolation.items)
    # Before IG-1..3 were ever recorded for this commit, reveal is blocked with a clear 409, never a 500.
    conn.answers = [a for a in conn.answers if a[0] != "distinct on (check_name)"]
    assert run(_post(app, f"/api/admin/tournaments/{tournament}/reveal", **post)).status_code == CONFLICT


def test_leaderboard_route_needs_a_console_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)  # investigator only
    resp = run(_get(app, f"/api/admin/tournaments/{uuid4()}/leaderboard"))
    assert resp.status_code == FORBIDDEN


def test_leaderboard_route_returns_the_published_body(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_fetch(_connect: object, _tournament_id: str, *, board: str, label: str) -> dict[str, Any]:
        assert (board, label) == ("subject", "corrected")
        return {"status": "definitive", "rows": []}

    monkeypatch.setattr(db, "fetch_leaderboard", fake_fetch)
    resp = run(_get(app, f"/api/admin/tournaments/{uuid4()}/leaderboard?label=corrected&board=subject"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"status": "definitive", "rows": []}


def test_leaderboard_route_404s_before_any_board_is_published(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_fetch(_connect: object, _tournament_id: str, *, board: str, label: str) -> None:
        assert (board, label) == ("assistant", "original")

    monkeypatch.setattr(db, "fetch_leaderboard", fake_fetch)
    resp = run(_get(app, f"/api/admin/tournaments/{uuid4()}/leaderboard"))
    assert resp.status_code == NOT_FOUND


def test_get_isolation_gate_needs_an_admin_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)
    resp = run(_get(app, "/api/admin/isolation-gate"))
    assert resp.status_code == FORBIDDEN


def test_get_isolation_gate_reads_the_latest_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_fetch(_connect: object, _git_sha: str) -> object:
        return PASSING_ISOLATION

    monkeypatch.setattr(db, "fetch_isolation_result", fake_fetch)
    resp = run(_get(app, "/api/admin/isolation-gate"))
    assert resp.status_code == httpx.codes.OK
    assert resp.json()["passed"] is True


def test_run_isolation_gate_route_rejects_a_malformed_body(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            "/api/admin/isolation-gate/run",
            json={"tournament_id": str(uuid4())},  # missing ig1/ig2/ig3
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == UNPROCESSABLE


def test_run_isolation_gate_route_runs_and_returns_the_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)

    async def fake_run(_connect: object, request: IsolationGateRequest) -> object:
        assert request.ig1 == (True, "pgtap ok")
        return PASSING_ISOLATION

    monkeypatch.setattr(admin_route, "run_isolation_gate", fake_run)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            "/api/admin/isolation-gate/run",
            json={
                "ig1": {"passed": True, "report_text": "pgtap ok"},
                "ig2": {"passed": True, "report_text": "routes ok"},
                "ig3": {"passed": True, "report_text": "context ok"},
            },
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json()["passed"] is True


def _open_body() -> dict[str, object]:
    return {
        "ig1": {"passed": True, "report_text": "pgtap ok"},
        "ig2": {"passed": True, "report_text": "routes ok"},
        "ig3": {"passed": True, "report_text": "context ok"},
    }


def _stub_split(monkeypatch: pytest.MonkeyPatch, split: str) -> None:
    async def fake_split(_connect: object, _tournament_id: str) -> str:
        return split

    monkeypatch.setattr(db, "fetch_tournament_split", fake_split)


def test_open_route_needs_an_admin_identity(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)
    me_admin = run(_get(make_app(tmp_path), "/api/me"))
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/open",
            json=_open_body(),
            headers=_browser_post_headers(me_admin.json()["csrf_token"]),
        )
    )
    assert resp.status_code == FORBIDDEN


def test_open_route_rejects_a_malformed_body(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)
    _stub_split(monkeypatch, "hidden")
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/open",
            json={},  # missing ig1/ig2/ig3
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == UNPROCESSABLE


def test_open_route_opens_a_dev_tournament_directly_with_no_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Codex finding #4: a dev-split tournament has no hidden seal to verify; it must open directly, never
    # go through the hidden-text-scan gate (which would 409 it forever), and needs no ig1/ig2/ig3 body.
    app = make_app(tmp_path)
    _stub_split(monkeypatch, "dev")
    opened = []

    async def fake_open_tournament(_connect: object, tournament_id: str) -> None:
        opened.append(tournament_id)

    monkeypatch.setattr(db, "open_tournament", fake_open_tournament)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    tid = str(uuid4())
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{tid}/open",
            json={},
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"opened": True, "gated": False}
    assert opened == [tid]


def test_open_route_opens_on_a_passing_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)
    _stub_split(monkeypatch, "hidden")

    async def fake_open(_connect: object, _tournament_id: str, request: IsolationGateRequest) -> object:
        assert request.ig1 == (True, "pgtap ok")
        return PASSING_ISOLATION

    monkeypatch.setattr(reveal_route, "open_hidden_tournament", fake_open)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/open",
            json=_open_body(),
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {
        "opened": True,
        "gated": True,
        "passed": True,
        "evidence_hash": PASSING_ISOLATION.evidence_hash,
    }


def test_open_route_maps_a_failing_gate_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)
    _stub_split(monkeypatch, "hidden")

    async def fake_open(_connect: object, _tournament_id: str, _request: IsolationGateRequest) -> object:
        msg = "isolation gate failed"
        raise RuntimeError(msg)

    monkeypatch.setattr(reveal_route, "open_hidden_tournament", fake_open)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/open",
            json=_open_body(),
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == CONFLICT


def test_open_route_maps_a_blocked_precondition_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app = make_app(tmp_path)
    _stub_split(monkeypatch, "hidden")

    async def fake_open(_connect: object, _tournament_id: str, _request: IsolationGateRequest) -> object:
        msg = "only a frozen tournament can open"
        raise _Blocked(msg)

    monkeypatch.setattr(reveal_route, "open_hidden_tournament", fake_open)
    me = run(_get(app, "/api/me"))
    csrf = me.json()["csrf_token"]
    resp = run(
        _post(
            app,
            f"/api/admin/tournaments/{uuid4()}/open",
            json=_open_body(),
            headers=_browser_post_headers(csrf),
            cookies={"arena_csrf": csrf},
        )
    )
    assert resp.status_code == CONFLICT


# ---------------------------------------------------------------- admin console routes (S5 5.5 admin table)


ROWS_ADDED = 3  # what the stand-in's add_planned_trials answers
TOURNAMENT_ROW = {"id": str(uuid4()), "name": "dev-1", "split": "dev", "status": "scoring"}


class _Console:
    """`admin_db` stand-ins recording every lifecycle call (the SQL itself runs in `it_admin.py` under db-test)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.verdicts: list[admin_db.Verdict] = []
        self.refuse: str | None = None

    async def call(self, _connect: object, sql: str, params: tuple[object, ...]) -> object:
        if self.refuse is not None:
            raise psycopg.errors.lookup("P0001")(self.refuse)
        self.calls.append((sql, params))
        return TOURNAMENT_ROW["id"] if "create_tournament" in sql else ROWS_ADDED

    async def tournament(self, _connect: object, tid: UUID) -> dict[str, Any] | None:
        return dict(TOURNAMENT_ROW) if str(tid) == TOURNAMENT_ROW["id"] else None

    async def tournaments(self, _connect: object) -> list[dict[str, Any]]:
        return [dict(TOURNAMENT_ROW)]

    async def progress(self, _connect: object, _tid: UUID) -> list[dict[str, Any]]:
        return []

    async def reveal_preconditions(self, _connect: object, _tid: UUID) -> list[dict[str, Any]]:
        return [{"name": "status_scoring", "passed": True}]

    async def budget(self, _connect: object) -> list[dict[str, Any]]:
        return [{"bucket": "global", "ceiling_usd": "74.000000", "kill_switch": False}]

    async def pending_reviews(self, _connect: object) -> list[dict[str, Any]]:
        return [{"trial_id": "t9", "proposed": "subject_invalid"}]

    async def adjudicate(self, _connect: object, v: admin_db.Verdict) -> str:
        self.verdicts.append(v)
        return "adj-1"


@pytest.fixture
def console(monkeypatch: pytest.MonkeyPatch) -> _Console:
    fake = _Console()
    for name in (
        "call",
        "tournament",
        "tournaments",
        "progress",
        "reveal_preconditions",
        "budget",
        "pending_reviews",
        "adjudicate",
    ):
        monkeypatch.setattr(admin_db, name, getattr(fake, name))
    return fake


def _admin_posts(app: FastAPI) -> dict[str, Any]:
    csrf = run(_get(app, "/api/me")).json()["csrf_token"]
    return {"headers": _browser_post_headers(csrf), "cookies": {"arena_csrf": csrf}}


def test_admin_reads_list_detail_budget_and_reviews(tmp_path: Path, console: _Console) -> None:
    app = make_app(tmp_path)
    assert run(_get(app, "/api/admin/tournaments")).json() == {"tournaments": [TOURNAMENT_ROW]}
    detail = run(_get(app, f"/api/admin/tournaments/{TOURNAMENT_ROW['id']}")).json()
    assert detail["preconditions"] == [{"name": "status_scoring", "passed": True}]
    assert detail["progress"] == []
    assert run(_get(app, f"/api/admin/tournaments/{uuid4()}")).status_code == NOT_FOUND
    assert run(_get(app, "/api/admin/budget")).json()["buckets"][0]["bucket"] == "global"
    assert run(_get(app, "/api/admin/reviews")).json() == {
        "reviews": [{"trial_id": "t9", "proposed": "subject_invalid"}]
    }
    assert console.calls == []


def test_admin_lifecycle_runs_the_s4_function_of_each_step(tmp_path: Path, console: _Console) -> None:
    app = make_app(tmp_path)
    post = _admin_posts(app)
    tid = TOURNAMENT_ROW["id"]
    created = run(_post(app, "/api/admin/tournaments", json={"name": "dev-1", "split": "dev", "seed": 7}, **post))
    assert created.status_code == httpx.codes.OK, created.text
    roster = run(_post(app, f"/api/admin/tournaments/{tid}/roster", json={"rows": [{"position": 1}]}, **post))
    assert roster.json()["added"] == ROWS_ADDED
    for action in ("freeze", "close", "scoring"):
        assert run(_post(app, f"/api/admin/tournaments/{tid}/{action}", **post)).status_code == httpx.codes.OK
    names = [sql.split("(")[0].removeprefix("select ") for sql, _ in console.calls]
    assert names == [
        "arena.create_tournament",
        "arena.add_planned_trials",
        "arena.freeze_tournament",
        "arena.close_tournament_run",
        "arena.begin_scoring",
    ]
    assert console.calls[0][1] == ("dev-1", "dev", 7, 12)


def test_a_refused_transition_is_409_and_bad_bodies_422(tmp_path: Path, console: _Console) -> None:
    app = make_app(tmp_path)
    post = _admin_posts(app)
    console.refuse = "trial is draft"
    assert run(_post(app, f"/api/admin/tournaments/{uuid4()}/close", **post)).status_code == httpx.codes.CONFLICT
    console.refuse = None
    extra = {"name": "x", "split": "dev", "seed": 1, "budget": 5}
    assert run(_post(app, "/api/admin/tournaments", json=extra, **post)).status_code == UNPROCESSABLE


@pytest.mark.usefixtures("console")
def test_publish_needs_a_revealed_tournament_and_republishes_version_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_app(tmp_path)
    post = _admin_posts(app)
    tid = TOURNAMENT_ROW["id"]
    assert run(_post(app, f"/api/admin/tournaments/{tid}/publish", **post)).status_code == httpx.codes.CONFLICT
    monkeypatch.setitem(TOURNAMENT_ROW, "status", "revealed")

    async def ctx(_request: object, _tid: UUID) -> object:
        return object()

    async def published(_request: object, _tid: UUID, _ctx: object) -> dict[str, object]:
        return {"manifest_version": 1}

    monkeypatch.setattr(tournaments_route, "publish_context", ctx)
    monkeypatch.setattr(tournaments_route, "run_publish", published)
    assert run(_post(app, f"/api/admin/tournaments/{tid}/publish", **post)).json() == {"manifest_version": 1}
    later = run(_post(app, f"/api/admin/tournaments/{tid}/publish", json={"manifest_version": 2}, **post))
    assert later.status_code == httpx.codes.CONFLICT
    assert run(_post(app, f"/api/admin/tournaments/{uuid4()}/publish", **post)).status_code == NOT_FOUND


def test_a_verdict_is_adjudicated_with_the_reviewer_as_decider(
    tmp_path: Path, console: _Console, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_app(tmp_path)
    post = _admin_posts(app)
    trial = uuid4()
    body = {
        "verdict": "subject_invalid",
        "reason": "f:03 contradicted",
        "evidence_ref": f"{trial}:referee_subject",
        "idem_key": "verdict-key-1",
    }
    resp = run(_post(app, f"/api/admin/reviews/{trial}", json=body, **post))
    assert resp.json() == {"adjudication_id": "adj-1", "trial_id": str(trial), "verdict": "subject_invalid"}
    assert console.verdicts[0].decided_by == str(user_id_for(ADMIN_EMAIL))

    async def refused(_connect: object, _v: admin_db.Verdict) -> str:
        msg = "idempotency key reused"
        raise psycopg.errors.lookup("P0001")(msg)

    monkeypatch.setattr(admin_db, "adjudicate", refused)
    assert run(_post(app, f"/api/admin/reviews/{trial}", json=body, **post)).status_code == httpx.codes.CONFLICT


@pytest.mark.usefixtures("console")
def test_admin_console_routes_refuse_a_non_admin(tmp_path: Path) -> None:
    app = make_app(tmp_path, dev_user=VIEWER_EMAIL)
    for path in ("/api/admin/tournaments", "/api/admin/budget", "/api/admin/reviews"):
        assert run(_get(app, path)).status_code == FORBIDDEN


# ---------------------------------------------------------------- the web bundle on this origin (S6 4.13)


def _bundle(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>arena</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside the bundle")
    return dist


def test_the_consoles_are_served_same_origin_with_an_spa_fallback(tmp_path: Path) -> None:
    env = {**BASE_ENV, "ARENA_USERS_FILE": str(_write_users_file(tmp_path)), "ARENA_DEV_USER": ADMIN_EMAIL}
    app = create_app({**env, "ARENA_WEB_DIST": str(_bundle(tmp_path))})
    for path in ("/admin", "/review", "/"):
        page = run(_get(app, path))
        assert page.status_code == httpx.codes.OK
        assert "<title>arena</title>" in page.text
    assert run(_get(app, "/assets/app.js")).text == "console.log(1)"
    assert "outside" not in run(_get(app, "/../secret.txt")).text
    assert run(_get(app, "/api/no-such-route")).status_code == NOT_FOUND


def test_without_a_built_bundle_nothing_is_mounted(tmp_path: Path) -> None:
    env = {**BASE_ENV, "ARENA_USERS_FILE": str(_write_users_file(tmp_path)), "ARENA_DEV_USER": ADMIN_EMAIL}
    app = create_app({**env, "ARENA_WEB_DIST": str(tmp_path / "missing")})
    assert run(_get(app, "/admin")).status_code == NOT_FOUND
