"""`arena_referee.reveal` (S3 4.4, 5.5-5.6; S4 6; WP-16) against a fake `Connector`: reveal (or a correction)
publishes exactly one leaderboard, bound to the manifest version that call just sealed."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from fractions import Fraction
from typing import Any, cast

import pytest

from arena_core.db.pool import Connector
from arena_core.referee.leaderboard import TrialScore
from arena_core.scoring.inclusion import RevealBlockedError
from arena_core.scoring.ranking import IG_ITEMS, isolation_result
from arena_referee import db, reveal

TOURNAMENT = "00000000-0000-0000-0000-0000000000a1"
MANIFEST_1 = "00000000-0000-0000-0000-0000000000b1"
MANIFEST_2 = "00000000-0000-0000-0000-0000000000b2"
CANDIDATE = "00000000-0000-0000-0000-0000000000c1"
CORRECTED_VERSION = 2

PASSING_ISOLATION = isolation_result({item: (True, f"{item}-hash") for item in IG_ITEMS})


def run[T](aw: Awaitable[T]) -> T:
    async def _runner() -> T:
        return await aw

    return asyncio.run(_runner())


class FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


@asynccontextmanager
async def _noop_tx() -> AsyncIterator[None]:
    yield


class FakeConn:
    def __init__(self, answers: dict[str, list[tuple[Any, ...]]] | None = None) -> None:
        self.answers = answers or {}
        self.executed: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, params: tuple[Any, ...] = ()) -> FakeCursor:
        self.executed.append((query, params))
        for key, rows in self.answers.items():
            if key in query:
                return FakeCursor(rows)
        return FakeCursor([])

    def transaction(self) -> AsyncIterator[None]:
        return cast("AsyncIterator[None]", _noop_tx())


def connector(conn: FakeConn) -> Connector:
    @asynccontextmanager
    async def connect() -> AsyncIterator[FakeConn]:
        yield conn

    return cast("Connector", connect)


def ctx() -> reveal.PublishContext:
    config = reveal.PublishConfig(
        scorer_git_sha="0" * 40,
        rubric_sha256="r" * 64,
        r1_prompt_sha256="p1" * 32,
        r2_prompt_sha256="p2" * 32,
        label_set_sha256="l" * 64,
    )
    return reveal.PublishContext(isolation=PASSING_ISOLATION, qq_calibrated=False, config=config)


def trial_fact_row() -> tuple[Any, ...]:
    return (
        "00000000-0000-0000-0000-0000000000d1",
        "interactive",
        CANDIDATE,
        "00000000-0000-0000-0000-0000000000d3",
        "F01",
        "truthful",
        "00000000-0000-0000-0000-0000000000d2",
        "completed",
        "valid",
        "truthful",
        "0.01",
        "00000000-0000-0000-0000-0000000000e1",
        "variant:subject:1",
    )


@pytest.fixture
def scored(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every trial has stored judgments (scoring finished), each scoring a plain `TrialScore`."""

    async def fake_fetch(_connect: object, _trial_id: str) -> object:
        return object()

    def fake_score(family_id: str, _stored: object) -> TrialScore:
        return TrialScore(family_id=family_id)

    monkeypatch.setattr(db, "fetch_stored_trial_judgments", fake_fetch)
    monkeypatch.setattr(reveal, "trial_score", fake_score)


