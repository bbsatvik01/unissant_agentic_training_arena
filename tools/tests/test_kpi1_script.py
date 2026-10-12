"""`scripts/kpi1.py` (S3 6.1, S4 training tables, S8 WP-30) offline and against a scripted connection: the case sets
read from the committed families, the counterbalance, the plan, the setup transaction's decisions and the report's
arithmetic. The real grants and constraints run in db-test (`packages/core/tests/db/it_kpi1.py`)."""

from __future__ import annotations

import asyncio
import json
import os
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
from arena_core.scoring.exact import DIMENSIONS
from arena_core.scoring.rubric import MIN_QUESTIONS
from scripts import kpi1
from tools import proc
from tools.tests.conftest import REPO_ROOT

A, B = "a@example.test", "b@example.test"


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows
        self.rowcount = 1

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
SHORT_SCORE = 90


def _session(
    pid: UUID, phase: str, set_code: str | None, *, counts: bool = False, published: bool = True
) -> tuple[Any, ...]:
    """A report row: participant, session, phase, set, ended (always, here), qualifying practice, debrief published,
    investigator questions (three: scorable)."""
    return (pid, uuid4(), phase, set_code, True, counts, published, 3)


def _report(sessions: list[tuple[Any, ...]], scores: dict[UUID, int], scorer: str = "proxy") -> dict[str, Any]:
    conn = _Conn(
        {
            "from training.participants": [(P1, "P01", "AB"), (P2, "P02", "BA")],
            "from training.sessions s join arena.trials": sessions,
            "from training.rubric_scores": list(scores.items()),
        }
    )
    out = run(kpi1.report(connector(conn), scorer=scorer, seed=SEED))
    assert next(p for q, p in conn.executed if "rubric_scores" in q) == (scorer,)
    sessions_query = next(q for q, _ in conn.executed if "from training.sessions s join arena.trials" in q)
    assert "u.question_source = 'investigator'  and u.answer is not null" in sessions_query
    return out


def _protocol(
    pid: UUID, pre_set: str, post_set: str, pre: list[int], post: list[int]
) -> tuple[list[Any], dict[UUID, int]]:
    rows = [_session(pid, "pre", pre_set) for _ in pre]
    rows += [_session(pid, "practice", None, counts=True) for _ in range(3)]
    rows += [_session(pid, "post", post_set) for _ in post]
    tests = [r for r in rows if r[2] != "practice"]
    return rows, {r[1]: s for r, s in zip(tests, pre + post, strict=True)}


def _unscore(rows: list[Any], scores: dict[UUID, int], *, published: bool) -> list[Any]:
    """Drop the first post-test's score; its debrief published (unscorable) or not (pending)."""
    target = next(r for r in rows if r[2] == "post")
    del scores[target[1]]
    return [(*r[:6], published, r[7]) if r is target else r for r in rows]


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
    got = (k["mean_rel"], k["median_rel"], k["mean_abs"], k["share_ge_20pct"], k["ratio_of_means"])
    assert got == (0.1, 0.1, 5.0, 0.5, 0.1)
    assert set(k["ci"]) == {"mean_rel", "median_rel", "share_ge_20pct", "mean_abs", "ratio_of_means"}
    lo, hi = k["ci"]["mean_abs"]
    assert lo <= k["mean_abs"] <= hi
    assert k["ci"]["mean_rel"] == [0.0, 0.2]  # two participants, r = 0.2 and 0: every resample mean is in [0, 0.2]
    assert k["met"] is False
    assert k["bootstrap_seed"] == SEED
    assert out["set_effect"] == {"A": 50.0, "B": 55.0}
    assert out["n_completed"] == len([P1, P2])
    blob = json.dumps(out)
    assert "@" not in blob  # blinded: codes only
    assert str(P1) not in blob


