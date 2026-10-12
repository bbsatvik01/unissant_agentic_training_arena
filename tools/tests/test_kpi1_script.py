"""`scripts/kpi1.py` (S3 6.1, S4 training tables, S8 WP-30) offline and against a scripted connection: the case sets
read from the committed families, the counterbalance, the plan, the setup transaction's decisions and the report's
arithmetic. The real grants and constraints run in db-test (`packages/core/tests/db/it_kpi1.py`)."""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import psycopg
import pytest

from arena_core.db.pool import Connector
from arena_core.identity import user_id_for
from scripts import kpi1

A, B = "a@example.test", "b@example.test"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class _Conn:
    """Answers each statement by the first `routes` key its text contains; records every statement."""

    def __init__(self, routes: dict[str, list[tuple[Any, ...]]], fail_on: str | None = None) -> None:
        self.routes = routes
        self.fail_on = fail_on
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executed.append((query, params))
        if self.fail_on and self.fail_on in query:
            raise psycopg.errors.ForeignKeyViolation("fk")
        for key, rows in self.routes.items():
            if key in query:
                return _Cursor(rows)
        return _Cursor([])

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        yield

    def inserts(self, table: str) -> list[tuple[Any, ...]]:
        return [p for q, p in self.executed if q.startswith(f"insert into {table}")]


def connector(conn: _Conn) -> Connector:
    @asynccontextmanager
    async def connect() -> AsyncIterator[Any]:
        yield conn

    return cast("Connector", connect)


MEMBERS = kpi1.case_sets()
VARIANTS = {m.case_id: uuid4() for m in MEMBERS}
VARIANT_ROWS = [(m.family_code, m.case_id, VARIANTS[m.case_id]) for m in MEMBERS]


# ---------------------------------------------------------------- the sets


def test_case_sets_are_the_readme_sets() -> None:
    got = [(m.set_code, m.family_code, m.role, m.case_id) for m in MEMBERS]
    assert got == [
        ("A", "F06", "truthful", "C-6WQ3HD9P"),
        ("A", "F07", "deceptive", "C-M7XH3R5P"),
        ("B", "F08", "truthful", "C-4VQ8N2HJ"),
        ("B", "F09", "deceptive", "C-9HM3XQ6V"),
    ]
    assert kpi1.KPI1_FAMILIES == ("F06", "F07", "F08", "F09")


def _copy(tmp_path: Path) -> Path:
    dev = tmp_path / "dev"
    dev.mkdir()
    for f in kpi1.KPI1_FAMILIES:
        shutil.copy(kpi1.DEV_DIR / f"{f}.json", dev / f"{f}.json")
    return dev


def _edit(dev: Path, family: str, key: str, value: object) -> None:
    path = dev / f"{family}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data[key] = value
    path.write_text(json.dumps(data), encoding="utf-8")


def test_case_sets_refuses_a_family_off_level_two(tmp_path: Path) -> None:
    dev = _copy(tmp_path)
    _edit(dev, "F08", "difficulty", {"level": 3})
    with pytest.raises(kpi1.StudyError, match="F08: KPI-1 sets use level 2"):
        kpi1.case_sets(dev)


def test_case_sets_refuses_two_domains(tmp_path: Path) -> None:
    dev = _copy(tmp_path)
    _edit(dev, "F09", "domain", "records_handling")
    with pytest.raises(kpi1.StudyError, match="more than one domain"):
        kpi1.case_sets(dev)


def test_case_sets_refuses_a_missing_variant(tmp_path: Path) -> None:
    dev = _copy(tmp_path)
    _edit(dev, "F07", "variants", {})
    with pytest.raises(kpi1.StudyError, match="F07: no deceptive variant"):
        kpi1.case_sets(dev)


def test_case_sets_refuses_an_unreadable_or_non_object_family(tmp_path: Path) -> None:
    dev = _copy(tmp_path)
    (dev / "F06.json").write_text("[]", encoding="utf-8")
    with pytest.raises(kpi1.StudyError, match="one JSON object"):
        kpi1.case_sets(dev)
    (dev / "F06.json").unlink()
    with pytest.raises(kpi1.StudyError, match="cannot read"):
        kpi1.case_sets(dev)


