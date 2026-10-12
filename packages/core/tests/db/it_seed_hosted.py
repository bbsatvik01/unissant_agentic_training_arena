"""`scripts/seed_hosted.py` against the REAL migrated S4 functions (S1 10.5, S2 3.1, S4 2.3): `make db-test`
runs it on the disposable Supabase Postgres container it has just migrated (`supabase/tests/harness/db_test.sh`),
with `ARENA_IT_ADMIN_DSN` naming that database's admin -- never the hosted project, never a model call. Proves
what a fake connector cannot: the nine dev families really ingest through `sealed.ingest_case_family`, the six
official candidates really register through `arena.register_candidate`, the dev user really lands in the real
`auth` schema, and running the whole script twice is a no-op the second time (idempotent re-seeding, exactly
what the coordinator will do against the hosted project if a run is interrupted partway through).

The file name does not match `test_*.py`, so `make test` (no database) never collects it; db-test names it
explicitly, same convention as `it_spend_guard.py` and `services/api/tests/it_api.py`.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Coroutine
from typing import Any
from uuid import UUID

import pytest
from psycopg import AsyncConnection

from arena_core.db.pool import dsn_connector
from arena_core.identity import user_id_for
from scripts import seed_hosted

DSN_VAR = "ARENA_IT_ADMIN_DSN"
EMAIL = "it-seed-hosted@arena.local"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


@pytest.fixture(scope="module")
def admin_dsn() -> str:
    dsn = os.environ.get(DSN_VAR, "")
    if not dsn:
        msg = f"{DSN_VAR} is not set: this suite runs inside make db-test on a freshly migrated database"
        raise RuntimeError(msg)
    return dsn


async def _rows(dsn: str, query: str, params: tuple[object, ...] = ()) -> list[tuple[Any, ...]]:
    async with await AsyncConnection.connect(dsn) as conn:
        cur = await conn.execute(query, params)
        rows = list(await cur.fetchall())
        await conn.commit()
        return rows


def _run_seed(admin_dsn: str, email: str = EMAIL) -> dict[str, Any]:
    bundles = seed_hosted.dev_bundles()
    manifests = seed_hosted.candidate_manifests()
    return run(seed_hosted.seed(dsn_connector(admin_dsn), email=email, bundles=bundles, manifests=manifests))


DEV_FAMILY_COUNT = 9


def test_seed_hosted_ingests_the_nine_dev_families_through_the_real_function(admin_dsn: str) -> None:
    result = _run_seed(admin_dsn)
    assert set(result["families"]) == {f"F0{i}" for i in range(1, 10)}
    rows = run(
        _rows(
            admin_dsn,
            "select family_code, split, id::text from arena.case_families"
            " where family_code like %s order by family_code",
            ("F0%",),
        )
    )
    assert [(code, split) for code, split, _id in rows] == [(f"F0{i}", "dev") for i in range(1, 10)]
    assert {code: family_id for code, _split, family_id in rows} == result["families"]
    # Every family ingested with a real, attested archive row (S1 10.5 SG1-19), not a test fixture's shortcut.
    archived = run(
        _rows(
            admin_dsn,
            "select count(*) from sealed.family_ingests i join arena.case_families f on f.id = i.family_id"
            " where f.family_code like %s",
            ("F0%",),
        )
    )
    assert archived[0][0] == DEV_FAMILY_COUNT


def test_seed_hosted_registers_the_official_roster_through_the_real_function(admin_dsn: str) -> None:
    result = _run_seed(admin_dsn)
    assert set(result["candidates"]) == set(seed_hosted.CANDIDATE_IDS)
    rows = run(
        _rows(
            admin_dsn,
            "select name, kind, id::text from arena.candidates where name = any(%s) order by name",
            (list(seed_hosted.CANDIDATE_IDS),),
        )
    )
    assert {name: cid for name, _kind, cid in rows} == result["candidates"]
    assert {name: kind for name, kind, _cid in rows} == {
        "A1": "assistant",
        "A2": "assistant",
        "A3": "assistant",
        "S1": "subject",
        "S2": "subject",
        "S3": "subject",
    }


def test_seed_hosted_allowlists_the_dev_user_in_the_real_auth_schema(admin_dsn: str) -> None:
    result = _run_seed(admin_dsn)
    expected_id = user_id_for(EMAIL)
    assert result["user"] == {"email": EMAIL, "user_id": str(expected_id)}
    rows = run(_rows(admin_dsn, "select id::text, email from auth.users where email = %s", (EMAIL,)))
    assert rows == [(str(expected_id), EMAIL)]


def test_seed_hosted_uppercase_email_lowers_to_the_same_allowlisted_row(admin_dsn: str) -> None:
    mixed_case = "Mixed.Case@Arena.Local"
    result = _run_seed(admin_dsn, email=mixed_case)
    assert result["user"]["email"] == mixed_case.lower()
    rows = run(_rows(admin_dsn, "select email from auth.users where id = %s", (UUID(result["user"]["user_id"]),)))
    assert rows == [(mixed_case.lower(),)]


def test_seed_hosted_is_idempotent_end_to_end(admin_dsn: str) -> None:
    """Re-running the whole script after it already seeded everything repeats no write and reports the same
    ids: the coordinator may re-run `make seed-hosted` on the hosted project without side effects."""
    first = _run_seed(admin_dsn)
    family_count_before = run(_rows(admin_dsn, "select count(*) from arena.case_families where split = 'dev'"))
    candidate_count_before = run(_rows(admin_dsn, "select count(*) from arena.candidates"))
    second = _run_seed(admin_dsn)
    assert second == first
    family_count_after = run(_rows(admin_dsn, "select count(*) from arena.case_families where split = 'dev'"))
    candidate_count_after = run(_rows(admin_dsn, "select count(*) from arena.candidates"))
    assert family_count_after == family_count_before
    assert candidate_count_after == candidate_count_before


def test_seed_hosted_main_runs_end_to_end_through_the_real_cli_entry_point(admin_dsn: str) -> None:
    """The exact entry point the coordinator runs (`python -m scripts.seed_hosted --email ...`), with
    ARENA_OWNER_DSN read from the environment mapping `main` is given -- never argv, never printed."""
    email = "cli-entry@arena.local"
    code = seed_hosted.main(["--email", email], {"ARENA_OWNER_DSN": admin_dsn})
    assert code == 0
    rows = run(_rows(admin_dsn, "select id::text from auth.users where email = %s", (email,)))
    assert rows == [(str(user_id_for(email)),)]