def test_an_unscorable_test_is_left_out_and_the_estimate_still_prints() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, 60])
    rows = _unscore(rows, scores, published=True)
    out = _report(rows, scores)
    p1 = out["participants"][0]
    assert (p1["unscorable_tests"], p1["pending_tests"], p1["post_scores"]) == (1, 0, [60])
    assert (out["kpi1"]["mean_rel"], out["kpi1"]["met"]) == (0.2, True)


def test_a_pending_test_withholds_the_estimate() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, 60])
    rows = _unscore(rows, scores, published=False)
    out = _report(rows, scores)
    p1 = out["participants"][0]
    assert (p1["unscorable_tests"], p1["pending_tests"], p1["completed"]) == (0, 1, True)
    assert out["kpi1"] == f"{kpi1.PENDING}: P01"


def test_for_human_scores_a_missing_rating_is_pending_even_after_the_debrief() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, 60])
    rows = _unscore(rows, scores, published=True)
    out = _report(rows, scores, scorer="human")
    assert out["participants"][0]["pending_tests"] == 1
    assert out["kpi1"].startswith(kpi1.PENDING)


@pytest.mark.parametrize("scorer", ["proxy", "human"])
def test_a_test_below_three_questions_is_unscorable_for_either_scorer_and_its_score_is_ignored(scorer: str) -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, SHORT_SCORE])
    short = next(r for r in rows if r[2] == "post" and scores[r[1]] == SHORT_SCORE)
    rows = [(*r[:7], 2) if r is short else r for r in rows]  # a score row for it, if any, never counts
    out = _report(rows, scores, scorer=scorer)
    p1 = out["participants"][0]
    assert (p1["unscorable_tests"], p1["pending_tests"], p1["post_scores"]) == (1, 0, [60])
    assert (out["kpi1"]["mean_rel"], out["kpi1"]["met"]) == (0.2, True)


def test_unqualified_practice_leaves_the_protocol_incomplete() -> None:
    rows, scores = _protocol(P1, "A", "B", [40, 60], [60, 60])
    rows = [r if r[2] != "practice" else (*r[:5], False, *r[6:]) for r in rows]
    out = _report(rows, scores)
    p1 = out["participants"][0]
    assert (p1["practice_sessions"], p1["completed"]) == (0, False)
    assert out["kpi1"] == "KPI-1 not measured"


# ---------------------------------------------------------------- blinded human rating


S1, S2 = uuid4(), uuid4()
T1, T2 = uuid4(), uuid4()
FINDING = {"label": "insufficient_evidence", "rationale": "Not yet tested."}
PACKET = {
    "title": "Title one",
    "case_id": "C-6WQ3HD9P",
    "investigation_objective": "Find out why the door opened.",
    "initial_documents": [{"doc_id": "doc-01", "title": "Log", "content": "..."}],
}


def _export_conn() -> _Conn:
    return _Conn(
        {
            "p.packet, f.finding": [(S1, PACKET, FINDING, T1), (S2, {**PACKET, "title": "Title two"}, None, T2)],
            "from arena.turns where": [(T1, 1, "q1", "a1"), (T1, 2, "q2", "a2"), (T2, 1, "q3", "a3")],
            "from arena.released_evidence": [(T1, "rec-01", 2, "Badge log", {"body": "x"})],
        }
    )


