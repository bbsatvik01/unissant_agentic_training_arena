"""`arena_referee.db` against a fake `Connector` (the `Conn`/`Cursor` stand-in `packages/core/tests/spend/
test_guard_client.py` uses for the same reason): every statement it sends and every row shape it expects,
with no real connection. `packages/core/tests/db/it_spend_guard.py`'s sibling pattern -- a real-database
integration pass -- is out of this WP's committed scope (see the report); this file is what the coverage
gate measures, and it exercises every function and error branch in the module directly.

WP-16 adds reveal, isolation-gate and leaderboard functions below the WP-14 ones, same pattern.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.db.pool import Connector
from arena_core.providers.port import AgentPort
from arena_core.providers.types import AgentCall, AgentResult, CallContext, Message, Usage
from arena_core.scoring.inclusion import Exec
from arena_core.scoring.rubric import CheckResult, RubricResult
from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel
from arena_referee import db
from arena_referee.debrief import DebriefProvenance

TRIAL = "00000000-0000-0000-0000-00000000000a"
VARIANT = UUID("00000000-0000-0000-0000-0000000000b1")
SESSION = "00000000-0000-0000-0000-00000000000c"


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


AnswerMap = Mapping[str, list[tuple[Any, ...]] | None]


class FakeConn:
    """Answers the first registered substring found in the statement text; records every call."""

    def __init__(self, answers: AnswerMap | None = None) -> None:
        self.answers: AnswerMap = answers or {}
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> FakeCursor:
        self.executed.append((query, params))
        for key, rows in self.answers.items():
            if key in query:
                return FakeCursor(rows or [])
        return FakeCursor([])

    def transaction(self) -> AsyncIterator[None]:
        return cast("AsyncIterator[None]", _noop_tx())


def connector(conn: FakeConn) -> Connector:
    @asynccontextmanager
    async def connect() -> AsyncIterator[FakeConn]:
        yield conn

    return cast("Connector", connect)


SUBJECT_CALL: AgentCall[RefereeSubjectReport] = AgentCall(
    model=VertexModel.FLASH_LITE_31,
    thinking=ThinkingLevel.LOW,
    system="system",
    messages=(Message("user", "hi"),),
    schema=RefereeSubjectReport,
    context=CallContext(call_type=CallType.REFEREE, purpose="referee_subject", step_key=f"{TRIAL}:referee_subject"),
)
ASSISTANT_CALL: AgentCall[RefereeAssistantReport] = AgentCall(
    model=VertexModel.FLASH_LITE_35,
    thinking=ThinkingLevel.MINIMAL,
    system="system",
    messages=(Message("user", "hi"),),
    schema=RefereeAssistantReport,
    context=CallContext(call_type=CallType.REFEREE, purpose="referee_assistant", step_key=f"{TRIAL}:referee_assistant"),
)


def subject_report() -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {"schema_version": "ref_subj.v5", "turns": [], "trajectory": {"self_consistent": True, "conflicts": []}}
    )


def assistant_report() -> RefereeAssistantReport:
    return RefereeAssistantReport.model_validate(
        {"schema_version": "ref_asst.v2", "flags": [], "followups": [], "citations": [], "subchecks": []}
    )


@dataclass
class FakePort:
    """Duck-types `AgentPort`: `make_scoring_deps` only ever calls `.run(call)` on it."""

    subject_value: RefereeSubjectReport
    assistant_value: RefereeAssistantReport
    calls: list[AgentCall[Any]] = field(default_factory=list)

    async def run[T: BaseModel](self, call: AgentCall[T]) -> AgentResult[T]:
        self.calls.append(call)
        value = self.subject_value if call.schema is RefereeSubjectReport else self.assistant_value
        return AgentResult(
            value=cast("T", value),
            attempts=1,
            usage=Usage(),
            cost_usd=Decimal("0"),
            latency_ms=0.0,
            trace_id=None,
            span_id=None,
            reservation_id=uuid4(),
        )


# ---------------------------------------------------------------- _packet_row / fetch_trial_data


def _trial_data_conn(extra: AnswerMap | None = None) -> FakeConn:
    base: dict[str, list[tuple[Any, ...]] | None] = {
        "from arena.trials t": [(VARIANT, "dev")],
        "sealed.evaluator_packets": [({"canonical_facts": [{"id": "f:01", "statement": "x", "material": True}]},)],
        "subject.private_packets": [({"case_id": "C-1", "role": "truthful"},)],
        "arena.public_packets": [({"case_id": "C-1"},)],
        "sealed.hidden_public_packets": None,
        "arena.released_evidence": [],
        "arena.turns": [],
        "trial_events": [],
        "arena.final_findings": [],
    }
    base.update(extra or {})
    return FakeConn(base)


def test_fetch_trial_data_happy_path_via_public_packets() -> None:
    conn = _trial_data_conn()
    data = run(db.fetch_trial_data(connector(conn), TRIAL))
    assert data.trial_id == TRIAL
    assert data.split == "dev"
    assert data.private_packet == {"case_id": "C-1", "role": "truthful"}
    assert data.public_packet == {"case_id": "C-1"}
    assert data.released == []
    assert data.transcript == []
    assert data.cards == []
    assert data.final_finding is None


def test_fetch_trial_data_falls_back_to_hidden_public_packets() -> None:
    conn = _trial_data_conn({"arena.public_packets": None, "sealed.hidden_public_packets": [({"case_id": "C-2"},)]})
    data = run(db.fetch_trial_data(connector(conn), TRIAL))
    assert data.public_packet == {"case_id": "C-2"}


def test_fetch_trial_data_returns_released_transcript_cards_and_finding() -> None:
    conn = _trial_data_conn(
        {
            "arena.released_evidence": [("rec-01", "Work order", {"body": "x"}, 1)],
            "arena.turns": [(1, "Why?", "Because.", "investigator")],
            "trial_events": [({"text": "a card"},)],
            "arena.final_findings": [({"label": "deceptive"},)],
        }
    )
    data = run(db.fetch_trial_data(connector(conn), TRIAL))
    assert data.released == [
        {"record_id": "rec-01", "title": "Work order", "content": {"body": "x"}, "released_after": 1, "date": None}
    ]
    assert data.transcript == [
        {"turn_no": 1, "question": "Why?", "answer": "Because.", "question_source": "investigator"}
    ]
    assert data.cards == [{"text": "a card"}]
    assert data.final_finding == {"label": "deceptive"}


def test_fetch_trial_data_turns_query_excludes_unanswered_turns() -> None:
    """A quarantined turn (SG2-39) leaves an `arena.turns` row with a null answer (`turn_answer_shape`); the
    referee's transcript is committed exchanges only -- `TranscriptTurn.answer` is a non-empty string, and a
    trial quarantined on its first turn must produce an EMPTY transcript (S2 6.10), not a null one. A fake
    connector cannot prove the database enforces this filter, so this only proves the query text asks for
    it; see the report's documented scope cut on live-database coverage for this fix."""
    conn = _trial_data_conn()
    run(db.fetch_trial_data(connector(conn), TRIAL))
    (turns_query, _) = next(call for call in conn.executed if "arena.turns" in call[0])
    assert "answer is not null" in turns_query


