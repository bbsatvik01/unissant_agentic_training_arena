"""The admin console's SQL (`arena_referee.admin_db`) as `arena_referee` against the REAL migrated functions and
grants (S5 5.5 admin table; S4 6). `make db-test` runs it with the api and subject suites on the disposable
Supabase container (`ARENA_IT_ADMIN_DSN`); never the hosted project. Seeds come from fixtures.psql."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from collections.abc import Coroutine
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg
import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from arena_core.db.pool import Connector, dsn_connector
from arena_referee import admin_db, instructor
from tools import proc

TESTS_DIR = Path(__file__).resolve().parents[3] / "supabase" / "tests"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _admin(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
    async with await AsyncConnection.connect(dsn) as conn:
        cur = await conn.execute(query, params)
        rows = list(await cur.fetchall()) if cur.description else []
        await conn.commit()
        return rows


@pytest.fixture(scope="module")
def referee() -> tuple[Connector, str]:
    admin = os.environ.get("ARENA_IT_ADMIN_DSN", "")
    if not admin:
        msg = "ARENA_IT_ADMIN_DSN is not set: this suite runs inside make db-test"
        raise RuntimeError(msg)
    loaded = proc.run(
        "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "harness/fixtures.psql", admin], cwd=TESTS_DIR
    )
    if loaded.returncode != 0:
        msg = f"could not load fixtures.psql: {loaded.stderr.strip()}"
        raise RuntimeError(msg)
    run(_admin(admin, "select tests.family('TDEV', 'dev')"))
    password = secrets.token_hex(24)
    stmt = sql.SQL("alter role {} login password {}").format(sql.Identifier("arena_referee"), sql.Literal(password))

    async def login() -> None:
        async with await AsyncConnection.connect(admin) as conn:
            await conn.execute(stmt)
            await conn.commit()

    run(login())
    return dsn_connector(make_conninfo(admin, user="arena_referee", password=password)), admin


def test_lifecycle_reads_and_preconditions_as_the_referee(referee: tuple[Connector, str]) -> None:
    connect, admin = referee
    a1 = run(_admin(admin, "select tests.candidate('assistant', 'A1')"))[0][0]
    s1 = run(_admin(admin, "select tests.candidate('subject', 'S1')"))[0][0]
    variant = run(_admin(admin, "select tests.variant('TDEV', 'truthful')"))[0][0]
    name = f"it-admin-{secrets.token_hex(4)}"
    tid = UUID(
        str(
            run(admin_db.call(connect, "select arena.create_tournament(%s, 'dev', 7, 'global', 12::smallint)", (name,)))
        )
    )
    again = run(admin_db.call(connect, "select arena.create_tournament(%s, 'dev', 7, 'global', 12::smallint)", (name,)))
    assert UUID(str(again)) == tid  # idempotent by name
    row = {
        "position": 1,
        "track": "interactive",
        "block_no": 1,
        "variant_id": str(variant),
        "assistant_candidate_id": str(a1),
        "subject_candidate_id": str(s1),
    }
    assert run(admin_db.call(connect, "select arena.add_planned_trials(%s, %s)", (tid, Jsonb([row])))) == 1
    assert run(admin_db.roster_has(connect, tid, [row])) is True
    assert run(admin_db.roster_has(connect, tid, [{**row, "position": 2}])) is False
    assert run(admin_db.roster_has(connect, tid, [{**row, "subject_candidate_id": str(a1)}])) is False
    assert run(admin_db.roster_has(connect, tid, [{**row, "block_no": 2}])) is False
    run(admin_db.call(connect, "select arena.freeze_tournament(%s)", (tid,)))

    found = run(admin_db.tournament(connect, tid))
    assert found is not None
    assert (found["name"], found["split"], found["status"]) == (name, "dev", "frozen")
    assert tid in {UUID(t["id"]) for t in run(admin_db.tournaments(connect))}
    progress = run(admin_db.progress(connect, tid))
    assert [(p["track"], p["planned"]) for p in progress] == [("interactive", 1)]

    pre = {p["name"]: p["passed"] for p in run(admin_db.reveal_preconditions(connect, tid))}
    assert list(pre) == list(admin_db.PRECONDITION_NAMES)
    assert pre["status_scoring"] is False
    assert pre["roster_frozen"] is True
    assert pre["every_trial_recorded"] is False
    assert pre["hidden_split_seal_verifies"] is True  # a dev tournament has no hidden seal to verify

    with pytest.raises(psycopg.Error):  # a frozen tournament cannot close its run (S4 AR001)
        run(admin_db.call(connect, "select arena.close_tournament_run(%s)", (tid,)))


def test_budget_and_the_review_queue_read_as_the_referee(referee: tuple[Connector, str]) -> None:
    connect, _ = referee
    buckets = run(admin_db.budget(connect))
    assert "global" in {b["bucket"] for b in buckets}
    assert all(isinstance(b["ceiling_usd"], str) for b in buckets)
    reviews = run(admin_db.pending_reviews(connect))
    assert isinstance(reviews, list)
    assert "assistant" not in json.dumps(reviews)


def test_instructor_mode_reads_and_writes_as_the_referee(referee: tuple[Connector, str]) -> None:
    """UI v2 (D-036): the class progress, a dev case's variant, an idempotent assignment and a note on a training
    trial, through `arena_referee.instructor` against the real tables and grants."""
    connect, admin = referee
    run(_admin(admin, "select tests.users()"))
    trainee = run(_admin(admin, "select tests.uid('C')"))[0][0]
    teacher = run(_admin(admin, "select tests.uid('D')"))[0][0]
    variant = run(_admin(admin, "select tests.variant('TDEV', 'deceptive')"))[0][0]
    case_id = run(
        _admin(admin, "select packet ->> 'case_id' from arena.public_packets where variant_id = %s", (variant,))
    )
    trial = run(
        _admin(
            admin,
            "select set_config('arena.actor_id', %s, false), (training.start_session(%s, 'practice',"
            " tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, %s) ->> 'trial_id')::uuid",
            (str(trainee), variant, f"it-instructor-{secrets.token_hex(4)}"),
        )
    )[0][1]

    assert run(instructor.dev_variant(connect, case_id[0][0])) == variant
    assert run(instructor.dev_variant(connect, "C-00000000")) is None
    first = run(instructor.assign(connect, trainee, variant, teacher))
    again = run(instructor.assign(connect, trainee, variant, teacher))
    assert first == again

    progress = run(instructor.class_progress(connect, [instructor.Trainee(trainee, "Cleo")]))
    assert len(progress) == 1
    row = progress[0]
    assert (row["display_name"], row["sessions"], row["ended"], row["scored"], row["mean_score"]) == (
        "Cleo",
        1,
        0,
        0,
        None,
    )
    assert row["recent"][0]["trial_id"] == str(trial)
    assert [(a["case_id"], a["started"]) for a in row["assignments"]] == [(case_id[0][0], True)]

    assert run(instructor.training_trial(connect, trial)) is True
    assert run(instructor.training_trial(connect, UUID(int=1))) is False
    note = run(instructor.annotate(connect, trial, teacher, 1500, "Open question, well done."))
    assert (note["t_ms"], note["text"]) == (1500, "Open question, well done.")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):  # the referee only reads and appends notes
        run(admin_db.call(connect, "update training.annotations set text = 'x' where trial_id = %s", (trial,)))
