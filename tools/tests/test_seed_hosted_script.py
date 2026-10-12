"""`make seed-hosted` (S1 10.5, S2 3.1, S4 2.3): `scripts/seed_hosted.py` builds the nine dev-family bundles and
the official roster entirely offline (no database, no model call) and only then opens the one connection its
three S4 calls run on. This file proves the offline building and the orchestration (a fake connector, or the
real `seed` monkeypatched out); the real calls against a migrated database, including that re-running is a
no-op, run in db-test (`packages/core/tests/db/it_seed_hosted.py`)."""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import AsyncIterator, Coroutine, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.agents.manifests import RosterRefusedError, official_manifests
from arena_core.db import calls
from arena_core.db.pool import Connector
from arena_core.identity import user_id_for
from arena_core.scenario.load import IngestBundle
from scripts import seed_hosted

EMAIL = "Dev@Arena.Local"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def test_dev_bundles_builds_all_nine_dev_families_in_order() -> None:
    bundles = seed_hosted.dev_bundles()
    assert [b.family_code for b in bundles] == [f"F0{i}" for i in range(1, 10)]
    assert all(isinstance(b, IngestBundle) for b in bundles)


def test_dev_bundles_refuses_a_report_that_does_not_record_a_clean_pass(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    shutil.copytree(seed_hosted.REPORTS_DIR, reports)
    report = json.loads((reports / "F01.cx.json").read_text(encoding="utf-8"))
    report["cx3"] = False
    (reports / "F01.cx.json").write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(seed_hosted.SeedError, match="F01"):
        seed_hosted.dev_bundles(reports_dir=reports)


def test_dev_bundles_refuses_a_report_with_no_matching_family(tmp_path: Path) -> None:
    with pytest.raises(seed_hosted.SeedError, match="cannot read"):
        seed_hosted.dev_bundles(reports_dir=tmp_path)


def test_dev_bundles_refuses_a_report_that_is_not_one_json_object(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    shutil.copytree(seed_hosted.REPORTS_DIR, reports)
    (reports / "F01.cx.json").write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(seed_hosted.SeedError, match="one JSON object"):
        seed_hosted.dev_bundles(reports_dir=reports)


def test_candidate_manifests_returns_exactly_the_official_six() -> None:
    manifests = seed_hosted.candidate_manifests()
    assert set(manifests) == set(seed_hosted.CANDIDATE_IDS)
    assert {m.kind for m in manifests.values()} == {"assistant", "subject"}


def test_candidate_manifests_refuses_an_incomplete_roster(monkeypatch: pytest.MonkeyPatch) -> None:
    real = official_manifests()
    incomplete = {k: v for k, v in real.items() if k != "A1"}
    monkeypatch.setattr(seed_hosted, "official_manifests", lambda _root: incomplete)
    with pytest.raises(seed_hosted.SeedError, match="A1"):
        seed_hosted.candidate_manifests()


def test_candidate_manifests_refuses_a_roster_that_fails_its_own_freeze_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_manifests: object) -> None:
        msg = "simulated roster refusal"
        raise RosterRefusedError([msg])

    monkeypatch.setattr(seed_hosted, "check_roster", boom)
    with pytest.raises(seed_hosted.SeedError, match="simulated roster refusal"):
        seed_hosted.candidate_manifests()


class _Conn:
    pass


class _Connector:
    def __init__(self) -> None:
        self.opened = 0

    @asynccontextmanager
    async def _ctx(self) -> AsyncIterator[_Conn]:
        self.opened += 1
        yield _Conn()

    def __call__(self) -> AbstractAsyncContextManager[_Conn]:
        return self._ctx()


def test_seed_ingests_registers_and_allowlists_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    bundles = seed_hosted.dev_bundles()
    manifests = seed_hosted.candidate_manifests()
    calls_seen: list[tuple[str, ...]] = []
    ids = {f"family:{b.family_code}": uuid4() for b in bundles}
    ids.update({f"candidate:{c}": uuid4() for c in seed_hosted.CANDIDATE_IDS})

    async def fake_ingest(conn: object, bundle: Mapping[str, Any]) -> UUID:
        assert isinstance(conn, _Conn)
        code = bundle["family_code"]
        calls_seen.append(("ingest", code))
        return ids[f"family:{code}"]

    async def fake_register(conn: object, *, kind: str, name: str, version: str, manifest: Mapping[str, Any]) -> UUID:
        assert isinstance(conn, _Conn)
        assert manifest["candidate_id"] == name
        assert "frozen_at" not in manifest
        calls_seen.append(("register", kind, name, version))
        return ids[f"candidate:{name}"]

    async def fake_allowlist(conn: object, *, user_id: UUID, email: str) -> None:
        assert isinstance(conn, _Conn)
        calls_seen.append(("allowlist", str(user_id), email))

    monkeypatch.setattr(calls, "ingest_case_family", fake_ingest)
    monkeypatch.setattr(calls, "register_candidate", fake_register)
    monkeypatch.setattr(calls, "allowlist_user", fake_allowlist)

    connector = _Connector()
    result = run(seed_hosted.seed(cast("Connector", connector), email=EMAIL, bundles=bundles, manifests=manifests))

    assert connector.opened == 1  # one connection for every step (S5 10.2: one owner credential, one use)
    assert [c[:2] for c in calls_seen if c[0] == "ingest"] == [("ingest", b.family_code) for b in bundles]
    assert [c[1:] for c in calls_seen if c[0] == "register"] == [
        (manifests[c].kind, c, manifests[c].version) for c in seed_hosted.CANDIDATE_IDS
    ]
    assert calls_seen[-1] == ("allowlist", str(user_id_for(EMAIL)), "dev@arena.local")  # lowered, S4 2.3
    assert result == {
        "families": {b.family_code: str(ids[f"family:{b.family_code}"]) for b in bundles},
        "candidates": {c: str(ids[f"candidate:{c}"]) for c in seed_hosted.CANDIDATE_IDS},
        "user": {"email": "dev@arena.local", "user_id": str(user_id_for(EMAIL))},
    }


def test_main_refuses_to_run_without_its_dsn(capsys: pytest.CaptureFixture[str]) -> None:
    assert seed_hosted.main(["--email", EMAIL], {}) == 1
    assert "ARENA_OWNER_DSN is not set" in capsys.readouterr().err


def test_main_requires_an_email() -> None:
    with pytest.raises(SystemExit):
        seed_hosted.main([], {"ARENA_OWNER_DSN": "postgresql://x"})


def test_main_prints_one_json_object_and_never_the_dsn(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Not a real credential: a throwaway fixture this test asserts never reaches stdout/stderr. Built by
    # concatenation, never one password-shaped literal, so it is not itself a suppressible secret finding.
    dsn_with_password = "postgresql://postgres:" + "s3cr3t" + "@owner-host/postgres"
    canned = {"families": {"F01": "id"}, "candidates": {"A1": "id"}, "user": {"email": EMAIL, "user_id": "id"}}

    async def fake_seed(_connect: object, **_kwargs: object) -> dict[str, Any]:
        return canned

    monkeypatch.setattr(seed_hosted, "seed", fake_seed)
    assert seed_hosted.main(["--email", EMAIL], {"ARENA_OWNER_DSN": dsn_with_password}) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == canned
    assert dsn_with_password not in captured.out
    assert dsn_with_password not in captured.err
    assert "s3cr3t" not in captured.out + captured.err


def test_main_never_echoes_a_malformed_dsns_own_password(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A real psycopg connection attempt, not mocked: libpq's own parser quotes a malformed connection string
    back whole (a stray quote, or bad percent-encoding) in its error message, password included. Proven
    against the real exception path (ArenaDb's fetch/connect wraps it into ops/arena errors the same way),
    not a canned one, so a future change that starts printing exc detail again is caught here."""
    secret = "s3c" + "r3t"  # not a real credential; split so it is never one password-shaped literal
    malformed = "'postgresql://postgres:" + secret + "@owner-host:5/postgres'"  # quotes break libpq's parser
    monkeypatch.setattr(seed_hosted, "dev_bundles", lambda **_kwargs: [])
    monkeypatch.setattr(seed_hosted, "candidate_manifests", lambda **_kwargs: {})
    assert seed_hosted.main(["--email", EMAIL], {"ARENA_OWNER_DSN": malformed}) == 1
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    assert malformed not in captured.out + captured.err
    assert "detail withheld" in captured.err


def test_main_reports_a_seed_error_from_building_the_bundles(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(**_kwargs: object) -> list[IngestBundle]:
        msg = "F09: simulated"
        raise seed_hosted.SeedError(msg)

    monkeypatch.setattr(seed_hosted, "dev_bundles", boom)
    assert seed_hosted.main(["--email", EMAIL], {"ARENA_OWNER_DSN": "postgresql://x"}) == 1
    assert "F09: simulated" in capsys.readouterr().err


def test_main_reports_a_seed_error_from_the_database_step(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def boom(_connect: object, **_kwargs: object) -> dict[str, Any]:
        msg = "simulated database failure"
        raise seed_hosted.SeedError(msg)

    monkeypatch.setattr(seed_hosted, "seed", boom)
    assert seed_hosted.main(["--email", EMAIL], {"ARENA_OWNER_DSN": "postgresql://x"}) == 1
    assert "simulated database failure" in capsys.readouterr().err