def test_fetch_trial_kind_found_and_missing() -> None:
    found = FakeConn({"from arena.trials where id": [("interactive",)]})
    assert run(db.fetch_trial_kind(connector(found), TRIAL)) == "interactive"
    missing = FakeConn({"from arena.trials where id": []})
    assert run(db.fetch_trial_kind(connector(missing), TRIAL)) is None


def test_fetch_trial_data_no_trial_raises() -> None:
    conn = _trial_data_conn({"from arena.trials t": []})
    with pytest.raises(LookupError, match="no trial"):
        run(db.fetch_trial_data(connector(conn), TRIAL))


def test_fetch_trial_data_no_evaluator_packet_raises() -> None:
    conn = _trial_data_conn({"sealed.evaluator_packets": []})
    with pytest.raises(LookupError, match="no evaluator packet"):
        run(db.fetch_trial_data(connector(conn), TRIAL))


def test_fetch_trial_data_missing_private_packet_raises() -> None:
    conn = _trial_data_conn({"subject.private_packets": None})
    with pytest.raises(LookupError, match="missing its private or public packet"):
        run(db.fetch_trial_data(connector(conn), TRIAL))


def test_fetch_trial_data_missing_both_public_packets_raises() -> None:
    conn = _trial_data_conn({"arena.public_packets": None, "sealed.hidden_public_packets": None})
    with pytest.raises(LookupError, match="missing its private or public packet"):
        run(db.fetch_trial_data(connector(conn), TRIAL))


