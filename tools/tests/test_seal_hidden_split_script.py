"""The S1 10.3 sealing sequence's database half: `scripts/seal_hidden_split.py` builds every bundle and the
sampler record entirely offline (no database) and only then opens the one connection its three S4 calls run
on. This file proves the offline reading, the already-sealed (AR001) branch and the CLI orchestration with a
fake connector or the real `seal` monkeypatched out; the real calls against a migrated database run in
db-test (`services/tournament/tests/it_tournament.py`'s WP-27 dry run, which calls `seal_hidden_split.seal`
directly rather than duplicating its sequencing)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import psycopg
import pytest

from arena_core.db import calls
from arena_core.db.pool import Connector
from scripts import seal_hidden_split

VALID_BUNDLE: dict[str, Any] = {
    "family_code": "H0000000000",
    "domain": "facility_access",
    "split": "hidden",
    "supersedes": None,
    "source": '{"family_id": "H0000000000"}',
    "attestation": {
        "family_id": "H0000000000",
        "revision": 1,
        "family_sha256": "a" * 64,
        "validator_version": "v",
        "checks_passed": ["V1"],
        "codex": {"rounds": 1, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"},
    },
    "variants": [],
}


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def _write(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_read_bundles_parses_every_file_in_order(tmp_path: Path) -> None:
    other = {**VALID_BUNDLE, "family_code": "H1111111111"}
    p1 = _write(tmp_path / "h1.json", VALID_BUNDLE)
    p2 = _write(tmp_path / "h2.json", other)
    bundles = seal_hidden_split.read_bundles([p1, p2])
    assert [b["family_code"] for b in bundles] == ["H0000000000", "H1111111111"]
    assert all(isinstance(b, dict) for b in bundles)


def test_read_bundles_refuses_an_unreadable_file(tmp_path: Path) -> None:
    with pytest.raises(seal_hidden_split.SealError, match="cannot read"):
        seal_hidden_split.read_bundles([tmp_path / "missing.json"])


def test_read_bundles_refuses_a_malformed_bundle(tmp_path: Path) -> None:
    incomplete = {k: v for k, v in VALID_BUNDLE.items() if k != "attestation"}
    path = _write(tmp_path / "bad.json", incomplete)
    with pytest.raises(seal_hidden_split.SealError, match="not an ingest bundle"):
        seal_hidden_split.read_bundles([path])


def test_read_bundles_refuses_anything_but_one_object(tmp_path: Path) -> None:
    path = _write(tmp_path / "bad.json", [1, 2, 3])
    with pytest.raises(seal_hidden_split.SealError, match="not an ingest bundle"):
        seal_hidden_split.read_bundles([path])


def test_read_sampler_record_parses_the_object(tmp_path: Path) -> None:
    record = {"seed": 1, "n": 1, "assignment": [], "max_phi": 0.1}
    path = _write(tmp_path / "sampler.json", record)
    assert seal_hidden_split.read_sampler_record(path) == record


def test_read_sampler_record_refuses_an_unreadable_file(tmp_path: Path) -> None:
    with pytest.raises(seal_hidden_split.SealError, match="cannot read"):
        seal_hidden_split.read_sampler_record(tmp_path / "missing.json")


def test_read_sampler_record_refuses_anything_but_one_object(tmp_path: Path) -> None:
    path = _write(tmp_path / "sampler.json", [1, 2, 3])
    with pytest.raises(seal_hidden_split.SealError, match="one JSON object"):
        seal_hidden_split.read_sampler_record(path)


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


def test_seal_ingests_every_bundle_then_seals_then_verifies(monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = dict(VALID_BUNDLE)
    sampler_record = {"seed": 1, "n": 1, "assignment": [], "max_phi": 0.1}
    calls_seen: list[tuple[str, ...]] = []

    async def fake_ingest(conn: object, bundle_json: Mapping[str, Any]) -> object:
        assert isinstance(conn, _Conn)
        calls_seen.append(("ingest", bundle_json["family_code"]))
        return uuid4()

    async def fake_seal(conn: object, record: Mapping[str, Any]) -> str:
        assert isinstance(conn, _Conn)
        assert record == sampler_record
        calls_seen.append(("seal",))
        return "f" * 64

    async def fake_verify(conn: object) -> bool:
        assert isinstance(conn, _Conn)
        calls_seen.append(("verify",))
        return True

    monkeypatch.setattr(calls, "ingest_case_family", fake_ingest)
    monkeypatch.setattr(calls, "seal_hidden_split", fake_seal)
    monkeypatch.setattr(calls, "verify_hidden_seal", fake_verify)

    connector = _Connector()
    report = run(seal_hidden_split.seal(cast("Connector", connector), [bundle], sampler_record))

    assert connector.opened == 1  # one connection for the whole sequence (S1 10.3: the ingest/seal lock race)
    assert calls_seen == [("ingest", "H0000000000"), ("seal",), ("verify",)]
    assert report == seal_hidden_split.SealReport(
        seal_sha256="f" * 64, already_sealed=False, verified=True, family_codes=("H0000000000",)
    )


def test_seal_reports_already_sealed_on_ar001_instead_of_failing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A re-run after an interrupted first pass: the split is already sealed (AR001), so this reports the
    existing seal hash and still verifies it, rather than treating the expected refusal as a failure."""
    bundle = dict(VALID_BUNDLE)

    async def fake_ingest(_conn: object, _bundle_json: Mapping[str, Any]) -> object:
        return uuid4()

    async def already_sealed(_conn: object, _record: Mapping[str, Any]) -> str:
        err = psycopg.Error("the hidden split is already sealed")
        err.sqlstate = "AR001"
        raise err

    async def fake_verify(_conn: object) -> bool:
        return True

    class _ConnWithSealRow(_Conn):
        async def execute(self, _query: str, _params: tuple[object, ...] = ()) -> _Cursor:
            return _Cursor(("e" * 64,))

    class _Cursor:
        def __init__(self, row: tuple[object, ...] | None) -> None:
            self._row = row

        async def fetchone(self) -> tuple[object, ...] | None:
            return self._row

    @asynccontextmanager
    async def ctx() -> AsyncIterator[_Conn]:
        yield _ConnWithSealRow()

    monkeypatch.setattr(calls, "ingest_case_family", fake_ingest)
    monkeypatch.setattr(calls, "seal_hidden_split", already_sealed)
    monkeypatch.setattr(calls, "verify_hidden_seal", fake_verify)

    report = run(seal_hidden_split.seal(cast("Connector", ctx), [bundle], {}))
    assert report.already_sealed is True
    assert report.seal_sha256 == "e" * 64
    assert report.verified is True


