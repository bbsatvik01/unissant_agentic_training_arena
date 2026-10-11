"""`create_app` (S5 1, 10.1, 10.3): the D10 guard on every request, the console, review and internal
scoring/debrief routes, dispatched through a real ASGI call (`httpx.ASGITransport`, not
`starlette.testclient` -- its `httpx` deprecation warning fails under this repo's `-W error`). The
internal pipelines (`score_trial`, `publish_session_debrief`) are faked at the route's own import site
(they are proven directly in `test_scoring.py`/`test_debrief.py`); this file is the HTTP wiring: D10,
identity, status codes and body shapes.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Mapping
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
from arena_core.scoring.rubric import lineage_checked_sha256
from arena_referee import db
from arena_referee.app import create_app
from arena_referee.debrief import SessionNotEndedError
from arena_referee.routes import debrief as debrief_route
from arena_referee.routes import score as score_route
from arena_referee.routes import tournament as tournament_route
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


def _browser_post_headers(csrf: str) -> dict[str, str]:
    return {"origin": ORIGIN, "sec-fetch-site": "same-origin", "x-arena-csrf": csrf}


FORBIDDEN = 403
UNAUTHORIZED = 401
DNS_REBINDING = 421
NOT_FOUND = 404
UNPROCESSABLE = 422


# ---------------------------------------------------------------- D10: Host, health


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


def test_score_route_scores_a_corpus_trial_with_r1_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """S5 5.3 (WP-17): a `replay_corpus` transcript gets R1 and its initial validity verdict, never R2."""

    async def fake_score_corpus_trial(_deps: object, _trial_id: str, _prompts: object) -> ValidityDecision:
        return ValidityDecision(verdict="valid", deciding_turns=(), auto_recordable=True, reason="clean")

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay_corpus"

    app = make_app(tmp_path)
    monkeypatch.setattr(score_route, "score_corpus_trial", fake_score_corpus_trial)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"verdict": "valid", "auto_recordable": True}


def test_score_route_scores_a_replay_trial_with_r2_against_the_sources_r1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """S5 5.3; D2 (WP-17): a `replay` trial gets R2 only, against its source corpus transcript's stored R1
    report (never a fresh R1 call)."""
    seen_reports: list[RefereeSubjectReport] = []

    async def fake_score_replay_trial(
        _deps: object, _trial_id: str, _ctx: object, source_report: RefereeSubjectReport
    ) -> RefereeAssistantReport:
        seen_reports.append(source_report)
        return _fake_assistant_report()

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay"

    async def fake_source_report(_request: object, _trial_id: UUID) -> RefereeSubjectReport:
        return _fake_subject_report()

    app = make_app(tmp_path)
    monkeypatch.setattr(score_route, "score_replay_trial", fake_score_replay_trial)
    monkeypatch.setattr(score_route, "_source_subject_report", fake_source_report)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"verdict": None, "auto_recordable": False}
    assert seen_reports == [_fake_subject_report()]


def test_source_subject_report_422s_when_the_replay_trial_has_no_source_yet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real `_source_subject_report` this time (not faked), through the route end to end."""

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay"

    async def fake_fetch_source_trial_id(_connect: object, _trial_id: str) -> None:
        return None

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    monkeypatch.setattr(db, "fetch_source_trial_id", fake_fetch_source_trial_id)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == UNPROCESSABLE
    assert "has no source_trial_id yet" in resp.json()["detail"]


def test_source_subject_report_422s_when_the_sources_r1_is_not_stored_yet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = str(uuid4())

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay"

    async def fake_fetch_source_trial_id(_connect: object, _trial_id: str) -> str:
        return source_id

    async def fake_get_judgment(_connect: object, _key: str) -> None:
        return None

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    monkeypatch.setattr(db, "fetch_source_trial_id", fake_fetch_source_trial_id)
    monkeypatch.setattr(db, "get_judgment", fake_get_judgment)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == UNPROCESSABLE
    assert "has no stored R1 report yet" in resp.json()["detail"]