def test_blind_items_carry_the_public_context_strip_identity_and_shuffle(tmp_path: Path) -> None:
    conn = _export_conn()
    items, key = run(kpi1.blind_items(connector(conn)))
    first_query, first_params = conn.executed[0]
    assert "u.question_source = 'investigator' and u.answer is not null) >= %s" in first_query
    turns_query = next(q for q, _ in conn.executed if "from arena.turns where" in q)
    assert "and answer is not null" in turns_query  # committed exchanges only, as R3 reads them
    assert first_params == (MIN_QUESTIONS,)  # only scorable sessions (S3 2.2) are exported
    assert sorted(key.values()) == sorted([str(S1), str(S2)])
    assert [i["blind_id"] for i in items] == sorted(key)
    one = next(i for i in items if key[i["blind_id"]] == str(S1))
    assert one["transcript"] == [
        {"turn": 1, "question": "q1", "answer": "a1"},
        {"turn": 2, "question": "q2", "answer": "a2"},
    ]
    assert one["released_records"] == [
        {"record_id": "rec-01", "released_after_exchange": 2, "title": "Badge log", "content": {"body": "x"}}
    ]
    assert (one["objective"], one["initial_documents"], one["finding"]) == (
        PACKET["investigation_objective"],
        PACKET["initial_documents"],
        FINDING,
    )
    two = next(i for i in items if key[i["blind_id"]] == str(S2))
    assert two["released_records"] == []
    assert set(one) == {
        "blind_id",
        "case_title",
        "case_id",
        "objective",
        "initial_documents",
        "transcript",
        "released_records",
        "finding",
    }  # no participant code, phase or time
    assert str(S1) not in json.dumps(items)
    kpi1.write_export(tmp_path / "x", items, key)
    sheet = json.loads((tmp_path / "x" / "items.json").read_text(encoding="utf-8"))["rubric"]
    assert [c["id"] for d in sheet["dimensions"] for c in d["checks"]] == list(kpi1.CHECK_IDS)
    assert len(kpi1.CHECK_IDS) == RUBRIC_CHECKS
    rows = sheet["confidence_ceiling_5d"]["rows"]
    assert {"label": "deceptive", "likelihood": "almost_certain", "min_s": 2, "needs_cited_record": True} in rows
    assert "floor(4 x passed / applicable + 1/2)" in sheet["how_to_rate"]
    blank = json.loads((tmp_path / "x" / "ratings.json").read_text(encoding="utf-8"))
    assert [r["blind_id"] for r in blank["ratings"]] == sorted(key)
    assert set(blank["ratings"][0]["checks"]) == set(kpi1.CHECK_IDS)
    assert json.loads((tmp_path / "x" / "key.json").read_text(encoding="utf-8")) == key
    with pytest.raises(kpi1.StudyError, match="exists"):
        kpi1.write_export(tmp_path / "x", items, key)


RUBRIC_CHECKS = 22  # rubric.v1 (S3 2.3-2.7)


def test_blind_items_refuses_when_no_test_ended() -> None:
    with pytest.raises(kpi1.StudyError, match="no ended, scorable test session"):
        run(kpi1.blind_items(connector(_Conn({}))))


def _verdicts(fail: frozenset[str] = frozenset(), na: frozenset[str] = frozenset()) -> dict[str, str]:
    return {c: "fail" if c in fail else "na" if c in na else "pass" for c in kpi1.CHECK_IDS}


def _rating(blind: str, checks: object = None) -> dict[str, object]:
    return {"blind_id": blind, "checks": _verdicts() if checks is None else checks, "notes": ""}


def test_parse_ratings_scores_dimensions_from_the_check_verdicts() -> None:
    key = {"b1": str(S1), "b2": str(S2)}
    # D1 is 1a-1d (four always-applicable checks): one fail -> floor(4 x 3/4 + 1/2) = 3. D5: 5e na (its label
    # rule) and 5d fail -> 3 of 4 applicable -> 3.
    mixed = _verdicts(fail=frozenset({"1a", "5d"}), na=frozenset({"5e"}))
    got = kpi1.parse_ratings({"rater": "R02", "ratings": [_rating("b1"), _rating("b2", mixed)]}, key)
    assert [(g.session_id, g.rater) for g in got] == [(S1, "R02"), (S2, "R02")]
    assert got[0].dimensions == dict.fromkeys(DIMENSIONS, 4)
    assert (got[1].dimensions["D1"], got[1].dimensions["D5"]) == (3, 3)
    assert (got[1].checks["1a"], got[1].checks["5e"], got[1].checks["1b"]) == (False, None, True)


