"""The blinded trainer review queue (S3 7.3; SG4-09, SG4-11): list, read and submit a calibration task, one
response schema per task kind. The item's `payload` already carries exactly what a rater may see (S3 7.3's
three tables); this module only discriminates it to its typed shape and validates a submission against the
matching typed shape before `arena_referee.db` stores it.

A submission is validated for its own internal shape and completeness (every per-question check answered
once, no duplicate flag or follow-up, the right task literal), and, for T-LAB and T-FLAG, cross-checked
against the exact turn IDs or flag references the stored item names (`RefSubjContext` / `RefAsstContext`,
the same checks `contracts.review`'s models apply to ref_subj.v5 and ref_asst.v2 themselves) -- built here,
directly from the item's own stored fields, since `LabelItem` and `FlagItem` already carry everything the
context needs.

Scope note, T-RUB only: `RubricItem` does not carry the follow-ups, citations or rubric sub-check IDs a
`RefAsstContext` needs (it carries investigator *questions*, a different shape, S3 7.3), so a T-RUB
submission is validated for its own shape and completeness only, not cross-checked against the item. The
sampler that creates review items (WP-25a) is the natural place to either add those fields to `RubricItem`
or build the context itself from the trial context it still holds at creation time; recorded here rather
than guessed at.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from pydantic import ValidationError

from arena_core.contracts.common import turn_id
from arena_core.contracts.referee import RefAsstContext, RefSubjContext
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


class ReviewItemCorruptError(RuntimeError):
    """A stored item does not validate as its own typed shape -- a storage-layer defect, never the rater's
    own input, so its message is never echoed to a caller (pydantic's own validation message can include
    the offending field's value, which could be exactly the content review items exist to keep out of the
    rater's sight, S3 7.3's own invariant: never a role, outcome, candidate or participant identity)."""


def parse_item(payload: Mapping[str, Any]) -> ReviewItem:
    model = _ITEM_MODELS[cast("str", payload["task"])]
    return model.model_validate(payload)


def context_for(item: ReviewItem) -> RefSubjContext | RefAsstContext | None:
    """The cross-check context a submission against `item` is validated against, or None for a task kind
    the item's own stored shape cannot support yet (T-RUB; see the module scope note)."""
    if isinstance(item, LabelItem):
        return RefSubjContext(
            subject_turn_ids=tuple(turn_id(t.turn_no) for t in item.transcript),
            canonical_fact_ids=frozenset(f.id for f in item.canonical_facts),
            visible_record_ids=frozenset(
                [d.doc_id for d in item.initial_documents] + [r.record_id for r in item.released]
            ),
        )
    if isinstance(item, FlagItem):
        # Only `flag_refs` is populated: `assistant_judgment_errors` reads the other RefAsstContext fields
        # only when the matching submission field (followups/citations/subchecks) is not None, and a T-FLAG
        # submission carries none of those.
        return RefAsstContext(
            flag_refs=frozenset(f.flag_ref for f in item.flags),
            followup_turn_ids=frozenset(),
            citation_ids=frozenset(),
            rubric_subcheck_ids=frozenset(),
            transcript_turn_ids=frozenset(),
        )
    return None


def parse_submission(task: str, raw: Mapping[str, Any], context: object | None = None) -> ReviewSubmission:
    model = _SUBMISSION_MODELS[task]
    return model.model_validate(raw, context=context)


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
    """`POST /api/review/items/{id}`: validate the submission against the item's own task kind and, for
    T-LAB and T-FLAG, against the item's own turns or flags (`context_for`), then store it (idempotent per
    item and rater, `training.submit_review_item`)."""
    payload = await db.get_review_item(connect, item_id, rater_user_id)
    if payload is None:
        raise ReviewItemNotFoundError(str(item_id))
    try:
        item = parse_item(payload)
    except ValidationError as exc:
        msg = f"stored review item {item_id} does not validate as its own task shape"
        raise ReviewItemCorruptError(msg) from exc
    submission = parse_submission(item.task, raw_submission, context=context_for(item))
    return await db.submit_review_item(connect, item_id, rater_user_id, submission.model_dump(mode="json"))