# ---------------------------------------------------------------- sealed writes (S2 7.2, S3 4.2)


def test_get_judgment_found_and_missing() -> None:
    found = FakeConn({"sealed.judgments": [({"a": 1},)]})
    assert run(db.get_judgment(connector(found), "key")) == {"a": 1}
    missing = FakeConn({"sealed.judgments": []})
    assert run(db.get_judgment(connector(missing), "key")) is None


def test_store_labels_calls_record_independent_labels() -> None:
    conn = FakeConn()
    rows = [{"turn_id": "t01", "label": "responsive"}]
    run(db.store_labels(connector(conn), TRIAL, "model", rows, "a" * 64))
    (query, params) = conn.executed[0]
    assert "sealed.record_independent_labels" in query
    assert params[0] == UUID(TRIAL)
    assert params[1] == "model"
    assert isinstance(params[2], Jsonb)
    assert params[2].obj == rows
    assert params[3] == "a" * 64


def test_store_judgment_calls_record_judgment() -> None:
    conn = FakeConn()
    row = db.JudgmentRow(
        trial_id=TRIAL, kind="fidelity_detail", rater_id=None, payload={"x": 1}, prompt_sha256="h", idempotency_key="k"
    )
    run(db.store_judgment(connector(conn), row))
    (query, params) = conn.executed[0]
    assert "sealed.record_judgment" in query
    assert params[0] == UUID(TRIAL)
    assert params[1] == "fidelity_detail"
    assert params[2] is None
    assert isinstance(params[3], Jsonb)
    assert params[3].obj == {"x": 1}
    assert params[4:] == ("h", "k")


def test_adjudicate_valid_calls_adjudicate_validity() -> None:
    conn = FakeConn()
    run(db.adjudicate_valid(connector(conn), TRIAL, "clean report", "evref"))
    (query, params) = conn.executed[0]
    assert "ledger.adjudicate_validity" in query
    assert params == (UUID(TRIAL), "clean report", "evref", "evref:validity")


def test_make_scoring_deps_wires_every_field() -> None:
    conn = _trial_data_conn({"sealed.judgments": []})
    port = FakePort(subject_value=subject_report(), assistant_value=assistant_report())
    deps = db.make_scoring_deps(connector(conn), cast("AgentPort", port), "prompt-sha")

    assert deps.prompt_sha256 == "prompt-sha"
    data = run(deps.fetch_trial_data(TRIAL))
    assert data.trial_id == TRIAL
    assert run(deps.get_judgment("some-key")) is None
    run(deps.store_labels(TRIAL, "model", [], "prompt-sha"))
    run(deps.store_judgment(TRIAL, "fidelity_detail", None, {"a": 1}, "key-1"))
    run(deps.adjudicate_valid(TRIAL, "reason", "evref"))
    assert run(deps.run_subject_call(SUBJECT_CALL)) == port.subject_value
    assert run(deps.run_assistant_call(ASSISTANT_CALL)) == port.assistant_value
    expected_calls = 2
    assert len(port.calls) == expected_calls


# ---------------------------------------------------------------- training session and debrief (S5 5.4)


def test_fetch_session_happy_path_with_committed_finding() -> None:
    finding = {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [],
        "cited_records": [],
        "corroboration_needed": ["the work order"],
        "rationale": "Not yet established.",
        "alternative_explanations": None,
        "last_revised_turn": None,
    }
    conn = FakeConn(
        {
            "training.sessions": [(UUID(TRIAL), False, VARIANT, "finalized")],
            "sealed.evaluator_packets": [({"canonical_facts": []},)],
            "arena.final_findings": [(finding,)],
        }
    )
    info = run(db.fetch_session(connector(conn), SESSION))
    assert info.trial_id == TRIAL
    assert info.voice is False
    assert info.trial_status == "finalized"
    assert info.evaluator_packet == {"canonical_facts": []}
    assert info.committed_finding is not None
    assert info.committed_finding.label == "insufficient_evidence"


