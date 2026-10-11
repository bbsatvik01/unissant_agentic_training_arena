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

import pytest

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
                ("hidden", hidden_family_json("FHID", "Jo Rivers"), False),
                ("dev", hidden_family_json("FDEV", "Alex Doe"), True),
            ]
        }
    )
    result = run(isolation.fetch_hidden_corpora(connector(conn)))
    assert len(result.corpora) == 1
    assert result.corpora[0].persona_tokens == ("jo", "rivers")


def _with_notes(family_json: str, notes: str) -> str:
    """Adds a non-allowlisted, 8-token `private_packet.notes` field so the family has at least one real text
    8-gram to test subtraction against (`ground_rules`, `case_id` and the rest of the fixture's fields are
    either allowlisted or too short to form an 8-gram at all, S2 G6's window)."""
    family = json.loads(family_json)
    family["variants"]["truthful"]["private_packet"]["notes"] = notes
    return json.dumps(family)


def test_fetch_hidden_corpora_excludes_a_dev_family_ingested_after_the_seal() -> None:
    # The dev reference is fixed at the seal commit (S1 10.4): a dev family ingested after sealing (the
    # query's third column false) must never subtract from the corpus.
    notes = "this exact sentence has eight distinct unlisted words"  # exactly 8 tokens -> exactly one 8-gram
    hidden = _with_notes(hidden_family_json("FHID", "Jo Rivers"), notes)
    after_seal_dev = _with_notes(hidden_family_json("FHID", "Jo Rivers"), notes)  # as if laundering a leak
    conn = FakeConn({"sealed.family_ingests": [("hidden", hidden, False), ("dev", after_seal_dev, False)]})
    result = run(isolation.fetch_hidden_corpora(connector(conn)))
    # If the late dev family had been allowed into the reference, every one of FHID's own 8-grams would be
    # subtracted from its own corpus, leaving no text grams at all.
    assert result.corpora[0].grams


def test_verify_hidden_seal_and_chain_read_their_own_function_result() -> None:
    assert run(isolation.verify_hidden_seal(connector(FakeConn({"sealed.verify_hidden_seal": [(True,)]})))) is True
    assert run(isolation.verify_hidden_seal(connector(FakeConn({"sealed.verify_hidden_seal": [(False,)]})))) is False
    assert run(isolation.verify_chain(connector(FakeConn({"ledger.verify_chain": [(None,)]})))) is True
    assert run(isolation.verify_chain(connector(FakeConn({"ledger.verify_chain": [(7,)]})))) is False


def test_verify_all_corpus_seals_reads_the_system_wide_query_result() -> None:
    conn = FakeConn({"ledger.corpus_digest": [(True,)]})
    assert run(isolation.verify_all_corpus_seals(connector(conn))) is True


def test_fetch_commitment_results_maps_trial_id_to_verified_system_wide() -> None:
    conn = FakeConn({"ledger.verify_commitment": [("t1", True), ("t2", False)]})
    results = run(isolation.fetch_commitment_results(connector(conn)))
    assert results == {"t1": True, "t2": False}


def test_fetch_assistant_output_texts_merges_coach_cards_and_findings_per_candidate() -> None:
    conn = FakeConn(
        {
            "e.kind = any(%s)": [("a1111111-1111-4111-8111-111111111111", '{"card": "fixture"}')],
            "arena.final_findings f": [("a1111111-1111-4111-8111-111111111111", '{"label": "truthful"}')],
        }
    )
    texts = run(isolation.fetch_assistant_output_texts(connector(conn)))
    assert texts == {"a1111111-1111-4111-8111-111111111111": ['{"card": "fixture"}', '{"label": "truthful"}']}


def test_fetch_assistant_output_texts_queries_both_coach_card_and_coach_deep() -> None:
    # Codex finding #5: a canary surfacing only in a coach_deep payload must reach IG-6's scan too, not
    # just coach_card -- proven at the query level, since a FakeConn row is blind to the kind filter.
    conn = FakeConn({"e.kind = any(%s)": []})
    run(isolation.fetch_assistant_output_texts(connector(conn)))
    [params] = [p for q, p in conn.executed if "e.kind = any(%s)" in q]
    assert set(params[0]) == {"coach_card", "coach_deep"}


