"""`arena_referee.admin_db` and the publish/open helpers behind the admin routes, against a scripted connection:
each read's shaping, the review view's blinding and evidence, and the version and recorded-report branches. The
SQL itself runs against the real migrated functions in `it_admin.py` (make db-test)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.db.pool import Connector
from arena_core.scoring.ranking import IG_ITEMS, isolation_result
from arena_referee import admin_db, db, isolation, reveal
from arena_referee.routes import reveal as reveal_route

REPO = Path(__file__).resolve().parents[3]
F01 = json.loads((REPO / "docs/spec/seed-families/F01.json").read_text(encoding="utf-8"))["variants"]["truthful"]
NOW = datetime(2026, 10, 12, tzinfo=UTC)
TID = uuid4()


def run[T](aw: Awaitable[T]) -> T:
    async def go() -> T:
        return await aw

    return asyncio.run(go())


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None


class Script:
    """Answers each statement from `answers` (SQL fragment -> rows), in order."""

    def __init__(self, answers: list[tuple[str, list[tuple[Any, ...]]]]) -> None:
        self.answers = answers
        self.executed: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> _Cursor:
        self.executed.append((query, tuple(params)))
        fragment, rows = self.answers.pop(0)
        assert fragment in query, (fragment, query)
        return _Cursor(rows)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        yield

    def connector(self) -> Connector:
        @asynccontextmanager
        async def connect() -> AsyncIterator[Script]:
            yield self

        return cast("Connector", connect)


def test_budget_tournaments_progress_and_preconditions() -> None:
    row = (TID, "dev-1", "dev", "scoring", 7, 12, "r" * 64, NOW, None)
    script = Script(
        [
            (
                "ops.budget_status()",
                [("global", None, Decimal("74.000000"), Decimal(0), Decimal(0), Decimal(74), False)],
            ),
            ("from arena.tournaments order by created_at", [row]),
            ("from arena.tournaments where id = %s", [row]),
            ("from arena.tournaments where id = %s", []),
            ("arena.v_tournament_progress", [("interactive", 1, 2, 0, 2, json.dumps({"completed": 2}))]),
            ("ledger.verify_chain()", [(True, True, True, False, True, True, True, True)]),
            ("ledger.verify_chain()", []),
            ("select arena.freeze_tournament", [("roster",)]),
            ("select arena.close_tournament_run", []),
        ]
    )
    connect = script.connector()
    assert run(admin_db.budget(connect)) == [
        {
            "bucket": "global",
            "parent": None,
            "ceiling_usd": "74.000000",
            "liability_usd": "0",
            "open_usd": "0",
            "headroom_usd": "74",
            "kill_switch": False,
        }
    ]
    [listed] = run(admin_db.tournaments(connect))
    assert listed["id"] == str(TID)
    assert listed["created_at"] == NOW.isoformat()
    assert listed["revealed_at"] is None
    assert run(admin_db.tournament(connect, TID)) == listed
    assert run(admin_db.tournament(connect, TID)) is None
    assert run(admin_db.progress(connect, TID)) == [
        {"track": "interactive", "block": 1, "planned": 2, "running": 0, "ended": 2, "states": {"completed": 2}}
    ]
    pre = run(admin_db.reveal_preconditions(connect, TID))
    assert [p["name"] for p in pre] == list(admin_db.PRECONDITION_NAMES)
    assert [p["name"] for p in pre if not p["passed"]] == ["subject_reviews_resolved"]
    assert run(admin_db.reveal_preconditions(connect, TID)) == []
    assert run(admin_db.call(connect, "select arena.freeze_tournament(%s)", (TID,))) == "roster"
    assert run(admin_db.call(connect, "select arena.close_tournament_run(%s)", (TID,))) is None


def test_roster_has_compares_every_named_field() -> None:
    planned = [(1, "interactive", 1, "v1", "a1", "s1", 1, None), (2, "replay", None, "v1", "a1", None, 1, 1)]
    connect = Script([("arena.planned_trials", planned)] * 5).connector()
    assert run(admin_db.roster_has(connect, TID, [{"position": 1, "track": "interactive", "block_no": 1}]))
    assert run(admin_db.roster_has(connect, TID, [{"position": 2, "source_position": 1}]))
    assert not run(admin_db.roster_has(connect, TID, [{"position": 1, "subject_candidate_id": "s2"}]))
    assert not run(admin_db.roster_has(connect, TID, [{"position": 3}]))
    assert not run(admin_db.roster_has(connect, TID, [{"position": 1, "invented": "x"}]))


def test_adjudicate_passes_the_reviewer_and_key() -> None:
    script = Script([("ledger.adjudicate_validity", [("adj-1",)])])
    verdict = admin_db.Verdict(TID, "valid", "fine", "e" * 10, "reviewer-1", "key-12345678")
    assert run(admin_db.adjudicate(script.connector(), verdict)) == "adj-1"
    assert script.executed[0][1] == (TID, "valid", "fine", "e" * 10, "reviewer-1", "key-12345678")


def _report_turn(n: int, *, contradicts: bool) -> dict[str, Any]:
    return {
        "turn_id": f"t{n:02d}",
        "label": "responsive",
        "eva_subtype": None,
        "pfq_reason": None,
        "requested_fact_ids": [],
        "asked_fact_status": "known",
        "uncertainty_expressed": False,
        "innocent_explanation_offered": False,
        "record_conflict_ids": [],
        "no_contradiction": not contradicts,
        "no_invention": True,
        "violated_fact_ids": ["f:07"] if contradicts else [],
        "uncertainty_respected": True,
        "disclosure_policy_respected": True,
        "in_character": True,
        "style_followed": True,
        "platform_attack": False,
        "evidence_quote": f"answer {n}",
    }


def test_the_review_queue_is_blinded_and_carries_every_turn_and_the_private_packet() -> None:
    trial = uuid4()
    report = {
        "schema_version": "ref_subj.v5",
        "turns": [_report_turn(1, contradicts=True), _report_turn(2, contradicts=False)],
        "trajectory": {"self_consistent": True, "conflicts": []},
    }
    packets = (json.dumps({**F01["private_packet"], "canary": "CANARY-1"}), json.dumps(F01["evaluator_packet"]))
    script = Script(
        [
            ("ledger.planned_execution", [(trial, json.dumps({"report": report}), TID, "subject_invalid")]),
            ("from arena.turns", [(1, "Why B-12?", "answer 1"), (2, "When?", "answer 2")]),
            ("from arena.released_evidence", [("rec-01", "Work orders", json.dumps({"body": "WO-1"}))]),
            ("subject.private_packets", [packets]),
        ]
    )
    [review] = run(admin_db.pending_reviews(script.connector()))
    assert review["trial_id"] == str(trial)
    assert review["tournament_id"] == str(TID)
    assert review["proposed"] == "subject_invalid"
    assert review["evidence_ref"] == f"{trial}:referee_subject"
    assert [e["turn_id"] for e in review["evidence"]] == ["t01", "t02"]
    assert review["evidence"][1]["failed_checks"] == []
    assert review["evidence"][0]["failed_checks"] == ["F1"]
    assert "forbidden_assertions" in review["private_packet"]
    assert "canary" not in review["private_packet"]
    assert "CANARY-1" not in json.dumps(review)
    assert not {"assistant_id", "cards", "finding"} & set(review)


def test_fetch_manifest_by_version() -> None:
    script = Script([("ledger.inclusion_manifests", [(TID, "m" * 64, 2)]), ("ledger.inclusion_manifests", [])])
    found = run(db.fetch_manifest(script.connector(), str(TID), 2))
    assert found == db.RevealResult(str(TID), "m" * 64, 2)
    assert run(db.fetch_manifest(script.connector(), str(TID), 9)) is None


def test_publish_existing_publishes_a_sealed_corrected_manifest(monkeypatch: pytest.MonkeyPatch) -> None:
    sealed = db.RevealResult("mid", "m" * 64, 2)
    published: list[tuple[object, str]] = []

    async def manifest(_c: object, _t: str, version: int) -> db.RevealResult | None:
        return sealed if version == sealed.manifest_version else None

    async def gather(_c: object, _t: str) -> object:
        return "inputs"

    async def publish(_c: object, _inputs: object, result: db.RevealResult, label: str, _ctx: object) -> None:
        published.append((result, label))

    monkeypatch.setattr(db, "fetch_manifest", manifest)
    monkeypatch.setattr(reveal, "_gather", gather)
    monkeypatch.setattr(reveal, "_publish", publish)
    ctx = cast("reveal.PublishContext", object())
    assert run(reveal.publish_existing(Script([]).connector(), str(TID), 2, ctx)) == sealed
    assert published == [(sealed, "corrected")]
    with pytest.raises(LookupError):
        run(reveal.publish_existing(Script([]).connector(), str(TID), 3, ctx))


def test_run_publish_picks_reveal_for_version_1_and_the_sealed_manifest_after(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    result = db.RevealResult("mid", "m" * 64, 1)

    async def via_reveal(_c: object, _t: str, _ctx: object) -> db.RevealResult:
        calls.append("reveal")
        return result

    async def via_existing(_c: object, _t: str, version: int, _ctx: object) -> db.RevealResult:
        calls.append(f"existing:{version}")
        return result

    monkeypatch.setattr(reveal_route, "reveal_and_publish", via_reveal)
    monkeypatch.setattr(reveal_route, "publish_existing", via_existing)
    request = cast("Any", SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(connect=None))))
    ctx = cast("reveal.PublishContext", object())
    run(reveal_route.run_publish(request, UUID(int=1), ctx, 1))
    run(reveal_route.run_publish(request, UUID(int=1), ctx, 2))
    assert calls == ["reveal", "existing:2"]


def test_the_bodyless_hidden_open_opens_only_on_a_passing_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    passing = isolation_result(dict.fromkeys(IG_ITEMS, (True, "ok")))
    failing = isolation_result({**dict.fromkeys(IG_ITEMS, (True, "ok")), "IG-6": (False, "canary hit")})
    results = [passing, failing]

    async def fresh(_c: object, _sha: str) -> object:
        return results.pop(0)

    async def do_open(_c: object, tid: str) -> None:
        opened.append(tid)

    monkeypatch.setattr(isolation, "fetch_fresh_isolation_result", fresh)
    monkeypatch.setattr(db, "open_tournament", do_open)
    connect = Script([]).connector()
    assert run(isolation.open_hidden_with_recorded_reports(connect, "t1", "f" * 40)).passed
    with pytest.raises(RuntimeError, match="isolation gate failed"):
        run(isolation.open_hidden_with_recorded_reports(connect, "t2", "f" * 40))
    assert opened == ["t1"]