def test_fetch_session_no_committed_finding() -> None:
    conn = FakeConn(
        {
            "training.sessions": [(UUID(TRIAL), True, VARIANT, "terminated")],
            "sealed.evaluator_packets": [({"canonical_facts": []},)],
            "arena.final_findings": [],
        }
    )
    info = run(db.fetch_session(connector(conn), SESSION))
    assert info.voice is True
    assert info.trial_status == "terminated"
    assert info.committed_finding is None


def test_fetch_session_no_session_raises() -> None:
    conn = FakeConn({"training.sessions": []})
    with pytest.raises(LookupError, match="no session"):
        run(db.fetch_session(connector(conn), SESSION))


def test_fetch_session_no_evaluator_packet_raises() -> None:
    conn = FakeConn({"training.sessions": [(UUID(TRIAL), False, VARIANT, "finalized")], "sealed.evaluator_packets": []})
    with pytest.raises(LookupError, match="no evaluator packet"):
        run(db.fetch_session(connector(conn), SESSION))


def test_get_debrief_found_and_missing() -> None:
    found = FakeConn({"training.debriefs": [({"schema_version": "debrief.v1"},)]})
    assert run(db.get_debrief(connector(found), SESSION)) == {"schema_version": "debrief.v1"}
    missing = FakeConn({"training.debriefs": []})
    assert run(db.get_debrief(connector(missing), SESSION)) is None


def test_publish_debrief_calls_publish_debrief_function() -> None:
    conn = FakeConn()
    run(db.publish_debrief(connector(conn), SESSION, {"schema_version": "debrief.v1"}))
    (query, params) = conn.executed[0]
    assert "training.publish_debrief" in query
    assert params[0] == UUID(SESSION)
    assert isinstance(params[1], Jsonb)
    assert params[1].obj == {"schema_version": "debrief.v1"}


def _rubric_result(*, scorable: bool) -> RubricResult:
    return RubricResult(
        scorable=scorable,
        unscorable_reason=None if scorable else "fewer than three investigator questions",
        checks={"1a": CheckResult(True, (1,))} if scorable else {},
        dimensions={"D1": 4, "D2": 3, "D3": 2, "D4": 1, "D5": 0} if scorable else {},
        total=10 if scorable else None,
        qq=None,
    )


def test_store_rubric_score_inserts_when_scorable() -> None:
    conn = FakeConn()
    run(db.store_rubric_score(connector(conn), SESSION, _rubric_result(scorable=True), "scorer-ref"))
    assert len(conn.executed) == 1
    (query, params) = conn.executed[0]
    assert "insert into training.rubric_scores" in query
    assert params[0] == UUID(SESSION)
    assert params[1] == "proxy"
    assert params[2] == "scorer-ref"
    assert params[3:8] == (4, 3, 2, 1, 0)
    assert isinstance(params[8], Jsonb)
    assert params[8].obj == {"checks": {"1a": {"result": True, "turns": [1]}}}


def test_store_rubric_score_is_a_noop_when_unscorable() -> None:
    conn = FakeConn()
    run(db.store_rubric_score(connector(conn), SESSION, _rubric_result(scorable=False), "scorer-ref"))
    assert conn.executed == []


def test_make_debrief_deps_wires_every_field() -> None:
    conn = FakeConn(
        {
            "training.sessions": [(UUID(TRIAL), False, VARIANT, "finalized")],
            "sealed.evaluator_packets": [({"canonical_facts": []},)],
            "arena.final_findings": [],
            "training.debriefs": [],
        }
    )
    scoring_conn = _trial_data_conn()
    port = FakePort(subject_value=subject_report(), assistant_value=assistant_report())
    scoring = db.make_scoring_deps(connector(scoring_conn), cast("AgentPort", port), "prompt-sha")
    provenance = DebriefProvenance(
        rubric_sha256="r" * 64,
        r3_prompt_sha256=("a" * 64, "b" * 64),
        referee_model_ids=("gemini-3.1-flash-lite", "gemini-3.5-flash-lite"),
        scorer_git_sha="0" * 40,
    )
    deps = db.make_debrief_deps(connector(conn), scoring, provenance)

    assert deps.scoring is scoring
    assert deps.provenance is provenance
    info = run(deps.fetch_session(SESSION))
    assert info.trial_id == TRIAL
    assert run(deps.get_debrief(SESSION)) is None
    run(deps.publish_debrief(SESSION, {"schema_version": "debrief.v1"}))
    run(deps.store_rubric_score(SESSION, _rubric_result(scorable=True), "scorer-ref"))
    assert any("training.publish_debrief" in q for q, _ in conn.executed)
    assert any("training.rubric_scores" in q for q, _ in conn.executed)


