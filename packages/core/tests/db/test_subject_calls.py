"""`arena_core.db.subject`: `turn_context` and `record_subject_turn` on a stand-in connection that answers as
the S4 functions do (S2 6.2, 6.7, 6.10). They prove the SQL sent, the jsonb parsing, and the protocol-error
mapping; `services/subject/tests/it_answer.py` (run under `make db-test`) proves the same paths against the
real migrated functions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, Literal, cast
from uuid import uuid4

import pytest

from arena_core.db import subject as db_subject
from arena_core.db.calls import Conn, GuardProtocolError

TRIAL = uuid4()
WORK_ITEM = uuid4()

TURN_CONTEXT_ANSWER: dict[str, Any] = {
    "trial_id": str(TRIAL),
    "turn_no": 1,
    "transcript_version": 1,
    "exchanges": 0,
    "private_packet": {"role": "deceptive"},
    "public_packet": {"case_id": "C-00000001"},
    "transcript": [{"turn_no": 1, "question": "Hi?", "answer": None, "channel": "text"}],
    "released_evidence": [],
    "disclosure_state": {"disclosed": [], "gates_opened": []},
    "subject_manifest": {"candidate_id": "S2"},
}


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None


class _Conn:
    """Answers `select <fn>(...)::text` with the jsonb text registered for `<fn>`; records every statement."""

    def __init__(self, answers: dict[str, object]) -> None:
        self.answers: dict[str, Any] = answers
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self.transactions = 0

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.transactions += 1
        yield

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> Cursor:
        self.executed.append((query, params))
        for name, answer in self.answers.items():
            if name in query:
                if isinstance(answer, list):
                    return Cursor(answer)
                return Cursor([] if answer is None else [(json.dumps(answer) if isinstance(answer, dict) else answer,)])
        return Cursor([])


def conn(**answers: object) -> tuple[Conn, _Conn]:
    fake = _Conn(answers)
    return cast("Conn", fake), fake


def _tag() -> dict[str, Any]:
    return {"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []}


def record_req(
    *,
    utterance: str = "I left at nine.",
    tag: dict[str, Any] | Literal["default"] | None = "default",
    guard_result: dict[str, Any] | None = None,
) -> db_subject.RecordSubjectTurn:
    resolved_tag = _tag() if tag == "default" else tag
    return db_subject.RecordSubjectTurn(
        trial_id=TRIAL,
        work_item_id=WORK_ITEM,
        utterance=utterance,
        tag=resolved_tag,
        guard_result=guard_result or {"passed": True},
    )


# ---------------------------------------------------------------- turn_context


def test_turn_context_sends_trial_and_work_item_and_parses_every_field() -> None:
    c, fake = conn(**{"subject.turn_context": TURN_CONTEXT_ANSWER})
    got = run(db_subject.turn_context(c, TRIAL, WORK_ITEM))
    assert got.trial_id == TRIAL
    assert (got.turn_no, got.transcript_version, got.exchanges) == (1, 1, 0)
    assert got.private_packet == {"role": "deceptive"}
    assert got.public_packet == {"case_id": "C-00000001"}
    assert got.transcript == TURN_CONTEXT_ANSWER["transcript"]
    assert got.released_evidence == []
    assert got.disclosure_state == {"disclosed": [], "gates_opened": []}
    assert got.subject_manifest == {"candidate_id": "S2"}
    query, params = fake.executed[0]
    assert "subject.turn_context(%s, %s)" in query
    assert params == (TRIAL, WORK_ITEM)
    assert fake.transactions == 1


def test_turn_context_no_row_is_a_protocol_error() -> None:
    c, _ = conn(**{"subject.turn_context": None})
    with pytest.raises(GuardProtocolError, match="no row"):
        run(db_subject.turn_context(c, TRIAL, WORK_ITEM))


def test_turn_context_a_non_text_answer_is_a_protocol_error() -> None:
    c, _ = conn(**{"subject.turn_context": [(42,)]})
    with pytest.raises(GuardProtocolError, match="expected jsonb"):
        run(db_subject.turn_context(c, TRIAL, WORK_ITEM))


def test_turn_context_a_non_object_answer_is_a_protocol_error() -> None:
    c, _ = conn(**{"subject.turn_context": [(json.dumps([1, 2]),)]})
    with pytest.raises(GuardProtocolError, match="non-object"):
        run(db_subject.turn_context(c, TRIAL, WORK_ITEM))


def test_turn_context_a_missing_field_is_a_protocol_error() -> None:
    incomplete = {k: v for k, v in TURN_CONTEXT_ANSWER.items() if k != "subject_manifest"}
    c, _ = conn(**{"subject.turn_context": incomplete})
    with pytest.raises(GuardProtocolError, match="missing subject_manifest"):
        run(db_subject.turn_context(c, TRIAL, WORK_ITEM))


def test_turn_context_a_malformed_trial_id_is_a_protocol_error() -> None:
    bad = {**TURN_CONTEXT_ANSWER, "trial_id": "not-a-uuid"}
    c, _ = conn(**{"subject.turn_context": bad})
    with pytest.raises(GuardProtocolError, match="malformed result"):
        run(db_subject.turn_context(c, TRIAL, WORK_ITEM))


# ---------------------------------------------------------------- record_subject_turn


def test_record_subject_turn_sends_the_tag_and_guard_result_as_jsonb_and_parses_recorded() -> None:
    answer = {"outcome": "recorded", "turn_no": 1, "transcript_version": 2}
    c, fake = conn(**{"arena.record_subject_turn": answer})
    got = run(db_subject.record_subject_turn(c, record_req()))
    assert got == db_subject.RecordResult(outcome="recorded", turn_no=1, transcript_version=2)
    query, params = fake.executed[0]
    assert "arena.record_subject_turn(%s, %s, %s, %s, %s)" in query
    assert params[0:3] == (TRIAL, WORK_ITEM, "I left at nine.")


def test_record_subject_turn_a_g0_quarantine_sends_null_tag_and_parses_no_version() -> None:
    answer = {"outcome": "quarantined", "turn_no": 1}
    c, fake = conn(**{"arena.record_subject_turn": answer})
    g0 = {"passed": False, "rule": "G0_schema"}
    got = run(db_subject.record_subject_turn(c, record_req(utterance="", tag=None, guard_result=g0)))
    assert got == db_subject.RecordResult(outcome="quarantined", turn_no=1, transcript_version=None)
    _, params = fake.executed[0]
    assert params[2] == ""
    assert params[3] is None


def test_record_subject_turn_no_row_is_a_protocol_error() -> None:
    c, _ = conn(**{"arena.record_subject_turn": None})
    with pytest.raises(GuardProtocolError, match="no row"):
        run(db_subject.record_subject_turn(c, record_req()))


def test_record_subject_turn_an_unknown_outcome_is_a_protocol_error() -> None:
    c, _ = conn(**{"arena.record_subject_turn": {"outcome": "maybe", "turn_no": 1}})
    with pytest.raises(GuardProtocolError, match="unknown outcome"):
        run(db_subject.record_subject_turn(c, record_req()))