def test_main_refuses_to_run_without_its_dsn(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    bundle_path = _write(tmp_path / "h.json", VALID_BUNDLE)
    record_path = _write(tmp_path / "sampler.json", {})
    args = ["--bundle", str(bundle_path), "--sampler-record", str(record_path)]
    assert seal_hidden_split.main(args, {}) == 1
    assert "ARENA_REFEREE_DSN is not set" in capsys.readouterr().err


def test_main_requires_at_least_one_bundle() -> None:
    with pytest.raises(SystemExit):
        seal_hidden_split.main(["--sampler-record", "x.json"], {"ARENA_REFEREE_DSN": "postgresql://x"})


def test_main_reports_a_seal_error_from_reading_the_bundles(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    record_path = _write(tmp_path / "sampler.json", {})
    args = ["--bundle", str(tmp_path / "missing.json"), "--sampler-record", str(record_path)]
    assert seal_hidden_split.main(args, {"ARENA_REFEREE_DSN": "postgresql://x"}) == 1
    assert "cannot read" in capsys.readouterr().err


def test_main_prints_one_json_report_and_never_the_dsn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    dsn_with_password = "postgresql://referee:" + "s3cr3t" + "@owner-host/postgres"  # fixture value only
    bundle_path = _write(tmp_path / "h.json", VALID_BUNDLE)
    record_path = _write(tmp_path / "sampler.json", {"seed": 1})
    canned = seal_hidden_split.SealReport(
        seal_sha256="d" * 64, already_sealed=False, verified=True, family_codes=("H0000000000",)
    )

    async def fake_seal(_connect: object, _bundles: object, _record: object) -> seal_hidden_split.SealReport:
        return canned

    monkeypatch.setattr(seal_hidden_split, "seal", fake_seal)
    args = ["--bundle", str(bundle_path), "--sampler-record", str(record_path)]
    assert seal_hidden_split.main(args, {"ARENA_REFEREE_DSN": dsn_with_password}) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {
        "seal_sha256": "d" * 64,
        "already_sealed": False,
        "verified": True,
        "family_codes": ["H0000000000"],
        "n_families": 1,
    }
    assert dsn_with_password not in captured.out + captured.err
    assert "s3cr3t" not in captured.out + captured.err


def test_main_fails_when_the_seal_never_verifies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle_path = _write(tmp_path / "h.json", VALID_BUNDLE)
    record_path = _write(tmp_path / "sampler.json", {})
    unverified = seal_hidden_split.SealReport(
        seal_sha256="d" * 64, already_sealed=False, verified=False, family_codes=("H0000000000",)
    )

    async def fake_seal(_connect: object, _bundles: object, _record: object) -> seal_hidden_split.SealReport:
        return unverified

    monkeypatch.setattr(seal_hidden_split, "seal", fake_seal)
    args = ["--bundle", str(bundle_path), "--sampler-record", str(record_path)]
    assert seal_hidden_split.main(args, {"ARENA_REFEREE_DSN": "postgresql://x"}) == 1
    assert "verify_hidden_seal() is false" in capsys.readouterr().err


def test_main_never_echoes_a_malformed_dsns_own_password(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A real psycopg connection attempt, not mocked: libpq's own parser quotes a malformed connection
    string back whole (a stray quote, or bad percent-encoding), password included -- proven against the
    real exception path, not a canned one, the same way scripts/seed_hosted.py's own test is."""
    secret = "s3c" + "r3t"  # not a real credential; split so it is never one password-shaped literal
    malformed = "'postgresql://referee:" + secret + "@owner-host:5/postgres'"  # a stray quote breaks libpq
    bundle_path = _write(tmp_path / "h.json", VALID_BUNDLE)
    record_path = _write(tmp_path / "sampler.json", {})
    monkeypatch.setattr(seal_hidden_split, "read_bundles", lambda _paths: [])
    args = ["--bundle", str(bundle_path), "--sampler-record", str(record_path)]
    assert seal_hidden_split.main(args, {"ARENA_REFEREE_DSN": malformed}) == 1
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
    assert malformed not in captured.out + captured.err
    assert "detail withheld" in captured.err