# ---------------------------------------------------------------- blinded trainer review queue (S3 7.3)


RATER = uuid4()
CONTEXT_TRIAL = UUID(TRIAL)


def _new_item(**overrides: object) -> db.NewReviewItem:
    base: dict[str, Any] = {
        "kind": "T-RUB",
        "instrument": "rubric.v1",
        "rater_user_id": RATER,
        "context_trial_id": CONTEXT_TRIAL,
        "context_session_id": None,
        "payload": {"a": 1},
    }
    base.update(overrides)
    return db.NewReviewItem(**base)


def test_create_review_item_returns_the_new_id() -> None:
    item_id = uuid4()
    conn = FakeConn({"training.create_review_item": [(item_id,)]})
    result = run(db.create_review_item(connector(conn), _new_item()))
    assert result == item_id
    (query, params) = conn.executed[0]
    assert "training.create_review_item" in query
    assert params[0] == "T-RUB"
    # The payload's own item_id is generated here, never left to the caller, and never a fresh one chosen
    # independently by SQL: the row's identity and the stored item's own `item_id` field must agree.
    sent_payload = params[5].obj
    assert sent_payload["a"] == 1
    assert isinstance(UUID(sent_payload["item_id"]), UUID)


def test_create_review_item_raises_when_no_row_returned() -> None:
    conn = FakeConn({"training.create_review_item": []})
    with pytest.raises(LookupError, match="create_review_item returned no row"):
        run(db.create_review_item(connector(conn), _new_item()))


def test_list_review_items_found_and_empty() -> None:
    found = FakeConn({"training.list_review_items": [([{"item_id": "x"}],)]})
    assert run(db.list_review_items(connector(found), RATER)) == [{"item_id": "x"}]
    empty = FakeConn({"training.list_review_items": []})
    assert run(db.list_review_items(connector(empty), RATER)) == []


def test_get_review_item_found_and_missing() -> None:
    item_id = uuid4()
    found = FakeConn({"training.get_review_item": [({"item_id": str(item_id)},)]})
    assert run(db.get_review_item(connector(found), item_id, RATER)) == {"item_id": str(item_id)}
    missing = FakeConn({"training.get_review_item": [(None,)]})
    assert run(db.get_review_item(connector(missing), item_id, RATER)) is None


def test_submit_review_item_returns_the_result() -> None:
    item_id = uuid4()
    conn = FakeConn({"training.submit_review_item": [({"status": "submitted"},)]})
    result = run(db.submit_review_item(connector(conn), item_id, RATER, {"answers": []}))
    assert result == {"status": "submitted"}
    (query, params) = conn.executed[0]
    assert "training.submit_review_item" in query
    assert params[0] == item_id
    assert params[1] == RATER
    assert params[2].obj == {"answers": []}


def test_submit_review_item_raises_when_no_row_returned() -> None:
    conn = FakeConn({"training.submit_review_item": []})
    with pytest.raises(LookupError, match="submit_review_item returned no row"):
        run(db.submit_review_item(connector(conn), item_id=uuid4(), rater_user_id=RATER, submission={}))


# ---------------------------------------------------------------- reveal, isolation gate, leaderboard (WP-16)

TOURNAMENT = UUID("00000000-0000-0000-0000-0000000000a1")
MANIFEST = UUID("00000000-0000-0000-0000-0000000000a2")
CANDIDATE = UUID("00000000-0000-0000-0000-0000000000a3")


def test_reveal_tournament_returns_manifest_version_one() -> None:
    conn = FakeConn({"ledger.reveal": [({"manifest_id": str(MANIFEST), "manifest_sha256": "a" * 64},)]})
    result = run(db.reveal_tournament(connector(conn), str(TOURNAMENT)))
    assert result == db.RevealResult(str(MANIFEST), "a" * 64, 1)
    (query, params) = conn.executed[0]
    assert "ledger.reveal" in query
    assert params == (TOURNAMENT,)


