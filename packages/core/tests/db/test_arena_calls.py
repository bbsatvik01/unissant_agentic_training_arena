"""`arena_core.db.arena` against a scripted connection: each call's SQL, its actor binding, result parsing and the
SQLSTATE mapping (the real functions run in `services/api/tests/it_api.py` under make db-test)."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from arena_core.db.arena import EVENTS_PAGE, ArenaDb, ArenaError, QuestionOrigin, SessionStart, iso
from arena_core.db.pool import Connector

ACTOR = UUID("00000000-0000-0000-0000-00000000000a")
TRIAL = uuid4()
NOW = datetime(2026, 10, 11, 14, 0, 0, 123456, tzinfo=UTC)


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class StaleVersion(psycopg.Error):
    sqlstate = "AR002"


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self.rows[0] if self.rows else None


class Script:
    """A connection whose statements answer from `answers` (SQL fragment -> rows or an exception), in order."""

    def __init__(self, answers: list[tuple[str, list[tuple[Any, ...]] | Exception]]) -> None:
        self.answers = answers
        self.executed: list[tuple[str, tuple[object, ...]]] = []
        self.transactions = 0

    async def execute(self, query: str, params: tuple[object, ...] = ()) -> _Cursor:
        self.executed.append((query, tuple(params)))
        if query.startswith("select set_config"):
            return _Cursor([])
        fragment, answer = self.answers.pop(0)
        assert fragment in query, (fragment, query)
        if isinstance(answer, Exception):
            raise answer
        return _Cursor(answer)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.transactions += 1
        yield

    def connector(self) -> Connector:
        @asynccontextmanager
        async def connect() -> AsyncIterator[Script]:
            yield self

        return cast("Connector", connect)


def db(
    answers: list[tuple[str, list[tuple[Any, ...]] | Exception]], actor: UUID | None = ACTOR
) -> tuple[ArenaDb, Script]:
    script = Script(answers)
    return ArenaDb(script.connector(), actor), script


def j(value: object) -> list[tuple[Any, ...]]:
    return [(json.dumps(value),)]


def test_every_call_sets_the_actor_for_its_own_transaction() -> None:
    arena, script = db([("arena.submit_question", j({"turn_no": 1, "transcript_version": 1}))])
    assert run(arena.submit_question(TRIAL, 0, "Why?", "k" * 10)) == {"turn_no": 1, "transcript_version": 1}
    assert script.executed[0] == ("select set_config('arena.actor_id', %s, true)", (str(ACTOR),))
    assert script.transactions == 1


def test_a_harness_request_sets_no_actor() -> None:
    arena, script = db([("arena.open_work_item", j({"status": "open"}))], actor=None)
    run(arena.open_work_item(TRIAL, "release", "k" * 10))
    assert all("set_config" not in q for q, _ in script.executed)


def test_sqlstate_becomes_arena_error_with_its_code() -> None:
    arena, _ = db([("arena.submit_question", StaleVersion("stale transcript version"))])
    with pytest.raises(ArenaError) as exc_info:
        run(arena.submit_question(TRIAL, 3, "Why?", "k" * 10))
    assert exc_info.value.code == "AR002"
    assert "stale" in exc_info.value.message


def test_a_non_object_result_is_a_protocol_error() -> None:
    arena, _ = db([("arena.trial_context", [("[1]",)])])
    with pytest.raises(ArenaError, match="jsonb object"):
        run(arena.trial_context(TRIAL, uuid4()))
    arena, _ = db([("arena.trial_context", [])])
    with pytest.raises(ArenaError, match="no row"):
        run(arena.trial_context(TRIAL, uuid4()))


def test_function_wrappers_pass_their_arguments() -> None:
    wi = uuid4()
    start = SessionStart(uuid4(), "practice", uuid4(), uuid4(), voice=False, key="key-123456")
    arena, script = db(
        [
            ("training.start_session", j({"session_id": "s"})),
            ("arena.release_evidence", j({"released": []})),
            ("arena.record_coaching_event", j({"seq": 3})),
            ("arena.finalize_trial", j({"commitment_sha256": "c"})),
            ("arena.record_execution_failure", j({"state": "budget_truncated"})),
            ("training.issue_access_ticket", [("tok",)]),
            ("training.redeem_access_ticket", j({"trial_id": str(TRIAL)})),
            ("ops.ack_card", [(True,)]),
            ("training.acknowledge", [(NOW,)]),
        ]
    )
    run(arena.start_session(start))
    run(arena.release_evidence(TRIAL, wi, ["rec-01"]))
    run(arena.record_coaching_event(TRIAL, wi, {"turn_no": 1}, "coach_card"))
    run(arena.finalize_trial(TRIAL, wi, {"label": "truthful"}))
    run(arena.record_execution_failure(TRIAL, wi, "budget_truncated", "refused"))
    assert run(arena.issue_ticket("sse", TRIAL)) == "tok"
    assert run(arena.redeem_ticket("tok", "sse")) == {"trial_id": str(TRIAL)}
    assert run(arena.ack_card(TRIAL, 2, client_valid=True)) is True
    assert run(arena.acknowledge("ex4")) == NOW
    params = [p for q, p in script.executed if "set_config" not in q]
    assert params[0] == (start.variant, "practice", start.coach, start.subject, False, "key-123456")
    assert params[1] == (TRIAL, wi, ["rec-01"])


def test_acknowledge_without_a_time_is_a_protocol_error() -> None:
    arena, _ = db([("training.acknowledge", [(None,)])])
    with pytest.raises(ArenaError):
        run(arena.acknowledge("ex4"))


def test_release_between_turns_opens_and_releases_in_one_transaction() -> None:
    arena, script = db(
        [
            ("arena.open_work_item", j({"status": "open", "work_item_id": "w"})),
            ("arena.release_evidence", j({"released": [{"record_id": "rec-01"}]})),
        ]
    )
    assert run(arena.release_between_turns(TRIAL, "k" * 64, ["rec-01"]))["released"][0]["record_id"] == "rec-01"
    assert script.transactions == 1


def test_release_between_turns_sends_a_finished_item_through_s4_for_its_input_check() -> None:
    """A repeated key goes through `release_evidence` too: S4 answers the stored result for the same ids and
    refuses different ones (AR003), never this client."""
    done = j({"status": "done", "work_item_id": "w", "result": {"released": []}})

    class Reused(psycopg.Error):
        sqlstate = "AR003"

    arena, script = db(
        [
            ("arena.open_work_item", done),
            ("arena.release_evidence", j({"released": []})),
            ("arena.open_work_item", done),
            ("arena.release_evidence", Reused("work item reused with different input")),
        ]
    )
    assert run(arena.release_between_turns(TRIAL, "k" * 64, ["rec-01"])) == {"released": []}
    assert [p for q, p in script.executed if "release_evidence" in q] == [(TRIAL, "w", ["rec-01"])]
    with pytest.raises(ArenaError) as exc_info:
        run(arena.release_between_turns(TRIAL, "k" * 64, ["rec-02"]))
    assert exc_info.value.code == "AR003"


def test_release_between_turns_maps_errors() -> None:
    class Unknown(psycopg.Error):
        sqlstate = "AR005"

    arena, _ = db([("arena.open_work_item", Unknown("not requestable"))])
    with pytest.raises(ArenaError) as exc_info:
        run(arena.release_between_turns(TRIAL, "k" * 64, ["rec-09"]))
    assert exc_info.value.code == "AR005"


def test_trial_events_pages_until_a_short_page() -> None:
    page = [(n, "question_recorded", "live", n, 1, json.dumps({"turn_no": 1}), NOW) for n in range(1, 201)]
    arena, script = db([("arena.v_trial_events", page), ("arena.v_trial_events", page[:1])])
    events = run(arena.all_events(TRIAL))
    assert len(events) == EVENTS_PAGE + 1
    assert events[0].payload == {"turn_no": 1}
    assert script.executed[-1][1] == (TRIAL, 200, 200)


def test_projection_reads() -> None:
    variant, session, coach = uuid4(), uuid4(), uuid4()
    trial_row = (TRIAL, "practice", "running", 2, 1, 12, False, None, variant, session, False, NOW, coach)
    arena, _ = db(
        [
            ("arena.v_trials", [trial_row]),
            ("arena.v_trials", []),
            ("arena.v_released_evidence", [("rec-01", 2, json.dumps({"body": "b"}))]),
            ("arena.v_dev_cases", [(json.dumps({"case_id": "C"}),)]),
            ("arena.v_dev_cases", []),
            ("training.v_my_study", []),
            ("training.v_my_study", [("P1", "AB", 0, 0, 0, [variant], [], [])]),
            ("arena.v_dev_cases", [(variant, "F01", "C-1", json.dumps({"case_id": "C"}), False)]),
            (
                "training.v_my_sessions",
                [(session, TRIAL, "practice", False, NOW, "practice", "running", 1, variant, None)],
            ),
            ("arena.v_candidates", [(coach, json.dumps({"kind": "assistant"}))]),
            ("arena.v_candidates", []),
            ("arena.v_candidates", [(json.dumps({"k": 1}), "a" * 64)]),
            ("arena.v_candidates", []),
            ("training.v_my_debrief", [(json.dumps({"schema_version": "debrief.v1"}),)]),
            ("training.v_my_debrief", []),
            ("ops.v_public_config", [(True, 5, 1)]),
            ("ops.v_public_config", []),
            ("training.v_my_acknowledgements", [("ex4", NOW)]),
        ]
    )
    meta = run(arena.trial(TRIAL))
    assert meta is not None
    assert meta["assistant_candidate_id"] == coach
    assert meta["session_id"] == session
    assert run(arena.trial(TRIAL)) is None
    assert run(arena.released(TRIAL)) == [
        {"record_id": "rec-01", "released_after_exchanges": 2, "content": {"body": "b"}}
    ]
    assert run(arena.public_packet(variant)) == {"case_id": "C"}
    assert run(arena.public_packet(variant)) is None
    assert run(arena.study()) is None
    study = run(arena.study())
    assert study is not None
    assert study["pre"] == [variant]
    assert run(arena.dev_cases())[0]["family_code"] == "F01"
    assert run(arena.my_sessions())[0]["session_id"] == session
    assert run(arena.candidate("assistant", "A1")) == (coach, {"kind": "assistant"})
    assert run(arena.candidate("assistant", "A9")) is None
    assert run(arena.manifest(coach)) == {"manifest": {"k": 1}, "sha256": "a" * 64}
    assert run(arena.manifest(coach)) is None
    assert run(arena.debrief(session)) == {"schema_version": "debrief.v1"}
    assert run(arena.debrief(session)) is None
    assert run(arena.public_config())["paused"] is True
    assert run(arena.public_config())["paused"] is False
    assert run(arena.acknowledgements()) == {"ex4": NOW}


def test_iso_is_utc_with_milliseconds() -> None:
    assert iso(NOW) == "2026-10-11T14:00:00.123Z"


# ---------------------------------------------------------------- tournament job (S5 5.3; WP-17)


def test_tournament_job_function_wrappers_pass_their_arguments() -> None:
    planned = uuid4()
    arena, script = db(
        [
            ("arena.start_trial", j({"status": "running"})),
            ("arena.retry_trial", [(str(TRIAL),)]),
            ("arena.advance_replay", j({"turn_no": 2})),
            ("arena.work_item_results", [(json.dumps([{"kind": "release"}]),)]),
            ("ops.admit_unit", j({"decision": "admit"})),
        ]
    )
    assert run(arena.start_trial(TRIAL)) == {"status": "running"}
    assert run(arena.retry_trial(planned)) == TRIAL
    assert run(arena.advance_replay(TRIAL, uuid4())) == {"turn_no": 2}
    assert run(arena.work_item_results(TRIAL)) == [{"kind": "release"}]
    assert run(arena.admit_unit("global", Decimal("1.50"))) == {"decision": "admit"}
    params = [p for q, p in script.executed if "set_config" not in q]
    assert params[1] == (planned,)
    assert params[4] == ("global", Decimal("1.50"))


def test_work_item_results_is_empty_for_a_non_list_or_non_json_result() -> None:
    arena, _ = db([("arena.work_item_results", [("null",)])])
    assert run(arena.work_item_results(TRIAL)) == []


def test_tournament_trial_found_and_missing() -> None:
    variant, assistant, subject, planned = uuid4(), uuid4(), uuid4(), uuid4()
    row = (TRIAL, "interactive", "running", 3, 2, 12, False, None, variant, assistant, subject, planned, NOW)
    arena, _ = db([("arena.v_trials", [row]), ("arena.v_trials", [])])
    meta = run(arena.tournament_trial(TRIAL))
    assert meta is not None
    assert (meta["kind"], meta["assistant_candidate_id"], meta["planned_trial_id"]) == (
        "interactive",
        assistant,
        planned,
    )
    assert run(arena.tournament_trial(TRIAL)) is None


def test_tournament_split_found_and_missing() -> None:
    arena, _ = db([("from arena.v_tournaments", [("hidden",)]), ("from arena.v_tournaments", [])])
    assert run(arena.tournament_split(TRIAL)) == "hidden"
    assert run(arena.tournament_split(TRIAL)) is None


def test_released_with_titles_maps_every_row() -> None:
    arena, _ = db([("arena.v_released_evidence", [("rec-01", "Work orders", 2), ("rec-02", "Radio log", 3)])])
    assert run(arena.released_with_titles(TRIAL)) == [
        {"record_id": "rec-01", "title": "Work orders", "released_after_exchanges": 2},
        {"record_id": "rec-02", "title": "Radio log", "released_after_exchanges": 3},
    ]


def test_planned_trials_maps_the_frozen_roster_in_position_order() -> None:
    tournament, variant, a1, s1 = uuid4(), uuid4(), uuid4(), uuid4()
    planned_a, planned_b = uuid4(), uuid4()
    rows = [
        (planned_a, 1, "replay_corpus", None, variant, None, s1, False, None),
        (planned_b, 2, "replay", None, variant, a1, s1, False, planned_a),
    ]
    arena, _ = db([("arena.v_planned_trials", rows)])
    out = run(arena.planned_trials(tournament))
    assert [r["track"] for r in out] == ["replay_corpus", "replay"]
    assert out[1]["source_planned_trial_id"] == planned_a


def test_planned_trial_attempts_groups_by_planned_trial_newest_last() -> None:
    tournament = uuid4()
    planned = uuid4()
    first_attempt, second_attempt = uuid4(), uuid4()
    rows = [
        (planned, first_attempt, 1, "finalized", "infra_failed"),
        (planned, second_attempt, 2, "running", None),
    ]
    arena, _ = db([("arena.v_trials", rows)])
    out = run(arena.planned_trial_attempts(tournament))
    assert [a["trial_id"] for a in out[planned]] == [first_attempt, second_attempt]
    assert out[planned][-1]["status"] == "running"


def test_finalize_trial_sends_a_real_sql_null_for_a_corpus_transcripts_finding() -> None:
    """S2 8.6; S4 6.2 item 3: a corpus transcript's finding is null -- a real SQL NULL (`finding` itself),
    never `Jsonb(None)`, which binds the *jsonb value* `null` (`is not null` is still true for that)."""
    arena, script = db([("arena.finalize_trial", j({"commitment_sha256": "c"}))])
    run(arena.finalize_trial(TRIAL, uuid4(), None))
    assert script.executed[-1][1][-1] is None


def test_finalize_trial_wraps_a_real_finding_as_jsonb() -> None:
    arena, script = db([("arena.finalize_trial", j({"commitment_sha256": "c"}))])
    run(arena.finalize_trial(TRIAL, uuid4(), {"label": "truthful"}))
    assert isinstance(script.executed[-1][1][-1], Jsonb)


def test_submit_question_sends_no_origin_for_an_investigators_own_question() -> None:
    """`QuestionOrigin`'s default (every field `None`) is an investigator's question (SG2-09): the SQL
    function itself reads a null source that way, so the wrapper sends the default through unchanged."""
    arena, script = db([("arena.submit_question", j({"turn_no": 1, "transcript_version": 1}))])
    run(arena.submit_question(TRIAL, 0, "Why?", "k" * 10))
    params = script.executed[-1][1]
    assert (params[-3], params[-2], params[-1]) == (None, None, None)


def test_submit_question_passes_a_harness_origin_through() -> None:
    arena, script = db([("arena.submit_question", j({"turn_no": 1, "transcript_version": 1}))])
    origin = QuestionOrigin(source="assistant_relay", relay_outcome="accepted", proposal_seq=2)
    run(arena.submit_question(TRIAL, 0, "Why?", "k" * 10, origin))
    params = script.executed[-1][1]
    assert (params[-3], params[-2], params[-1]) == ("assistant_relay", "accepted", 2)


def test_tournament_status_and_leaderboard_reads() -> None:
    tournament = uuid4()
    arena, script = db(
        [
            ("arena.v_tournaments", [("revealed",)]),
            ("arena.v_tournaments", []),
            ("arena.v_leaderboards", [(json.dumps({"board": "assistant"}), "corrected", 2)]),
            ("arena.v_leaderboards", []),
        ]
    )
    assert run(arena.tournament_status(tournament)) == "revealed"
    assert run(arena.tournament_status(tournament)) is None
    found = run(arena.leaderboard(tournament, "assistant", None))
    assert found == {"body": {"board": "assistant"}, "label": "corrected", "manifest_version": 2}
    assert run(arena.leaderboard(tournament, "subject", "original")) is None
    assert script.executed[-1][1] == (tournament, "subject", "original", "original")