def test_a_set_must_be_one_truthful_and_one_deceptive_from_different_families(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(kpi1.SETS, "A", (("F06", "truthful"), ("F07", "truthful")))
    with pytest.raises(kpi1.StudyError, match="set A must be"):
        kpi1.case_sets()
    monkeypatch.setitem(kpi1.SETS, "A", (("F06", "truthful"), ("F06", "deceptive")))
    with pytest.raises(kpi1.StudyError, match="set A must be"):
        kpi1.case_sets()


# ---------------------------------------------------------------- emails, counterbalance, plan


def test_parse_emails_lowercases_dedups_and_refuses_junk() -> None:
    assert kpi1.parse_emails(" B@Example.test, a@example.test ,b@example.test,") == [A, B]
    for bad in ("", " , ", "not-an-email"):
        with pytest.raises(kpi1.StudyError):
            kpi1.parse_emails(bad)


def test_two_new_participants_get_one_ab_and_one_ba_and_consecutive_codes() -> None:
    got = kpi1.assign([A, B], {}, 7)
    assert sorted(p.counterbalance for p in got) == ["AB", "BA"]
    assert sorted(p.code for p in got) == ["P01", "P02"]
    assert all(p.new for p in got)
    assert [p.user_id for p in got] == [user_id_for(A), user_id_for(B)]


def test_the_order_is_seeded() -> None:
    def ab_of(seed: int) -> str:
        return next(p.email for p in kpi1.assign([A, B], {}, seed) if p.counterbalance == "AB")

    assert ab_of(1) == ab_of(1)
    assert {ab_of(s) for s in range(20)} == {A, B}  # both orders occur across seeds


def test_existing_participants_are_kept_and_balance_and_codes_continue() -> None:
    existing = {user_id_for(A): ("P01", "AB"), uuid4(): ("P07", "AB")}
    got = {p.email: p for p in kpi1.assign([A, B], existing, 3)}
    assert (got[A].code, got[A].counterbalance, got[A].new) == ("P01", "AB", False)
    assert (got[B].code, got[B].counterbalance, got[B].new) == ("P08", "BA", True)


def test_plan_names_each_participant_their_sets_and_order() -> None:
    parts = [
        kpi1.Participant(B, user_id_for(B), "P02", "BA", new=False),
        kpi1.Participant(A, user_id_for(A), "P01", "AB", new=True),
    ]
    text = kpi1.plan_text(parts, MEMBERS)
    assert "Set A: C-6WQ3HD9P (F06 truthful), C-M7XH3R5P (F07 deceptive)" in text
    assert "Set B: C-4VQ8N2HJ (F08 truthful), C-9HM3XQ6V (F09 deceptive)" in text
    assert text.index("P01") < text.index("P02")
    p01, p02 = text.split("P02")
    for part, wanted in (
        (p01, ("pre-test, set A", "post-test, set B", "(new)")),
        (p02, ("pre-test, set B", "post-test, set A", "already a participant")),
    ):
        for text_piece in wanted:
            assert text_piece in part


# ---------------------------------------------------------------- setup against a scripted connection


def _setup(conn: _Conn, emails: list[str] | None = None) -> list[kpi1.Participant]:
    return run(kpi1.setup(connector(conn), emails=emails or [A, B], members=MEMBERS, seed=1))


def test_setup_writes_both_sets_and_both_participants_when_none_exist() -> None:
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS})
    got = _setup(conn)
    assert conn.executed[0][0].startswith("select pg_advisory_xact_lock")
    assert sorted(conn.inserts("training.case_set_members"), key=str) == sorted(
        [(m.set_code, VARIANTS[m.case_id]) for m in MEMBERS], key=str
    )
    rows = conn.inserts("training.participants")
    assert sorted((r[0], r[1]) for r in rows) == sorted((p.user_id, p.code) for p in got)
    assert sorted(r[2] for r in rows) == ["AB", "BA"]