def test_read_scan_files_reads_every_scannable_file_under_the_given_roots(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    # Codex finding #6: a `.py` fixture (e.g. fixtures/injection.py's own docstrings and few-shot text) is
    # scannable too, never skipped just because of its suffix; a compiled `.pyc` still is not.
    (root / "few_shot.py").write_text("# scanned too")
    (root / "ignored.pyc").write_text("not scanned")
    files = isolation.read_scan_files((root,))
    assert set(files) == {str(root / "coach.md"), str(root / "few_shot.py")}


def test_read_scan_files_fails_closed_on_a_missing_root() -> None:
    # A missing root must never scan as "nothing to see", since that would pass IG-4 vacuously.
    with pytest.raises(FileNotFoundError, match="missing"):
        isolation.read_scan_files((Path("/no/such/directory"),))


def _clean_conn() -> FakeConn:
    return FakeConn(
        {
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"), False)],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
            "ledger.verify_commitment": [("t1", True)],
        }
    )


def test_run_isolation_gate_passes_clean_and_writes_one_row_per_item(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    conn = _clean_conn()
    request = isolation.IsolationGateRequest(
        git_sha="0" * 40,
        ig1=(True, "pgtap ok"),
        ig2=(True, "routes ok"),
        ig3=(True, "context ok"),
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
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"), False)],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
        }
    )
    request = isolation.IsolationGateRequest(
        git_sha="0" * 40,
        ig1=(True, "pgtap ok"),
        ig2=(True, "routes ok"),
        ig3=(True, "context ok"),
        scan_roots=(root,),
    )
    result = run(isolation.run_isolation_gate(connector(conn), request))
    assert result.passed is False


def test_run_isolation_gate_fails_when_an_assistant_output_carries_a_canary(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    conn = FakeConn(
        {
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"), False)],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
            "e.kind = any(%s)": [("a1111111-1111-4111-8111-111111111111", "leaked CANARY-FHID1 here")],
        }
    )
    request = isolation.IsolationGateRequest(
        git_sha="0" * 40,
        ig1=(True, "pgtap ok"),
        ig2=(True, "routes ok"),
        ig3=(True, "context ok"),
        scan_roots=(root,),
    )
    result = run(isolation.run_isolation_gate(connector(conn), request))
    assert result.passed is False
    assert result.items["IG-6"][0] is False


def test_open_hidden_tournament_opens_only_on_a_passing_gate(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "coach.md").write_text("All cases are synthetic.")
    conn = _clean_conn()
    request = isolation.IsolationGateRequest(
        git_sha="0" * 40, ig1=(True, "ok"), ig2=(True, "ok"), ig3=(True, "ok"), scan_roots=(root,)
    )
    result = run(isolation.open_hidden_tournament(connector(conn), TOURNAMENT, request))
    assert result.passed is True
    assert any("arena.open_tournament" in q for q, _ in conn.executed)


def test_open_hidden_tournament_refuses_to_open_on_a_failing_gate(tmp_path: Path) -> None:
    root = tmp_path / "prompts"
    root.mkdir()
    (root / "leak.md").write_text("Case C-FHIDD shows CANARY-FHID3.")
    conn = FakeConn(
        {
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"), False)],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
        }
    )
    request = isolation.IsolationGateRequest(
        git_sha="0" * 40, ig1=(True, "ok"), ig2=(True, "ok"), ig3=(True, "ok"), scan_roots=(root,)
    )
    with pytest.raises(RuntimeError, match="isolation gate failed"):
        run(isolation.open_hidden_tournament(connector(conn), TOURNAMENT, request))
    assert not any("arena.open_tournament" in q for q, _ in conn.executed)


def test_fetch_fresh_isolation_result_reuses_stored_ig123_but_recomputes_ig456() -> None:
    # Codex finding #1: a stale IG-6 pass, recorded at open time before this tournament had any assistant
    # outputs, must never be read back at reveal -- IG-6 (and IG-4, IG-5) are recomputed fresh every call,
    # while IG-1/2/3 (code-version-scoped, not tournament-data-scoped) reuse the latest recorded result.
    conn = FakeConn(
        {
            "distinct on (check_name)": [
                ("ig1_privilege_tests", True, "ig1-stale-hash"),
                ("ig2_route_tests", True, "ig2-stale-hash"),
                ("ig3_assistant_context", True, "ig3-stale-hash"),
                ("ig6_canary_audit", True, "stale-pass-before-any-output-existed"),
            ],
            "sealed.family_ingests": [("hidden", hidden_family_json("FHID", "Jo Rivers"), False)],
            "sealed.verify_hidden_seal": [(True,)],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_digest": [(True,)],
            "e.kind = any(%s)": [("a1111111-1111-4111-8111-111111111111", "leaked CANARY-FHID1 here")],
        }
    )
    result = run(isolation.fetch_fresh_isolation_result(connector(conn), "0" * 40))
    assert result.items["IG-1"] == (True, "ig1-stale-hash")
    assert result.items["IG-2"] == (True, "ig2-stale-hash")
    assert result.items["IG-3"] == (True, "ig3-stale-hash")
    assert result.items["IG-6"][0] is False  # recomputed fresh: the now-present canary leak fails it
    assert result.passed is False


def test_fetch_fresh_isolation_result_refuses_when_ig123_was_never_recorded() -> None:
    conn = FakeConn({"distinct on (check_name)": []})
    with pytest.raises(RuntimeError, match="never recorded"):
        run(isolation.fetch_fresh_isolation_result(connector(conn), "0" * 40))


def test_the_dev_gate_fails_on_a_dev_canary_in_an_assistant_output_and_never_reads_the_hidden_seal() -> None:
    cand = "00000000-0000-0000-0000-0000000000c1"
    conn = FakeConn(
        {
            "fi.source from sealed.family_ingests": [(hidden_family_json("FDEV", "Alex Doe"),)],
            "e.payload": [(cand, '{"text": "ask about CANARY-FDEV1"}')],
            "ledger.verify_chain": [(None,)],
            "ledger.corpus_seals": [(True,)],
        }
    )
    result = run(isolation.fetch_fresh_dev_isolation_result(connector(conn), "a" * 40))
    assert not result.passed
    assert result.items["IG-6"][0] is False
    assert result.items["IG-5"][0] is True
    assert not any("hidden" in q for q, _ in conn.executed)
    ig6_rows = [p for q, p in conn.executed if "insert into arena.isolation_checks" in q and "ig6" in str(p)]
    assert len(ig6_rows) == 1
    assert str(ig6_rows[0][0]) == cand  # the culprit is attributed (FX-I02)
