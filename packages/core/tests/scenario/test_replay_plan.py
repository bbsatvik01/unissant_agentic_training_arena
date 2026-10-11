"""S2 8.6 `replay_script.v1`: the C-23 request rule and the evidence-slot rule (AT-HAR-5)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from arena_core.scenario import relay
from arena_core.scenario.relay import ReleasedRecord

OPENING = "Can you describe what you did that afternoon?"
TOPICS = ("the vault entry", "the held door", "your shift tasks")
REQUESTABLE = [
    {"record_id": "rec-03", "requestable_after_exchanges": 3, "title": "Alarm history"},
    {"record_id": "rec-01", "requestable_after_exchanges": 2, "title": "Work orders"},
    {"record_id": "rec-02", "requestable_after_exchanges": 3, "title": "Radio log"},
    {"record_id": "rec-04", "requestable_after_exchanges": 6, "title": "Seal audit", "date": "2026-03-13"},
]


def test_requests_every_eligible_record_once_in_record_id_order() -> None:
    assert relay.replay_requests(REQUESTABLE, completed=0, already_requested=()) == []
    assert relay.replay_requests(REQUESTABLE, completed=1, already_requested=()) == []
    assert relay.replay_requests(REQUESTABLE, completed=2, already_requested=()) == ["rec-01"]
    assert relay.replay_requests(REQUESTABLE, completed=3, already_requested=["rec-01"]) == ["rec-02", "rec-03"]
    # A record not requested at its first eligible exchange is requested at the next call, never twice.
    assert relay.replay_requests(REQUESTABLE, completed=4, already_requested=()) == ["rec-01", "rec-02", "rec-03"]
    done = ["rec-01", "rec-02", "rec-03"]
    assert relay.replay_requests(REQUESTABLE, completed=5, already_requested=done) == []
    assert relay.replay_requests(REQUESTABLE, completed=6, already_requested=done) == ["rec-04"]


def test_no_release_gives_the_script_rows_in_order() -> None:
    plan = relay.replay_questions(OPENING, TOPICS, ())
    assert [e.question for e in plan] == relay.render_replay_script(OPENING, TOPICS)
    assert [e.script_row for e in plan] == list(range(1, 13))
    assert all(e.record_id is None for e in plan)


def _rel(record_id: str, after: int, title: str | None = None, date: str | None = None) -> ReleasedRecord:
    return ReleasedRecord(record_id, after, title or f"Record {record_id}", date)


def test_a_release_displaces_the_next_row_and_the_script_resumes_there() -> None:
    plan = relay.replay_questions(OPENING, TOPICS, [_rel("rec-01", 2, "Work orders")])
    # Released after exchange 2, so exchange 3 asks about it; the displaced row 3 is asked at exchange 4.
    assert plan[2].question == "We have Work orders. Can you tell me about it?"
    assert (plan[2].record_id, plan[2].script_row) == ("rec-01", None)
    assert [e.script_row for e in plan] == [1, 2, None, 3, 4, 5, 6, 7, 8, 9, 10, 11]


def test_the_dated_slot_form_is_used_when_the_record_lists_a_date() -> None:
    plan = relay.replay_questions(OPENING, TOPICS, [_rel("rec-04", 6, "Seal audit", "2026-03-13")])
    assert plan[6].question == "We have Seal audit, dated 2026-03-13. Can you tell me about it?"


def test_six_releases_are_asked_earliest_first_and_ties_in_record_id_order() -> None:
    """AT-HAR-5 slot order on a case with 6 releases, scheduled and requested."""
    releases = [
        _rel("rec-05", 5),  # scheduled
        _rel("rec-03", 3),
        _rel("rec-02", 3),
        _rel("rec-01", 2),
        _rel("rec-06", 9),
        _rel("rec-04", 6),
    ]
    plan = relay.replay_questions(OPENING, TOPICS, releases)
    expected = [None, None, "rec-01", "rec-02", "rec-03", "rec-05", "rec-04", None, None, "rec-06", None, None]
    assert [e.record_id for e in plan] == expected
    assert [e.script_row for e in plan if e.script_row is not None] == [1, 2, 3, 4, 5, 6]


def test_more_releases_than_exchanges_drops_the_latest() -> None:
    releases = [_rel(f"rec-{i:02d}", 1) for i in range(1, 7)] + [_rel("rec-07", 10)]
    plan = relay.replay_questions(OPENING, TOPICS, releases, exchanges=5)
    assert [e.record_id for e in plan] == [None, "rec-01", "rec-02", "rec-03", "rec-04"]


def test_the_opening_question_is_never_displaced() -> None:
    """S2 8.1: every trial opens with the opening question; a record released before exchange 1 waits for 2."""
    plan = relay.replay_questions(OPENING, TOPICS, [_rel("rec-01", 0)])
    assert plan[0].question == OPENING
    assert plan[1].record_id == "rec-01"


def test_the_plan_is_prefix_stable_so_the_live_harness_can_ask_one_at_a_time() -> None:
    """Exchange n depends only on releases made before it: a later release never changes an earlier question."""
    releases = [_rel("rec-01", 2), _rel("rec-02", 3), _rel("rec-05", 5), _rel("rec-04", 6)]
    full = relay.replay_questions(OPENING, TOPICS, releases)
    for n in range(1, 13):
        known = [r for r in releases if r.released_after <= n - 1]
        assert relay.replay_question(n, OPENING, TOPICS, known) == full[n - 1]
        assert relay.replay_question(n, OPENING, TOPICS, releases) == full[n - 1]


@pytest.mark.parametrize("n", [0, 13])
def test_replay_question_rejects_an_exchange_outside_the_script(n: int) -> None:
    with pytest.raises(ValueError, match="exchange"):
        relay.replay_question(n, OPENING, TOPICS, ())


def _scheduled(family: dict[str, Any], variant: str) -> list[ReleasedRecord]:
    return [
        ReleasedRecord(a["artifact_id"], a["release"]["after_exchanges"], a["title"])
        for a in family["variants"][variant]["evaluator_packet"]["evidence_artifacts"]
        if a["release"]["type"] == "scheduled"
    ]


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09"])
@pytest.mark.parametrize("variant", ["truthful", "deceptive"])
def test_every_dev_case_plan_passes_the_relay_test_and_requests_on_time(
    family_id: str, variant: str, seed: Callable[[str], dict[str, Any]]
) -> None:
    """AT-HAR-5 on every dev case: 12 questions pass relay_test.v1 in order with the repeat rule, and each
    requestable record is requested before the first exchange its predicate allows."""
    family = seed(family_id)
    public = family["variants"][variant]["public_packet"]
    plan = relay.plan_replay(public, _scheduled(family, variant))
    assert len(plan.exchanges) == relay.REPLAY_EXCHANGES
    asked: list[str] = []
    for exchange in plan.exchanges:
        result = relay.relay_test(exchange.question, asked)
        assert result.passed, (exchange, result.reason)
        asked.append(exchange.question)
    for record in public["requestable_records"]:
        after = record["requestable_after_exchanges"]
        assert record["record_id"] in plan.requests[after + 1], (record, plan.requests)
        assert sum(record["record_id"] in ids for ids in plan.requests.values()) == 1


def test_plan_replay_releases_requests_and_schedules_at_their_predicate(seed: Callable[[str], dict[str, Any]]) -> None:
    family = seed("F01")
    public = family["variants"]["truthful"]["public_packet"]
    plan = relay.plan_replay(public, _scheduled(family, "truthful"))
    # F01: rec-01 after 2; rec-02, rec-03 after 3; rec-05 scheduled after 5; rec-04 after 6.
    assert {n: ids for n, ids in plan.requests.items() if ids} == {
        3: ["rec-01"],
        4: ["rec-02", "rec-03"],
        7: ["rec-04"],
    }
    expected = [None, None, "rec-01", "rec-02", "rec-03", "rec-05", "rec-04", None, None, None, None, None]
    assert [e.record_id for e in plan.exchanges] == expected