def test_setup_confirms_existing_identical_sets_and_writes_none() -> None:
    sets = [(m.set_code, VARIANTS[m.case_id]) for m in MEMBERS]
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS, "from training.case_set_members": sets})
    _setup(conn)
    assert conn.inserts("training.case_set_members") == []
    assert len(conn.inserts("training.participants")) == len([A, B])


def test_setup_refuses_different_existing_sets() -> None:
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS, "from training.case_set_members": [("A", uuid4())]})
    with pytest.raises(kpi1.StudyError, match="already holds different members"):
        _setup(conn)
    assert conn.inserts("training.participants") == []


def test_setup_refuses_when_the_families_are_not_ingested() -> None:
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS[:3]})
    with pytest.raises(kpi1.StudyError, match=r"not ingested: \['C-9HM3XQ6V'\]; run make seed-hosted"):
        _setup(conn)
    assert conn.inserts("training.case_set_members") == []


def test_setup_refuses_a_user_who_already_saw_a_kpi1_family() -> None:
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS, "from training.sessions s": [(user_id_for(B), "F08")]})
    with pytest.raises(kpi1.StudyError, match=r"b@example.test \(F08\)"):
        _setup(conn)
    assert conn.inserts("training.participants") == []
    exposure = next(p for q, p in conn.executed if "from training.sessions s" in q)
    assert sorted(exposure[0]) == sorted([user_id_for(A), user_id_for(B)])
    assert exposure[1] == ["F06", "F07", "F08", "F09"]


def test_setup_checks_exposure_for_new_participants_only() -> None:
    existing = [(user_id_for(A), "P01", "AB")]
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS, "from training.participants": existing})
    got = {p.email: p for p in _setup(conn)}
    exposure = next(p for q, p in conn.executed if "from training.sessions s" in q)
    assert exposure[0] == [user_id_for(B)]
    assert (got[A].new, got[B].counterbalance) == (False, "BA")
    assert [r[0] for r in conn.inserts("training.participants")] == [user_id_for(B)]


def test_setup_names_the_email_that_is_not_allowlisted() -> None:
    conn = _Conn({"from arena.case_variants v": VARIANT_ROWS}, fail_on="insert into training.participants")
    with pytest.raises(kpi1.StudyError, match="is not allowlisted; run make seed-hosted EMAIL="):
        _setup(conn)


# ---------------------------------------------------------------- report


P1, P2 = uuid4(), uuid4()
SEED = 5


def _session(pid: UUID, phase: str, set_code: str | None, ended: bool = True, counts: bool = False) -> tuple[Any, ...]:
    return (pid, uuid4(), phase, set_code, ended, counts)


def _report(sessions: list[tuple[Any, ...]], scores: dict[UUID, int]) -> dict[str, Any]:
    conn = _Conn(
        {
            "from training.participants": [(P1, "P01", "AB"), (P2, "P02", "BA")],
            "from training.sessions s join arena.trials": sessions,
            "from training.rubric_scores": list(scores.items()),
        }
    )
    out = run(kpi1.report(connector(conn), scorer="proxy", seed=SEED))
    assert next(p for q, p in conn.executed if "rubric_scores" in q) == ("proxy",)
    return out


def _protocol(
    pid: UUID, pre_set: str, post_set: str, pre: list[int], post: list[int]
) -> tuple[list[Any], dict[UUID, int]]:
    rows = [_session(pid, "pre", pre_set) for _ in pre]
    rows += [_session(pid, "practice", None, counts=True) for _ in range(3)]
    rows += [_session(pid, "post", post_set) for _ in post]
    tests = [r for r in rows if r[2] != "practice"]
    return rows, {r[1]: s for r, s in zip(tests, pre + post, strict=True)}


