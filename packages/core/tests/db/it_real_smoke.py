"""`scripts/probes/real_smoke.py` against the REAL migrated S4 functions, in `ARENA_MODEL_MODE=fake` (zero
spend, no network): `make db-test` runs it on the same disposable database `it_seed_hosted.py` just seeded
(`supabase/tests/harness/db_test.sh`, `seed_hosted_integration`), after the budget plan is applied and the two
runtime roles (`arena_public`, `arena_subject`) have a login -- the only two things a real run needs beyond
what `seed_hosted.py` already provisions. `ARENA_IT_ADMIN_DSN` names the database's admin.

The file name does not match `test_*.py`, so `make test` (no database) never collects it; db-test names it
explicitly, same convention as `it_spend_guard.py` and `it_seed_hosted.py`.
"""

from __future__ import annotations

import json
import os

import pytest

from scripts.probes import real_smoke

ADMIN_DSN_VAR = "ARENA_IT_ADMIN_DSN"
PUBLIC_DSN_VAR = "ARENA_IT_REAL_SMOKE_PUBLIC_DSN"
SUBJECT_DSN_VAR = "ARENA_IT_REAL_SMOKE_SUBJECT_DSN"
EMAIL_VAR = "ARENA_IT_REAL_SMOKE_EMAIL"
USERS_FILE_VAR = "ARENA_IT_REAL_SMOKE_USERS_FILE"


def _require(var: str) -> str:
    value = os.environ.get(var, "")
    if not value:
        msg = f"{var} is not set: this suite runs inside make db-test, after seed_hosted_integration"
        raise RuntimeError(msg)
    return value


@pytest.fixture(scope="module")
def smoke_env() -> dict[str, str]:
    _require(ADMIN_DSN_VAR)  # asserts this really is the db-test harness, not a bare pytest invocation
    return {
        "ARENA_GCP_PROJECT": "cna-guardian",
        "ARENA_MODEL_MODE": "fake",
        "ARENA_PUBLIC_DSN": _require(PUBLIC_DSN_VAR),
        "ARENA_SUBJECT_DSN": _require(SUBJECT_DSN_VAR),
        "ARENA_DEV_USER": _require(EMAIL_VAR),
        "ARENA_USERS_FILE": _require(USERS_FILE_VAR),
    }


def test_real_smoke_runs_one_subject_call_and_one_coach_card(smoke_env: dict[str, str]) -> None:
    code = real_smoke.main(["--family", "F01"], smoke_env)
    assert code == 0


def test_real_smoke_reports_exactly_one_call_of_each_kind_with_the_manifest_models(
    smoke_env: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    assert real_smoke.main(["--family", "F02", "--coach", "A2", "--subject", "S2"], smoke_env) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["outcome"] == "recorded"
    assert [c["purpose"] for c in report["subject"]] == ["subject.answer"]
    assert [c["purpose"] for c in report["coach"]] == ["coach.card"]
    assert report["subject"][0]["model"] == "gemini-3.5-flash-lite"  # S2's manifest
    assert report["coach"][0]["model"] == "gemini-3.5-flash-lite"  # A2's manifest
    assert report["subject"][0]["cost_usd"] == "0.000000"  # fake mode: zero spend
    assert report["coach"][0]["cost_usd"] == "0.000000"


def test_real_smoke_refuses_an_unregistered_family(
    smoke_env: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    assert real_smoke.main(["--family", "F99"], smoke_env) == 1
    assert "F99" in capsys.readouterr().err