def test_source_subject_report_parses_the_stored_judgment_for_a_real_r2_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_id = str(uuid4())
    seen_reports: list[RefereeSubjectReport] = []

    async def fake_score_replay_trial(
        _deps: object, _trial_id: str, _ctx: object, source_report: RefereeSubjectReport
    ) -> RefereeAssistantReport:
        seen_reports.append(source_report)
        return _fake_assistant_report()

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "replay"

    async def fake_fetch_source_trial_id(_connect: object, _trial_id: str) -> str:
        return source_id

    async def fake_get_judgment(_connect: object, key: str) -> dict[str, Any]:
        assert key == f"{source_id}:referee_subject"
        return {"report": _fake_subject_report().model_dump(mode="json")}

    app = make_app(tmp_path)
    monkeypatch.setattr(score_route, "score_replay_trial", fake_score_replay_trial)
    monkeypatch.setattr(db, "fetch_trial_kind", fake_fetch_trial_kind)
    monkeypatch.setattr(db, "fetch_source_trial_id", fake_fetch_source_trial_id)
    monkeypatch.setattr(db, "get_judgment", fake_get_judgment)
    resp = run(_post(app, f"/internal/trials/{uuid4()}/score", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert seen_reports == [_fake_subject_report()]


def test_score_route_rejects_an_unrecognized_trial_kind(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A trial kind the route does not know (never training, interactive, replay_corpus or replay) is
    refused with a clear error rather than silently mis-scored."""

    async def fake_fetch_trial_kind(_connect: object, _trial_id: str) -> str:
        return "training"

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


# ---------------------------------------------------------------- tournament routes (WP-17; S5 5.3, 5.5)


def test_score_block_route_scores_every_trial_in_the_block(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    trial_ids = [str(uuid4()), str(uuid4())]

    async def fake_fetch_block_trial_ids(_connect: object, _tournament_id: str, _block_no: int) -> list[str]:
        return trial_ids

    async def fake_score_trial(_deps: object, _trial_id: str, _ctx: object) -> ScoreResult:
        return ScoreResult(
            subject_report=_fake_subject_report(),
            assistant_report=_fake_assistant_report(),
            validity=ValidityDecision(verdict="valid", deciding_turns=(), auto_recordable=True, reason="clean"),
        )

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "fetch_block_trial_ids", fake_fetch_block_trial_ids)
    monkeypatch.setattr(tournament_route, "score_trial", fake_score_trial)
    resp = run(_post(app, f"/internal/tournaments/{uuid4()}/blocks/1/score", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {
        "block_no": 1,
        "scored": [{"trial_id": t, "verdict": "valid"} for t in trial_ids],
    }


def test_corpus_seal_route_returns_the_stored_seal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_seal_replay_corpus(_connect: object, _tournament_id: str) -> str:
        return "a" * 64

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "seal_replay_corpus", fake_seal_replay_corpus)
    resp = run(_post(app, f"/internal/tournaments/{uuid4()}/corpus-seal", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"corpus_sha256": "a" * 64}


def test_corpus_seal_route_maps_a_sql_error_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_seal_replay_corpus(_connect: object, _tournament_id: str) -> str:
        exc = psycopg.Error("the replay corpus is sealed while the tournament runs")
        exc.sqlstate = "AR001"
        raise exc

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "seal_replay_corpus", fake_seal_replay_corpus)
    resp = run(_post(app, f"/internal/tournaments/{uuid4()}/corpus-seal", headers=_caller_headers()))
    assert resp.status_code == CONFLICT
    assert resp.json()["detail"] == "AR001: the replay corpus is sealed while the tournament runs"


def test_close_route_returns_sealed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def fake_close_tournament_run(_connect: object, tournament_id: str) -> None:
        calls.append(tournament_id)

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "close_tournament_run", fake_close_tournament_run)
    tournament_id = str(uuid4())
    resp = run(_post(app, f"/internal/tournaments/{tournament_id}/close", headers=_caller_headers()))
    assert resp.status_code == httpx.codes.OK
    assert resp.json() == {"status": "sealed"}
    assert calls == [tournament_id]


def test_close_route_maps_a_sql_error_to_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_close_tournament_run(_connect: object, _tournament_id: str) -> None:
        exc = psycopg.Error("not every planned trial has an execution record yet")
        exc.sqlstate = "AR001"
        raise exc

    app = make_app(tmp_path)
    monkeypatch.setattr(db, "close_tournament_run", fake_close_tournament_run)
    resp = run(_post(app, f"/internal/tournaments/{uuid4()}/close", headers=_caller_headers()))
    assert resp.status_code == CONFLICT
    assert resp.json()["detail"] == "AR001: not every planned trial has an execution record yet"
