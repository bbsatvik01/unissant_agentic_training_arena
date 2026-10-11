"""The blinded trainer review queue (S3 7.3): list, get, submit, dispatched by task kind."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, cast
from uuid import UUID, uuid4

import pytest

from arena_core.db.pool import Connector
from arena_referee import db, review

RATER = uuid4()
ITEM = uuid4()


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


# Never actually called: every `db.*` function is monkeypatched, and review.py only threads this through.
_connector = cast("Connector", None)


LAB_PAYLOAD = {
    "task": "T-LAB",
    "item_id": str(uuid4()),
    "initial_documents": [],
    "released": [],
    "transcript": [{"turn_no": 1, "question": "Why were you there?", "answer": "A work order.", "partial": False}],
    "facts": [{"id": "f:01", "class": "FREE", "text": "A fact that is long enough.", "certainty": "certain"}],
    "uncertainty": [],
    "gates": [],
    "permitted_behaviors": [],
    "canonical_facts": [{"id": "f:01", "statement": "A canonical fact, long enough to pass validation."}],
}

LAB_SUBMISSION = {
    "task": "T-LAB",
    "turns": [
        {
            "turn_id": "t01",
            "label": "responsive",
            "eva_subtype": None,
            "pfq_reason": None,
            "no_contradiction": True,
            "no_invention": True,
            "uncertainty_respected": True,
            "disclosure_policy_respected": True,
            "in_character": True,
            "platform_attack": False,
        }
    ],
}


def test_list_items(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list(_connect: object, rater_user_id: UUID) -> list[dict[str, Any]]:
        assert rater_user_id == RATER
        return [{"item_id": ITEM, "task": "T-LAB", "submitted": False}]

    monkeypatch.setattr(db, "list_review_items", fake_list)
    result = run(review.list_items(_connector, RATER))
    assert len(result.items) == 1
    assert result.items[0].task == "T-LAB"
    assert result.items[0].submitted is False


def test_get_item_parses_to_the_right_task_type(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, item_id: UUID, rater_user_id: UUID) -> dict[str, Any]:
        assert (item_id, rater_user_id) == (ITEM, RATER)
        return LAB_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    item = run(review.get_item(_connector, ITEM, RATER))
    assert item.task == "T-LAB"


def test_get_item_raises_when_not_assigned(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> None:
        return None

    monkeypatch.setattr(db, "get_review_item", fake_get)
    with pytest.raises(review.ReviewItemNotFoundError):
        run(review.get_item(_connector, ITEM, RATER))


def test_submit_item_validates_against_the_items_own_task_kind(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    submitted: dict[str, Any] = {}

    async def fake_submit(
        _connect: object, item_id: UUID, rater_user_id: UUID, submission: dict[str, Any]
    ) -> dict[str, Any]:
        submitted["item_id"] = item_id
        submitted["rater_user_id"] = rater_user_id
        submitted["submission"] = submission
        return {"outcome": "recorded"}

    monkeypatch.setattr(db, "get_review_item", fake_get)
    monkeypatch.setattr(db, "submit_review_item", fake_submit)
    result = run(review.submit_item(_connector, ITEM, RATER, LAB_SUBMISSION))
    assert result == {"outcome": "recorded"}
    assert submitted["submission"]["task"] == "T-LAB"


def test_submit_item_refuses_a_mismatched_submission_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    with pytest.raises(Exception, match="task"):
        run(review.submit_item(_connector, ITEM, RATER, {"task": "T-FLAG", "flags": []}))


def test_submit_item_raises_when_not_assigned(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> None:
        return None

    monkeypatch.setattr(db, "get_review_item", fake_get)
    with pytest.raises(review.ReviewItemNotFoundError):
        run(review.submit_item(_connector, ITEM, RATER, LAB_SUBMISSION))


def test_submit_item_rejects_a_t_lab_submission_missing_the_items_own_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    """The item has one turn (t01); an empty `turns` list is complete nonsense for it and must be refused,
    not silently accepted (this is exactly what the item's own RefSubjContext cross-check now catches)."""

    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return LAB_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    with pytest.raises(Exception, match="turns"):
        run(review.submit_item(_connector, ITEM, RATER, {"task": "T-LAB", "turns": []}))


FLAG_PAYLOAD = {
    "task": "T-FLAG",
    "item_id": str(uuid4()),
    "initial_documents": [],
    "released": [],
    "transcript": [{"turn_no": 1, "question": "Why were you there?", "answer": "A work order.", "partial": False}],
    "flags": [
        {
            "flag_ref": "t01.f1",
            "kind": "gap",
            "turn_id": "t01",
            "quote": "I had a work order.",
            "missing_fact": "which work order",
            "conflict_turn_id": None,
            "conflict_quote": None,
            "conflict_record_id": None,
            "conflict_record_quote": None,
        }
    ],
}

FLAG_SUBMISSION = {
    "task": "T-FLAG",
    "flags": [
        {
            "flag_ref": "t01.f1",
            "quote_relevant": True,
            "claim_holds": True,
            "content_based": True,
            "no_outside_facts": True,
        }
    ],
}


def test_submit_item_accepts_a_t_flag_submission_matching_the_items_own_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return FLAG_PAYLOAD

    async def fake_submit(
        _connect: object, _item_id: UUID, _rater_user_id: UUID, submission: dict[str, Any]
    ) -> dict[str, Any]:
        return {"outcome": "recorded", "submission": submission}

    monkeypatch.setattr(db, "get_review_item", fake_get)
    monkeypatch.setattr(db, "submit_review_item", fake_submit)
    result = run(review.submit_item(_connector, ITEM, RATER, FLAG_SUBMISSION))
    assert result["outcome"] == "recorded"


def test_submit_item_rejects_a_t_flag_submission_naming_an_unrelated_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """The item names only t01.f1; a submission about a flag the item never mentioned must be refused."""

    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return FLAG_PAYLOAD

    monkeypatch.setattr(db, "get_review_item", fake_get)
    bogus = {
        "task": "T-FLAG",
        "flags": [
            {
                "flag_ref": "t02.f1",
                "quote_relevant": True,
                "claim_holds": True,
                "content_based": True,
                "no_outside_facts": True,
            }
        ],
    }
    with pytest.raises(Exception, match="flags"):
        run(review.submit_item(_connector, ITEM, RATER, bogus))


def test_submit_item_on_a_corrupt_stored_item_never_echoes_its_content(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stored item that fails its own typed validation (e.g. a forbidden extra field a sampler bug put
    there) must raise a generic error, never one whose message could carry the offending field's value --
    review items exist specifically to keep that content out of the rater's sight (S3 7.3)."""

    async def fake_get(_connect: object, _item_id: UUID, _rater_user_id: UUID) -> dict[str, Any]:
        return {
            **LAB_PAYLOAD,
            "private_packet": {"role": "deceptive", "hidden_note": "should never reach a rater"},
        }

    monkeypatch.setattr(db, "get_review_item", fake_get)
    with pytest.raises(review.ReviewItemCorruptError) as exc_info:
        run(review.submit_item(_connector, ITEM, RATER, LAB_SUBMISSION))
    assert "should never reach a rater" not in str(exc_info.value)
    assert "hidden_note" not in str(exc_info.value)