def test_reveal_waits_for_scoring_and_never_seals_with_an_unscored_trial() -> None:
    # Codex r5 #2: a board published before R2 finished could never be repaired once the manifest is sealed.
    conn = FakeConn(
        {
            "ledger.reveal": [({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64},)],
            "ledger.seal_corrected_manifest": [
                ({"manifest_id": MANIFEST_2, "manifest_sha256": "b" * 64, "version": 2},)
            ],
            "ledger.planned_execution": [trial_fact_row()],
        }
    )
    with pytest.raises(reveal.ScoringIncompleteError):
        run(reveal.reveal_and_publish(connector(conn), TOURNAMENT, ctx()))
    with pytest.raises(reveal.ScoringIncompleteError):
        run(reveal.seal_correction_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert not any("ledger.reveal" in q or "seal_corrected_manifest" in q for q, _ in conn.executed)


@pytest.mark.usefixtures("scored")
def test_reveal_and_publish_writes_an_original_leaderboard_on_manifest_v1() -> None:
    conn = FakeConn(
        {
            "ledger.reveal": [({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64},)],
            "ledger.planned_execution": [trial_fact_row()],
        }
    )
    result = run(reveal.reveal_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert result.manifest_version == 1
    insert, subject_insert = [p for q, p in conn.executed if "arena.leaderboards" in q]
    assert (insert[2], subject_insert[2]) == ("assistant", "subject")  # both boards, same manifest and label
    assert (subject_insert[1], subject_insert[3]) == (insert[1], insert[3])
    assert insert[3] == "original"
    assert insert[4].obj["binding"]["manifest_version"] == 1


@pytest.mark.usefixtures("scored")
def test_seal_correction_and_publish_skips_the_board_on_rv18s_unchanged_no_op() -> None:
    # No trial line changed: `ledger.seal_corrected_manifest` returns v1 itself (RV-18), never a new row.
    # Publishing a "corrected" board bound to v1 would trip `arena.tg_leaderboard_label` (AR020) -- the fix
    # is to skip the publish entirely, not to let that trigger turn a successful no-op into a 409.
    conn = FakeConn(
        {
            "ledger.seal_corrected_manifest": [
                ({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64, "version": 1},)
            ],
            "ledger.planned_execution": [trial_fact_row()],
        }
    )
    result = run(reveal.seal_correction_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert result.manifest_version == 1
    assert not any("arena.leaderboards" in q for q, _ in conn.executed)


@pytest.mark.usefixtures("scored")
def test_seal_correction_and_publish_writes_a_corrected_leaderboard_on_the_new_version() -> None:
    conn = FakeConn(
        {
            "ledger.seal_corrected_manifest": [
                ({"manifest_id": MANIFEST_2, "manifest_sha256": "b" * 64, "version": CORRECTED_VERSION},)
            ],
            "ledger.planned_execution": [trial_fact_row()],
        }
    )
    result = run(reveal.seal_correction_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert result.manifest_version == CORRECTED_VERSION
    insert, subject_insert = [p for q, p in conn.executed if "arena.leaderboards" in q]
    assert (insert[2], subject_insert[2]) == ("assistant", "subject")  # both boards, same manifest and label
    assert (subject_insert[1], subject_insert[3]) == (insert[1], insert[3])
    assert insert[3] == "corrected"
    assert insert[4].obj["binding"]["manifest_version"] == CORRECTED_VERSION


def test_reveal_publishes_qq_from_each_trial_s_stored_judgments(monkeypatch: pytest.MonkeyPatch) -> None:
    # Codex r3 #3: the published board's M09 comes from the stored R1/R2 judgments, never a constant None.
    sentinel = object()
    seen: list[tuple[str, object]] = []

    async def fake_fetch(_connect: object, trial_id: str) -> object:
        assert trial_id == "00000000-0000-0000-0000-0000000000e1"
        return sentinel

    def fake_score(family_id: str, stored: object) -> TrialScore:
        seen.append((family_id, stored))
        return TrialScore(family_id=family_id, qq=Fraction(3, 4))

    monkeypatch.setattr(db, "fetch_stored_trial_judgments", fake_fetch)
    monkeypatch.setattr(reveal, "trial_score", fake_score)
    conn = FakeConn(
        {
            "ledger.reveal": [({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64},)],
            "ledger.planned_execution": [trial_fact_row()],
        }
    )
    run(reveal.reveal_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert seen == [("F01", sentinel)]
    insert, subject_insert = [p for q, p in conn.executed if "arena.leaderboards" in q]
    assert (insert[2], subject_insert[2]) == ("assistant", "subject")  # both boards, same manifest and label
    assert (subject_insert[1], subject_insert[3]) == (insert[1], insert[3])
    [row] = insert[4].obj["rows"]
    m09 = row["metrics"]["M09_questioning_quality"]
    assert Fraction(m09["point"]["num"], m09["point"]["den"]) == Fraction(3, 4)


def test_an_unscored_replay_trial_never_blocks_reveal() -> None:
    row = (*trial_fact_row()[:1], "replay", *trial_fact_row()[2:])
    conn = FakeConn(
        {
            "ledger.reveal": [({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64},)],
            "ledger.planned_execution": [row],
        }
    )
    assert run(reveal.reveal_and_publish(connector(conn), TOURNAMENT, ctx())).manifest_version == 1


def test_an_unfinished_roster_blocks_reveal_before_anything_is_sealed() -> None:
    # Codex r6 #2: a planned trial with no execution record is a blocked precondition, never a ValueError/500.
    row = (*trial_fact_row()[:7], None, *trial_fact_row()[8:])
    conn = FakeConn(
        {
            "ledger.reveal": [({"manifest_id": MANIFEST_1, "manifest_sha256": "a" * 64},)],
            "ledger.planned_execution": [row],
        }
    )
    with pytest.raises(RevealBlockedError):
        run(reveal.reveal_and_publish(connector(conn), TOURNAMENT, ctx()))
    assert not any("ledger.reveal(" in q for q, _ in conn.executed)
