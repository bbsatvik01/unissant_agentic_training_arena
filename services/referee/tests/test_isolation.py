"""`arena_referee.isolation` (S3 9, IG-1..IG-6; WP-16) against a fake `Connector` (the same `FakeConn`/
`FakeCursor` pattern `test_db.py` uses) plus real temp files for the filesystem scan -- no real database or
process tree."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast

from arena_core.db.pool import Connector
from arena_referee import db, isolation

TOURNAMENT = "00000000-0000-0000-0000-0000000000a1"


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


class FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


@asynccontextmanager
async def _noop_tx() -> AsyncIterator[None]:
    yield


class FakeConn:
    def __init__(self, answers: dict[str, list[tuple[Any, ...]]] | None = None) -> None:
        self.answers = answers or {}
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> FakeCursor:
        self.executed.append((query, params))
        for key, rows in self.answers.items():
            if key in query:
                return FakeCursor(rows)
        return FakeCursor([])

    def transaction(self) -> AsyncIterator[None]:
        return cast("AsyncIterator[None]", _noop_tx())


def connector(conn: FakeConn) -> Connector:
    @asynccontextmanager
    async def connect() -> AsyncIterator[FakeConn]:
        yield conn

    return cast("Connector", connect)


def hidden_family_json(family_id: str, persona: str) -> str:
    return json.dumps(
        {
            "family_id": family_id,
            "variants": {
                "truthful": {
                    "case_id": f"C-{family_id}T",
                    "public_packet": {"presentation": {"display_name": persona}, "ground_rules": ["x"]},
                    "private_packet": {"canary": f"CANARY-{family_id}1", "role": "truthful"},
                    "evaluator_packet": {"canary": f"CANARY-{family_id}2", "variant": "truthful"},
                },
                "deceptive": {
                    "case_id": f"C-{family_id}D",
                    "public_packet": {"presentation": {"display_name": persona}, "ground_rules": ["x"]},
                    "private_packet": {"canary": f"CANARY-{family_id}3", "role": "deceptive"},
                    "evaluator_packet": {"canary": f"CANARY-{family_id}4", "variant": "deceptive"},
                },
            },
        }
    )


def test_fetch_hidden_corpora_builds_one_corpus_per_hidden_family_minus_the_dev_reference() -> None:
    conn = FakeConn(
        {
            "sealed.family_ingests": [
                ("hidden", hidden_family_json("FHID", "Jo Rivers")),
                ("dev", hidden_family_json("FDEV", "Alex Doe")),
            ]
        }
    )
    corpora = run(isolation.fetch_hidden_corpora(connector(conn)))
    assert len(corpora) == 1
    assert corpora[0].persona_tokens == ("jo", "rivers")


def test_verify_hidden_seal_and_chain_read_their_own_function_result() -> None:
    assert run(isolation.verify_hidden_seal(connector(FakeConn({"sealed.verify_hidden_seal": [(True,)]})))) is True
    assert run(isolation.verify_hidden_seal(connector(FakeConn({"sealed.verify_hidden_seal": [(False,)]})))) is False
    assert run(isolation.verify_chain(connector(FakeConn({"ledger.verify_chain": [(None,)]})))) is True
    assert run(isolation.verify_chain(connector(FakeConn({"ledger.verify_chain": [(7,)]})))) is False


def test_verify_corpus_seal_reads_the_combined_query_result() -> None:
    conn = FakeConn({"ledger.corpus_digest": [(True,)]})
    assert run(isolation.verify_corpus_seal(connector(conn), TOURNAMENT)) is True


def test_fetch_commitment_results_maps_trial_id_to_verified() -> None:
    conn = FakeConn({"ledger.verify_commitment": [("t1", True), ("t2", False)]})
    results = run(isolation.fetch_commitment_results(connector(conn), TOURNAMENT))
    assert results == {"t1": True, "t2": False}


def test_read_scan_files_reads_every_scannable_file_under_the_given_roots(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    (root / "ignored.py").write_text("# not scanned")
    files = isolation.read_scan_files((root,))
    assert set(files) == {str(root / "coach.md")}


def test_read_scan_files_skips_a_missing_root() -> None:
    assert isolation.read_scan_files((Path("/no/such/directory"),)) == {}


def test_run_isolation_gate_passes_clean_and_writes_one_row_per_item(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    conn = FakeConn(
        {
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"))],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
            "ledger.verify_commitment": [("t1", True)],
        }
    )
    request = isolation.IsolationGateRequest(
        tournament_id=TOURNAMENT,
        git_sha="0" * 40,
        ig1=(True, "pgtap ok"),
        ig2=(True, "routes ok"),
        ig3=(True, "context ok"),
        hits_by_candidate={"A1": 0},
        scan_roots=(root,),
    )
    result = run(isolation.run_isolation_gate(connector(conn), request))
    assert result.passed is True
    inserts = [q for q, _ in conn.executed if "arena.isolation_checks" in q]
    assert len(inserts) == len(db.CHECK_NAMES)


def test_run_isolation_gate_fails_when_the_scan_finds_a_canary(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "leak.md").write_text("Case C-FHIDD shows CANARY-FHID3.")
    conn = FakeConn(
        {
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"))],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
        }
    )
    request = isolation.IsolationGateRequest(
        tournament_id=TOURNAMENT,
        git_sha="0" * 40,
        ig1=(True, "pgtap ok"),
        ig2=(True, "routes ok"),
        ig3=(True, "context ok"),
        hits_by_candidate={},
        scan_roots=(root,),
    )
    result = run(isolation.run_isolation_gate(connector(conn), request))
    assert result.passed is False
