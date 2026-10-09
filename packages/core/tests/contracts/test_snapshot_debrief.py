"""The trial snapshot's two branches (S6 5.3, SG4-39) and debrief.v1 against S3 5.7's own schema text."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError

from arena_core.contracts import export
from arena_core.contracts.debrief import Debrief, Rubric
from arena_core.contracts.snapshot import TrialSnapshot

from .conftest import REPO_ROOT, load_fixture

WIRE = load_fixture("wire.json")
SNAPSHOT: TypeAdapter[TrialSnapshot] = TypeAdapter(TrialSnapshot)


def _valid(case_id: str) -> dict[str, Any]:
    value = next(c["value"] for c in WIRE["valid"] if c["id"] == case_id)
    return copy.deepcopy(value)


def test_text_snapshot_counts_answered_turns() -> None:
    snap = _valid("snapshot:text")
    SNAPSHOT.validate_python(snap)
    with pytest.raises(ValidationError, match="answered turns"):
        SNAPSHOT.validate_python({**snap, "exchanges_used": 2})
    with pytest.raises(ValidationError, match="numbered"):
        SNAPSHOT.validate_python({**snap, "turns": [{**snap["turns"][0], "turn_no": 2}]})


def test_voice_snapshot_counts_stored_windows_within_the_cap() -> None:
    snap = _valid("snapshot:voice")
    parsed = SNAPSHOT.validate_python(snap)
    assert parsed.channel == "voice"
    assert parsed.voice_exchanges[1].lines[0].partial is True
    with pytest.raises(ValidationError, match="stored exchanges"):
        SNAPSHOT.validate_python({**snap, "exchanges_used": 1})
    with pytest.raises(ValidationError, match="numbered"):
        SNAPSHOT.validate_python({**snap, "voice_exchanges": snap["voice_exchanges"][1:], "exchanges_used": 1})
    with pytest.raises(ValidationError, match="exceeds exchanges_cap"):
        SNAPSHOT.validate_python({**snap, "exchanges_cap": 1})


def test_a_rubric_is_scorable_with_a_total_or_unscorable_with_a_reason() -> None:
    Rubric.model_validate({"scorable": False, "unscorable_reason": "two questions", "total": None, "dimensions": []})
    bads: list[dict[str, object]] = [
        {"scorable": False, "unscorable_reason": None, "total": None, "dimensions": []},
        {"scorable": False, "unscorable_reason": "two questions", "total": 40, "dimensions": []},
        {"scorable": True, "unscorable_reason": None, "total": None, "dimensions": []},
        {"scorable": True, "unscorable_reason": "x", "total": 50, "dimensions": []},
    ]
    for bad in bads:
        with pytest.raises(ValidationError):
            Rubric.model_validate(bad)
    scorable = {"scorable": False, "unscorable_reason": "two questions", "total": None}
    dim = {"dim_id": "D1", "score": 2, "checks": []}
    with pytest.raises(ValidationError):
        Rubric.model_validate({**scorable, "dimensions": [dim]})


def _s3_debrief_schema() -> dict[str, Any]:
    """The `debrief.v1` JSON Schema exactly as S3 5.7 prints it."""
    text = (REPO_ROOT / "docs" / "spec" / "S3-scoring-rubrics-metrics.md").read_text(encoding="utf-8")
    start = text.index("**Training debrief payload (`debrief.v1`")
    block = re.search(r"```json\n(.*?)\n```", text[start:], re.DOTALL)
    assert block is not None
    parsed = json.loads(block.group(1))
    assert isinstance(parsed, dict)
    return parsed


def test_the_exported_debrief_schema_agrees_with_s3s_on_every_fixture() -> None:
    s3 = Draft202012Validator(_s3_debrief_schema())
    ours = Draft202012Validator(export.schema_of("debrief.v1"))
    cases = [c for c in WIRE["valid"] + WIRE["invalid"] if c["schema"] == "debrief.v1"]
    scored = _valid("debrief:scored")
    extra = [
        {**scored, "scored": False},
        {k: v for k, v in scored.items() if k != "scorecards"},
        {**scored, "session_id": "not-a-uuid"},
        {**scored, "outcome": {**scored["outcome"], "committed_label": None}},
        {**scored, "outcome": {**scored["outcome"], "role": "unknown"}},
        {**scored, "candidate_sha256": "a" * 64},
        {
            **scored,
            "scorecards": {
                **scored["scorecards"],
                "detection": {**scored["scorecards"]["detection"], "coach_last_label": None},
            },
        },
    ]
    stricter = [c["value"] for c in cases if c.get("why") == "unscorable rubric with a total (SG2-38)"]
    values = [c["value"] for c in cases if c["value"] not in stricter] + extra
    assert len(values) >= len(extra) + 3
    for value in values:
        assert ours.is_valid(value) == s3.is_valid(value), value
    # S5 5.4 and SG2-38 add one rule S3's schema text leaves out: an unscorable rubric has no total.
    assert len(stricter) == 1
    assert s3.is_valid(stricter[0])
    assert not ours.is_valid(stricter[0])
    assert {s3.is_valid(v) for v in values} == {True, False}
    debrief: TypeAdapter[Debrief] = TypeAdapter(Debrief)
    for value in values:
        if s3.is_valid(value):
            debrief.validate_python(value)
        else:
            with pytest.raises(ValidationError):
                debrief.validate_python(value)


def test_the_text_snapshot_carries_the_event_order_cards_are_judged_by() -> None:
    """S6 4.5, FE-COACH-7: questions, releases and cards carry their row's seq, so a snapshot can be judged by the
    same complete-card rule as the deltas (a card read before a release that preceded it is stale)."""
    snap = _valid("snapshot:text")
    parsed = SNAPSHOT.validate_python(snap)
    assert parsed.channel == "text"
    question_seq, card_seq = 1, 3  # the fixture's question row and card row
    assert parsed.turns[0].question_seq == question_seq
    assert parsed.cards[0].event_seq == card_seq
    for missing in (("turns", "question_seq"), ("cards", "event_seq")):
        broken = copy.deepcopy(snap)
        del broken[missing[0]][0][missing[1]]
        with pytest.raises(ValidationError, match=missing[1]):
            SNAPSHOT.validate_python(broken)
    release = {
        "record_id": "rec-02",
        "title": "Lab B panel alarm log",
        "kind": "record",
        "doc_kind": "alarm_log",
        "date": None,
        "content": {"body": "Lab B panel alarm log for the evening of the entry."},
        "released_at_turn": 1,
        "trigger": "scheduled",
        "transcript_version": 3,
        "event_seq": 3,
    }
    with_release = {**snap, "released": [release], "last_seq": 4, "cards": [{**snap["cards"][0], "event_seq": 4}]}
    SNAPSHOT.validate_python(with_release)
    no_seq = {**with_release, "released": [{k: v for k, v in release.items() if k != "event_seq"}]}
    with pytest.raises(ValidationError, match="event_seq"):
        SNAPSHOT.validate_python(no_seq)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda s: s["cards"][0].update(event_seq=9), "after last_seq"),
        (lambda s: s["turns"][0].update(question_seq=9), "after last_seq"),
        (lambda s: s["cards"][0].update(event_seq=1), "twice"),
    ],
)
def test_snapshot_event_seqs_are_distinct_and_within_last_seq(
    change: Callable[[dict[str, Any]], None], message: str
) -> None:
    snap = _valid("snapshot:text")
    change(snap)
    with pytest.raises(ValidationError, match=message):
        SNAPSHOT.validate_python(snap)


def test_a_voice_snapshot_release_seq_is_within_last_seq() -> None:
    snap = _valid("snapshot:voice")
    release = {
        "record_id": "rec-02",
        "title": "Lab B panel alarm log",
        "kind": "record",
        "doc_kind": "alarm_log",
        "date": None,
        "content": {"body": "Lab B panel alarm log for the evening of the entry."},
        "released_at_turn": 1,
        "trigger": "scheduled",
        "transcript_version": 3,
        "event_seq": 3,
    }
    SNAPSHOT.validate_python({**snap, "released": [release]})
    with pytest.raises(ValidationError, match="after last_seq"):
        SNAPSHOT.validate_python({**snap, "released": [{**release, "event_seq": 4}]})
