"""The blinded trainer review queue (S3 7.3; SG4-09, SG4-11): list, read and submit a calibration task, one
response schema per task kind. The item's `payload` already carries exactly what a rater may see (S3 7.3's
three tables); this module only discriminates it to its typed shape and validates a submission against the
matching typed shape before `arena_referee.db` stores it.

Scope note: a submission is validated for its own internal shape and completeness (every per-question check
answered once, no duplicate flag or follow-up, the right task literal) but not cross-checked against the
exact flag references, follow-up turns or sub-check IDs the stored item names (the `RefAsstContext` /
`RefSubjContext` checks `contracts.review`'s models support when given one). The sampler that creates review
items (WP-25a) already holds that context when it builds the item and is the natural place to add the
cross-check; recorded here rather than guessed at.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from arena_core.contracts.review import (
    FlagItem,
    FlagSubmission,
    LabelItem,
    LabelSubmission,
    ReviewItem,
    ReviewList,
    ReviewListEntry,
    ReviewSubmission,
    RubricItem,
    RubricSubmission,
)
from arena_core.db.pool import Connector
from arena_referee import db

_ITEM_MODELS: dict[str, type[ReviewItem]] = {"T-RUB": RubricItem, "T-LAB": LabelItem, "T-FLAG": FlagItem}
_SUBMISSION_MODELS: dict[str, type[ReviewSubmission]] = {
    "T-RUB": RubricSubmission,
    "T-LAB": LabelSubmission,
    "T-FLAG": FlagSubmission,
}


class ReviewItemNotFoundError(LookupError):
    """No item with this id is assigned to this rater (S5 5.5: no existence oracle for someone else's item)."""


def parse_item(payload: Mapping[str, Any]) -> ReviewItem:
    model = _ITEM_MODELS[cast("str", payload["task"])]
    return model.model_validate(payload)


def parse_submission(task: str, raw: Mapping[str, Any]) -> ReviewSubmission:
    model = _SUBMISSION_MODELS[task]
    return model.model_validate(raw)


async def list_items(connect: Connector, rater_user_id: UUID) -> ReviewList:
    """`GET /api/review/items`."""
    rows = await db.list_review_items(connect, rater_user_id)
    return ReviewList(
        items=[ReviewListEntry(item_id=str(r["item_id"]), task=r["task"], submitted=r["submitted"]) for r in rows]
    )


async def get_item(connect: Connector, item_id: UUID, rater_user_id: UUID) -> ReviewItem:
    """`GET /api/review/items/{id}`; raises `ReviewItemNotFoundError` for an item not assigned to this rater."""
    payload = await db.get_review_item(connect, item_id, rater_user_id)
    if payload is None:
        raise ReviewItemNotFoundError(str(item_id))
    return parse_item(payload)


async def submit_item(
    connect: Connector, item_id: UUID, rater_user_id: UUID, raw_submission: Mapping[str, Any]
) -> Mapping[str, Any]:
    """`POST /api/review/items/{id}`: validate the submission against the item's own task kind, then store it
    (idempotent per item and rater, `training.submit_review_item`)."""
    payload = await db.get_review_item(connect, item_id, rater_user_id)
    if payload is None:
        raise ReviewItemNotFoundError(str(item_id))
    task = cast("str", payload["task"])
    submission = parse_submission(task, raw_submission)
    return await db.submit_review_item(connect, item_id, rater_user_id, submission.model_dump(mode="json"))
