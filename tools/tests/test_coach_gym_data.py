"""`scripts/coach_gym/data.py` against a scripted connection: every statement is dev-only, a hidden or unknown trial is
refused, R1 and human labels map through the existing adapters. The same SQL against the real migrated database,
with a real hidden trial, is `tools/tests/it_coach_gym.py` (make db-test)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Coroutine, Sequence
from contextlib import asynccontextmanager
from typing import Any, cast
from uuid import uuid4

import pytest

from arena_core.coachgym.examples import HiddenSplitError
from arena_core.db.pool import Connector
from packages.core.tests.coachgym.support import packet
from packages.core.tests.scoring.builders import judgment, report
from scripts.coach_gym import data


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class _Conn:
    """Answers each statement by its exact text; records every statement and its parameters."""

    def __init__(self, answers: dict[str, list[tuple[Any, ...]]]) -> None:
        self.answers = answers
        self.executed: list[tuple[str, tuple[Any, ...]]] = []


Answers = dict[str, list[tuple[Any, ...]]]
Scripted = Callable[[Answers], tuple[Connector, _Conn]]


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch) -> Scripted:
    def make(answers: dict[str, list[tuple[Any, ...]]]) -> tuple[Connector, _Conn]:
        conn = _Conn(answers)

        async def one_statement(c: _Conn, query: str, params: Sequence[object] = ()) -> _Cursor:
            c.executed.append((query, tuple(params)))
            return _Cursor(c.answers.get(query, []))

        monkeypatch.setattr(data, "one_statement", one_statement)

        @asynccontextmanager
        async def connect() -> AsyncIterator[Any]:
            yield conn

        return cast("Connector", connect), conn

    return make


def label_payload(labels: dict[int, str]) -> dict[str, Any]:
    turns = []
    for n, label in sorted(labels.items()):
        turns.append(
            {
                "turn_id": f"t{n:02d}",
                "label": label,
                "eva_subtype": "appeal_to_routine" if label == "evasion" else None,
                "pfq_reason": None,
                "no_contradiction": True,
                "no_invention": True,
                "uncertainty_respected": True,
                "disclosure_policy_respected": True,
                "in_character": True,
                "platform_attack": False,
            }
        )
    return {"task": "T-LAB", "turns": turns}


def test_every_statement_carries_the_dev_only_predicate() -> None:
    assert len(data.STATEMENTS) == len({*data.STATEMENTS})
    for statement in data.STATEMENTS:
        assert "f.split = 'dev'" in statement
        assert "hidden" not in statement
        assert "sealed.hidden_public_packets" not in statement


def test_a_trial_the_dev_query_does_not_return_is_refused(scripted: Scripted) -> None:
    connect, conn = scripted({})  # the dev-only TRIAL query finds nothing for a hidden (or unknown) trial id
    tid = str(uuid4())
    with pytest.raises(HiddenSplitError, match="not a dev-split trial"):
        run(data.fetch_trial(connect, tid))
    assert [q for q, _ in conn.executed] == [data.TRIAL]  # nothing else about the trial is read


def test_a_dev_trial_is_read_with_its_labels(scripted: Scripted) -> None:
    tid, source = uuid4(), uuid4()
    r1 = {"report": report([judgment(1), judgment(2, label="evasion")]).model_dump(mode="json"), "quote_invalid": []}
    answers: Answers = {
        data.TRIAL: [("F01", "dev", "deceptive", packet("deceptive"), source)],
        data.TURNS: [(1, "Q1?", "A1."), (2, "Q2?", "A2.")],
        data.RELEASED: [("rec-01", "Badge log", {"body": "x"}, 1)],
        data.R1: [(r1,)],
        data.HUMAN_LABELS: [
            (label_payload({1: "evasion", 2: "evasion"}),),
            (label_payload({1: "responsive", 2: "evasion"}),),
        ],
    }
    connect, conn = scripted(answers)
    record = run(data.fetch_trial(connect, str(tid)))
    assert (record.family_code, record.split, record.role) == ("F01", "dev", "deceptive")
    assert [t["turn_no"] for t in record.transcript] == [1, 2]
    assert record.released == [
        {"record_id": "rec-01", "title": "Badge log", "content": {"body": "x"}, "after_exchanges": 1}
    ]
    assert record.referee_labels == {1: "responsive", 2: "evasion"}
    assert record.human_labels == {2: "evasion"}  # the raters split on t01, so R1 keeps it
    r1_params = [p for q, p in conn.executed if q == data.R1]
    assert r1_params == [(f"{source}:referee_subject",)]  # a replay trial reads its source transcript's R1


def test_an_unjudged_trial_has_no_labels() -> None:
    assert data.referee_labels(None) == {}
    assert data.human_labels([]) == {}


def test_fetch_dev_data_lists_then_reads_each_trial(scripted: Scripted) -> None:
    tid = uuid4()
    answers: Answers = {
        data.LIST_TRIALS: [(tid,)],
        data.TRIAL: [("F02", "dev", "truthful", packet("truthful"), tid)],
        data.TURNS: [(1, "Q1?", "A1.")],
        data.CANARIES: [("CANARY-a", "CANARY-b"), ("CANARY-a", None)],
    }
    connect, _ = scripted(answers)
    dev = run(data.fetch_dev_data(connect))
    assert [t.trial_id for t in dev.trials] == [str(tid)]
    assert dev.canaries == ["CANARY-a", "CANARY-b"]