def test_seal_corrected_manifest_returns_the_new_version() -> None:
    conn = FakeConn(
        {
            "ledger.seal_corrected_manifest": [
                ({"manifest_id": str(MANIFEST), "manifest_sha256": "b" * 64, "version": 2},)
            ]
        }
    )
    result = run(db.seal_corrected_manifest(connector(conn), str(TOURNAMENT)))
    assert result == db.RevealResult(str(MANIFEST), "b" * 64, 2)


def test_record_isolation_check_inserts_candidate_only_when_given() -> None:
    conn = FakeConn({})
    row = db.IsolationCheckRow(
        check_name="ig6_canary_audit",
        passed=False,
        evidence_hash="deadbeef",
        commit_sha="0" * 40,
        candidate_id=str(CANDIDATE),
    )
    run(db.record_isolation_check(connector(conn), row))
    (query, params) = conn.executed[0]
    assert "arena.isolation_checks" in query
    assert params[0] == CANDIDATE
    assert params[1] == "ig6_canary_audit"
    assert params[2] is False
    assert params[3].obj == {"hash": "deadbeef", "commit_sha": "0" * 40}

    conn2 = FakeConn({})
    no_candidate = db.IsolationCheckRow(
        check_name="ig5_commitment_verification", passed=True, evidence_hash="x", commit_sha="0" * 40, candidate_id=None
    )
    run(db.record_isolation_check(connector(conn2), no_candidate))
    assert conn2.executed[0][1][0] is None


def test_fetch_isolation_result_maps_check_names_back_to_ig_items() -> None:
    conn = FakeConn(
        {
            "distinct on (check_name)": [
                ("ig1_privilege_tests", True, "h1"),
                ("ig2_route_tests", False, "h2"),
                ("ig3_assistant_context", True, "h3"),
                ("ig4_hidden_text_scan", True, "h4"),
                ("ig5_commitment_verification", True, "h5"),
                ("ig6_canary_audit", True, "h6"),
            ]
        }
    )
    result = run(db.fetch_isolation_result(connector(conn), "0" * 40))
    assert result.passed is False  # IG-2 failed
    assert result.items["IG-2"] == (False, "h2")


def test_fetch_isolation_result_with_no_rows_fails_closed() -> None:
    conn = FakeConn({"distinct on (check_name)": []})
    result = run(db.fetch_isolation_result(connector(conn), "0" * 40))
    assert result.passed is False


def test_fetch_tournament_trial_facts_maps_every_column() -> None:
    conn = FakeConn(
        {
            "ledger.planned_execution": [
                (
                    "00000000-0000-0000-0000-0000000000b1",
                    "interactive",
                    str(CANDIDATE),
                    "F01",
                    "truthful",
                    "00000000-0000-0000-0000-0000000000b2",
                    "completed",
                    "valid",
                    "truthful",
                    "0.05",
                )
            ]
        }
    )
    [fact] = run(db.fetch_tournament_trial_facts(connector(conn), str(TOURNAMENT)))
    assert fact.assistant_id == str(CANDIDATE)
    assert fact.family_id == "F01"
    assert fact.exec_state == Exec.COMPLETED
    assert fact.classification == "truthful"
    assert fact.settled_cost == Decimal("0.05")


def test_write_leaderboard_inserts_with_on_conflict_do_nothing() -> None:
    conn = FakeConn({})
    row = db.LeaderboardRow(
        tournament_id=str(TOURNAMENT),
        manifest_id=str(MANIFEST),
        board="assistant",
        label="original",
        body={"status": "definitive"},
    )
    run(db.write_leaderboard(connector(conn), row))
    (query, params) = conn.executed[0]
    assert "on conflict (manifest_id, board) do nothing" in query
    assert params[0] == TOURNAMENT
    assert params[1] == MANIFEST
    assert params[2] == "assistant"
    assert params[3] == "original"
    assert params[4].obj == {"status": "definitive"}


def test_fetch_leaderboard_returns_the_body_or_none() -> None:
    found = FakeConn({"arena.leaderboards": [({"status": "definitive"},)]})
    assert run(db.fetch_leaderboard(connector(found), str(TOURNAMENT))) == {"status": "definitive"}
    (_query, params) = found.executed[0]
    assert params == (TOURNAMENT, "assistant", "original")

    missing = FakeConn({"arena.leaderboards": []})
    assert run(db.fetch_leaderboard(connector(missing), str(TOURNAMENT), label="corrected")) is None
    assert missing.executed[0][1] == (TOURNAMENT, "assistant", "corrected")