@pytest.mark.parametrize(
    ("ratings", "match"),
    [
        ({"rater": "Alice", "ratings": [_rating("b1")]}, "rater is a code"),
        ({"rater": "R01", "ratings": [_rating("zz")]}, "unknown blind_id"),
        ({"rater": "R01", "ratings": [_rating("b1", {**_verdicts(), "1a": None})]}, "checks.1a: pass, fail or na"),
        ({"rater": "R01", "ratings": [_rating("b1", {**_verdicts(), "1a": "na"})]}, "always applicable"),
        ({"rater": "R01", "ratings": [_rating("b1", {"1a": "pass"})]}, "exactly the 22"),
        ({"rater": "R01", "ratings": []}, "no ratings"),
        ([], "JSON objects"),
    ],
)
def test_parse_ratings_refuses_bad_input(ratings: object, match: str) -> None:
    with pytest.raises(kpi1.StudyError, match=match):
        kpi1.parse_ratings(ratings, {"b1": str(S1)})


class _CountingConn(_Conn):
    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> _Cursor:
        cur = await super().execute(query, params)
        cur.rowcount = 0 if len(self.executed) > 1 else 1
        return cur


def test_import_human_inserts_scorer_human_rows_idempotently() -> None:
    conn = _CountingConn({})
    key = {"b1": str(S1), "b2": str(S2)}
    mixed = _verdicts(fail=frozenset({"1a"}), na=frozenset({"5e"}))
    ratings = kpi1.parse_ratings({"rater": "R01", "ratings": [_rating("b1", mixed), _rating("b2")]}, key)
    assert run(kpi1.import_human(connector(conn), ratings)) == 1
    query, params = conn.executed[0]
    assert "'human'" in query
    assert "on conflict (session_id, scorer, scorer_ref) do nothing" in query
    assert params[:7] == (S1, "R01", 3, 4, 4, 4, 4)
    rationale = params[7].obj
    assert (rationale["checks"]["1a"], rationale["checks"]["5e"]) == ({"result": False}, {"result": None})


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


def test_make_kpi1_report_stdout_is_the_json_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The runbook's `make kpi1-report > kpi1-results.json` must write parseable JSON: make echoes no recipe line."""
    stub = tmp_path / "bin" / "uv"
    stub.parent.mkdir()
    stub.write_text('#!/bin/sh\necho \'{"kpi1": "stub"}\'\n', encoding="utf-8")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{stub.parent}:{os.environ['PATH']}")
    monkeypatch.setenv("ARENA_REFEREE_DSN", "postgresql://stub")
    result = proc.run("make", ["--no-print-directory", "-f", str(REPO_ROOT / "Makefile"), "kpi1-report"], cwd=REPO_ROOT)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"kpi1": "stub"}


def test_main_export_then_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    env = {"ARENA_REFEREE_DSN": "postgresql://x"}

    async def fake_items(_connect: Connector) -> tuple[list[dict[str, Any]], dict[str, str]]:
        return [{"blind_id": "b1"}], {"b1": str(S1)}

    monkeypatch.setattr(kpi1, "blind_items", fake_items)
    out = tmp_path / "blind"
    assert kpi1.main(["export-blind", "--out", str(out)], env=env) == 0
    assert "1 blinded items" in capsys.readouterr().out
    sheet = json.loads((out / "ratings.json").read_text(encoding="utf-8"))
    sheet["ratings"][0]["checks"] = _verdicts()
    (out / "ratings.json").write_text(json.dumps(sheet), encoding="utf-8")
    stored: list[Any] = []

    async def fake_import(_connect: Connector, ratings: list[Any]) -> int:
        stored.extend(ratings)
        return 1

    monkeypatch.setattr(kpi1, "import_human", fake_import)
    args = ["import-human", "--ratings", str(out / "ratings.json"), "--key", str(out / "key.json")]
    assert kpi1.main(args, env=env) == 0
    assert [(r.session_id, r.rater, r.dimensions["D3"]) for r in stored] == [(S1, "R01", 4)]
    assert "1 human scores stored (0 already present)" in capsys.readouterr().out
    assert (
        kpi1.main(["import-human", "--ratings", str(out / "missing.json"), "--key", str(out / "key.json")], env=env)
        == 1
    )
    assert "cannot read" in capsys.readouterr().err
