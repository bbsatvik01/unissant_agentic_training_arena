"""The Coach Gym dataset SQL (`scripts/coach_gym/data.py`) as `arena_referee` against the REAL migrated database: a
dev trial is read, a hidden trial with real turns is never listed and a direct read of it is refused, so the
saved dataset holds dev examples only (D-036: the hidden split is unreachable by construction). `make db-test` runs
it with the api, admin and subject suites on the disposable Supabase container (`ARENA_IT_ADMIN_DSN`); never the
hosted project. Seeds come from fixtures.psql (families TDEV and THID, `tests.tournament`, `tests.exchange`)."""

from __future__ import annotations

import asyncio
import os
import secrets
import shutil
from collections.abc import Coroutine
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from psycopg import AsyncConnection, sql
from psycopg.conninfo import make_conninfo

from arena_core.coachgym.examples import HiddenSplitError, read_jsonl
from arena_core.db.pool import Connector, dsn_connector
from scripts.coach_gym import data, gym
from tools import proc
from tools.tests.conftest import REPO_ROOT

TESTS_DIR = REPO_ROOT / "supabase" / "tests"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _admin(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
    async with await AsyncConnection.connect(dsn) as conn:
        cur = await conn.execute(query, params)
        rows = list(await cur.fetchall()) if cur.description else []
        await conn.commit()
        return rows


def _trial_with_turns(admin: str, split: str) -> UUID:
    """An interactive trial on TDEV (dev) or THID (hidden), started, with two answered exchanges."""
    tour = run(_admin(admin, "select tests.tournament(%s, array['interactive'])", (split,)))[0][0]
    trial = run(_admin(admin, "select tests.trial(%s, 3)", (tour,)))[0][0]
    run(_admin(admin, "select arena.start_trial(%s)", (trial,)))
    run(_admin(admin, "select tests.exchange(%s, 'Why did you enter room 4?', '{}', 'A busy shift.')", (trial,)))
    run(_admin(admin, "select tests.exchange(%s, 'Which task needed entry?', '{}', 'I do not recall.')", (trial,)))
    return UUID(str(trial))


@pytest.fixture(scope="module")
def referee() -> tuple[Connector, str, UUID, UUID]:
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
    dev_trial = _trial_with_turns(admin, "dev")
    hidden_trial = _trial_with_turns(admin, "hidden")
    password = secrets.token_hex(24)
    stmt = sql.SQL("alter role {} login password {}").format(sql.Identifier("arena_referee"), sql.Literal(password))

    async def login() -> None:
        async with await AsyncConnection.connect(admin) as conn:
            await conn.execute(stmt)
            await conn.commit()

    run(login())
    connect = dsn_connector(make_conninfo(admin, user="arena_referee", password=password))
    return connect, admin, dev_trial, hidden_trial


def test_the_hidden_trial_is_real_and_has_turns(referee: tuple[Connector, str, UUID, UUID]) -> None:
    _, admin, dev_trial, hidden_trial = referee
    rows = run(
        _admin(
            admin,
            "select t.id, f.split,"
            " (select count(*) from arena.turns u where u.trial_id = t.id and u.answer is not null)"
            " from arena.trials t join arena.case_variants v on v.id = t.variant_id"
            " join arena.case_families f on f.id = v.family_id where t.id = any(%s) order by f.split",
            ([dev_trial, hidden_trial],),
        )
    )
    assert [(r[1], r[2]) for r in rows] == [("dev", 2), ("hidden", 2)]


def test_the_dev_trial_is_read_and_the_hidden_trial_is_refused(referee: tuple[Connector, str, UUID, UUID]) -> None:
    connect, _, dev_trial, hidden_trial = referee
    listed = run(data.dev_trial_ids(connect))
    assert str(dev_trial) in listed
    assert str(hidden_trial) not in listed
    record = run(data.fetch_trial(connect, str(dev_trial)))
    assert (record.split, record.family_code) == ("dev", "TDEV")
    assert [t["answer"] for t in record.transcript] == ["A busy shift.", "I do not recall."]
    assert record.role in ("truthful", "deceptive")
    with pytest.raises(HiddenSplitError):
        run(data.fetch_trial(connect, str(hidden_trial)))


def test_the_saved_dataset_holds_dev_examples_only(referee: tuple[Connector, str, UUID, UUID], tmp_path: Path) -> None:
    connect, _, dev_trial, hidden_trial = referee
    root = tmp_path / "repo"
    (root / "coachlab").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "coachlab" / "holdout.json", root / "coachlab" / "holdout.json")
    meta = run(gym.build_dataset(connect, root))
    examples = read_jsonl(root / meta["path"])
    trials = {e.trial_id for e in examples}
    assert str(dev_trial) in trials
    assert str(hidden_trial) not in trials
    assert {e.split for e in examples} == {"dev"}
    hidden_case = run(
        _admin(
            os.environ["ARENA_IT_ADMIN_DSN"],
            "select p.packet ->> 'case_id' from arena.trials t"
            " join sealed.hidden_public_packets p on p.variant_id = t.variant_id where t.id = %s",
            (hidden_trial,),
        )
    )
    assert hidden_case
    assert all(e.case_id != hidden_case[0][0] for e in examples)
