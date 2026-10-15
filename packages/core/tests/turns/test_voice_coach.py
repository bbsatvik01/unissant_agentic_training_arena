"""The coach card of a practice voice exchange (UI v2 amendment to D7): the same coach step as a text turn, over
the stored exchanges, sent as the voice socket's `coach.card` text frame. Fake adapter and in-memory S4 only."""

from __future__ import annotations

import asyncio
import json
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from arena_core.contracts.events import CoachCard
from arena_core.db.arena import ArenaError
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.providers.types import ModelRequest
from arena_core.spend.memory import RunBudget
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.voice_coach import VoiceCoach
from packages.core.tests.turns.fakedb import FakeArenaDb


async def _no_sleep(_s: float) -> None:
    return None


def _db(mode: str = "practice") -> FakeArenaDb:
    db = FakeArenaDb(uuid4(), mode=mode)
    db.voice = True
    db.voice_rows = [
        {"exchange_no": 1, "lines": [{"role": "subject", "text": "Hello?", "partial": False}]},
        {
            "exchange_no": 2,
            "lines": [
                {"role": "investigator", "text": "Where were you on Tuesday?", "partial": False},
                {"role": "subject", "text": "At the plant all day.", "partial": False},
            ],
        },
        {
            "exchange_no": 3,
            "lines": [
                {"role": "investigator", "text": "Who saw you there?", "partial": False},
                {"role": "subject", "text": "The night guard.", "partial": False},
            ],
        },
    ]
    return db


def _coach(db: FakeArenaDb, ceiling: Decimal = Decimal(100)) -> tuple[VoiceCoach, RunBudget]:
    budget = RunBudget(ceiling)
    port = AgentPort(FakeAdapter(canned=FAKE_COACH_REPLIES), budget, PortOptions(sleep=_no_sleep))
    return VoiceCoach(db, port, db.trial_id), budget


def _frame(text: str | None) -> dict[str, Any]:
    assert text is not None
    frame: dict[str, Any] = json.loads(text)
    return frame


def test_a_practice_exchange_gets_a_card_frame_for_its_turn_through_the_spend_guard() -> None:
    db = _db()
    coach, budget = _coach(db)
    frame = _frame(asyncio.run(coach.card_after(2)))
    assert set(frame) == {"type", "exchange_no", "data"}
    assert (frame["type"], frame["exchange_no"]) == ("coach.card", 2)
    data = CoachCard.model_validate_json(json.dumps(frame["data"]))
    assert data.turn_no == 1
    assert data.card.card_seq == 1
    assert "candidate_sha256" not in frame["data"]["card"]
    assert [op for op, _ in budget.ops] == ["reserve", "dispatch", "record", "settle"]
    held = next(iter(budget.reservations.values()))
    _bucket, _model, call_kind, purpose, trial, actor, _bytes = held.identity
    assert (call_kind, purpose, trial, actor) == ("card", "coach.card", db.trial_id, db.actor)


def test_the_next_card_reads_the_earlier_ones() -> None:
    coach, _ = _coach(_db())
    asyncio.run(coach.card_after(2))
    second = CoachCard.model_validate_json(json.dumps(_frame(asyncio.run(coach.card_after(3)))["data"]))
    assert (second.turn_no, second.card.card_seq) == (2, 2)
    assert [c.card_seq for c in coach.cards] == [1, 2]


def test_no_card_for_assessment_a_text_session_or_a_window_without_a_turn() -> None:
    assert asyncio.run(_coach(_db("assessment"))[0].card_after(2)) is None
    text = _db()
    text.voice = False
    assert asyncio.run(_coach(text)[0].card_after(2)) is None
    assert asyncio.run(_coach(_db())[0].card_after(1)) is None  # the subject spoke alone
    assert asyncio.run(_coach(_db())[0].card_after(9)) is None


def test_a_refused_or_unreadable_card_is_no_card_and_the_session_goes_on() -> None:
    coach, _ = _coach(_db(), ceiling=Decimal(0))
    assert asyncio.run(coach.card_after(2)) is None
    assert coach.cards == []
    missing = _db()
    missing.manifest_missing = True
    assert asyncio.run(_coach(missing)[0].card_after(2)) is None


class RefusingDb(FakeArenaDb):
    async def voice_exchanges(self, trial: UUID) -> list[dict[str, Any]]:
        raise ArenaError("AR040", f"{trial} not found")


def test_a_database_refusal_is_no_card() -> None:
    db = RefusingDb(uuid4())
    db.voice = True
    assert asyncio.run(_coach(db)[0].card_after(2)) is None


def test_a_record_released_after_a_window_without_a_turn_reaches_the_next_turns_card() -> None:
    """Releases count windows, the coach counts turns: window 1 holds no turn, so a record released after window 2
    (turn 1) is visible to turn 2's card (window 3)."""
    db = _db()
    db.releases = [
        {"record_id": "rec-01", "title": "Work order", "content": {"body": "Logged at 21:40."}, "after_exchanges": 2}
    ]
    seen: list[str] = []

    def card(request: ModelRequest) -> str:
        seen.append(request.messages[-1].text)
        return FAKE_COACH_REPLIES["CoachingCard"](request)

    port = AgentPort(FakeAdapter(canned={"CoachingCard": card}), RunBudget(Decimal(100)), PortOptions(sleep=_no_sleep))
    coach = VoiceCoach(db, port, db.trial_id)
    asyncio.run(coach.card_after(2))
    asyncio.run(coach.card_after(3))
    assert "Logged at 21:40." not in seen[0]  # the record's content, not its id (the case lists every requestable id)
    assert "Logged at 21:40." in seen[1]