def test_report_is_not_measured_with_no_completed_participant() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 50], [])
    out = _report(rows, scores)
    assert out["kpi1"] == "KPI-1 not measured"
    assert (out["n_participants"], out["n_completed"]) == (2, 0)
    p1 = out["participants"][0]
    assert (p1["completed"], p1["pre_scores"], p1["practice_sessions"]) == (False, [40, 50], 3)
    assert "not a causal claim" in out["statement"]


def test_report_computes_kpi1_over_completed_participants_only() -> None:
    r1, s1 = _protocol(P1, "A", "B", [40, 60], [60, 60])  # pre 50 -> post 60: +20%
    r2, s2 = _protocol(P2, "B", "A", [50, 50], [55, 45])  # pre 50 -> post 50: 0%
    out = _report(r1 + r2, {**s1, **s2})
    k = out["kpi1"]
    assert (k["mean_rel"], k["mean_abs"], k["share_ge_20pct"], k["ratio_of_means"]) == (0.1, 5.0, 0.5, 0.1)
    assert k["met"] is False
    assert k["bootstrap_seed"] == SEED
    assert out["set_effect"] == {"A": 50.0, "B": 55.0}
    assert out["n_completed"] == len([P1, P2])
    blob = json.dumps(out)
    assert "@" not in blob  # blinded: codes only
    assert str(P1) not in blob


def test_report_counts_unscorable_tests_and_excludes_unqualified_practice() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, 60])
    unscored = next(r for r in rows if r[2] == "post")
    del scores[unscored[1]]
    rows = [r if r[2] != "practice" else (*r[:5], False) for r in rows]
    out = _report(rows, scores)
    p1 = out["participants"][0]
    assert (p1["unscorable_tests"], p1["practice_sessions"], p1["completed"]) == (1, 0, False)
    assert out["kpi1"] == "KPI-1 not measured"


# ---------------------------------------------------------------- CLI


def test_main_refuses_without_a_dsn(capsys: pytest.CaptureFixture[str]) -> None:
    assert kpi1.main(["report"], env={}) == 1
    assert "ARENA_REFEREE_DSN is not set" in capsys.readouterr().err


def test_main_setup_prints_the_plan(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    seen: dict[str, Any] = {}

    async def fake_setup(_connect: Connector, **kw: object) -> list[kpi1.Participant]:
        seen.update(kw)
        return [kpi1.Participant(A, user_id_for(A), "P01", "AB", new=True)]

    monkeypatch.setattr(kpi1, "setup", fake_setup)
    assert kpi1.main(["setup", "--emails", f"{B},{A}"], env={"ARENA_REFEREE_DSN": "postgresql://x"}) == 0
    assert seen["emails"] == [A, B]
    assert seen["seed"] == kpi1.DEFAULT_SEED
    assert "P01  a@example.test" in capsys.readouterr().out


def test_main_report_prints_json(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    async def fake_report(_connect: Connector, **kw: object) -> dict[str, Any]:
        return {"kpi1": kpi1.NOT_MEASURED, **kw}

    monkeypatch.setattr(kpi1, "report", fake_report)
    assert kpi1.main(["report", "--scorer", "human"], env={"ARENA_REFEREE_DSN": "postgresql://x"}) == 0
    assert json.loads(capsys.readouterr().out) == {"kpi1": kpi1.NOT_MEASURED, "scorer": "human", "seed": 20261024}


def test_main_reports_a_study_error_and_withholds_a_database_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    env = {"ARENA_REFEREE_DSN": "postgresql://u:secret@h/db"}
    assert kpi1.main(["setup", "--emails", "junk"], env=env) == 1
    assert "comma-separated" in capsys.readouterr().err

    async def boom(_connect: Connector, **_kw: object) -> dict[str, Any]:
        msg = "could not connect: postgresql://u:secret@h/db"
        raise psycopg.OperationalError(msg)

    monkeypatch.setattr(kpi1, "report", boom)
    assert kpi1.main(["report"], env=env) == 1
    err = capsys.readouterr().err
    assert "OperationalError" in err
    assert "secret" not in err
