"""The send path (S5 1.2 item 2, 6.2, 6.5): only the projection produces wire bytes, from stored events."""

from __future__ import annotations

import copy
import inspect
import json
from pathlib import Path
from typing import Any

import pytest

from arena_core.events import projections, sse
from arena_core.events.projections import Release, StoredEvent, Viewer, wire_deltas
from arena_core.events.sse import write_deltas

FIXTURES = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "wire.json"
TRIAL = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41"
TS = "2026-10-20T15:04:05.123Z"
SHA = "a" * 64
ENDED = Viewer(trial_ended=True)
RUNNING = Viewer(trial_ended=False)


def _fixture(case_id: str) -> dict[str, Any]:
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["valid"]
    value = next(c["value"] for c in cases if c["id"] == case_id)
    assert isinstance(value, dict)
    return value


def _row(
    kind: str, seq: int, version: int, payload: dict[str, Any], extra: dict[str, Any] | None = None
) -> StoredEvent:
    """A stored row of the test trial; `extra` sets turn_no, release or terminal_state."""
    base: dict[str, Any] = {
        "trial_id": TRIAL,
        "trial_kind": "training",
        "seq": seq,
        "kind": kind,
        "visibility": "live",
        "transcript_version": version,
        "turn_no": None,
        "payload": payload,
        "created_at": TS,
    }
    return StoredEvent(**{**base, **(extra or {})})


def _rows() -> dict[str, StoredEvent]:
    """One stored row per wire type, shaped as S4's `arena._emit` writes them (sql 0004)."""
    released = _fixture("frame:evidence.released")["data"]
    card = {**_fixture("frame:coach.card")["data"]["card"], "candidate_sha256": SHA}
    return {
        "frame:question.accepted": _row(
            "question_recorded",
            1,
            1,
            {"turn_no": 1, "question": "Why did you enter?", "source": "investigator", "channel": "text"},
        ),
        "frame:subject.answer": _row(
            "subject_turn", 2, 2, {"turn_no": 1, "answer": "It was a busy shift.", "partial": False, "channel": "text"}
        ),
        "frame:evidence.released": _row(
            "evidence_released",
            7,
            7,
            {k: released[k] for k in ("record_id", "kind", "doc_kind", "title", "content")},
            {"release": Release(released_after_exchanges=3, trigger="requested", date="2026-09-14")},
        ),
        "frame:coach.card": _row("coach_card", 3, 2, card, {"turn_no": 1}),
        "frame:coach.update": _row(
            "coach_deep", 9, 6, _fixture("frame:coach.update")["data"]["update"], {"turn_no": 3}
        ),
        "frame:coach.failed": _row("coach_unavailable", 10, 8, {"reason": "timeout"}, {"turn_no": 4}),
        "frame:finding.committed": _row(
            "finding_committed", 20, 12, _fixture("frame:finding.committed")["data"]["finding"]
        ),
        "frame:trial.status.failed": _row(
            "trial_ended", 21, 12, {"reason": "repair_failed"}, {"terminal_state": "assistant_failed"}
        ),
        "frame:debrief.ready": _row("debrief_ready", 22, 12, {"session_id": "c4d5e6f7-0a1b-4c2d-8e3f-9a0b1c2d3e4f"}),
    }


def _parse(message: bytes) -> tuple[int | None, dict[str, Any]]:
    text = message.decode("utf-8")
    assert text.endswith("\n\n")
    lines = text.rstrip("\n").split("\n")
    seq = int(lines[0].removeprefix("id: ")) if lines[0].startswith("id: ") else None
    data = json.loads(lines[-1].removeprefix("data: "))
    assert isinstance(data, dict)
    return seq, data


@pytest.mark.parametrize("case_id", list(_rows()))
def test_each_stored_kind_projects_to_exactly_its_wire_frame(case_id: str) -> None:
    (message,) = wire_deltas([_rows()[case_id]], ENDED)
    seq, data = _parse(message)
    assert data == _fixture(case_id)
    assert seq == data["seq"]


def test_a_completed_trial_ends_with_status_then_finalized_and_the_seq_rides_on_the_last() -> None:
    row = _row(
        "trial_ended", 21, 12, {"reason": "completed", "commitment_sha256": "b" * 64}, {"terminal_state": "completed"}
    )
    status, finalized = (_parse(m) for m in wire_deltas([row], ENDED))
    assert status == (None, _fixture("frame:trial.status.completed"))
    assert finalized == (21, _fixture("frame:trial.finalized"))


def test_the_training_card_on_the_wire_carries_no_candidate_identifier() -> None:
    (message,) = wire_deltas([_rows()["frame:coach.card"]], ENDED)
    assert b"candidate_sha256" not in message
    assert SHA.encode() not in message


def test_visibility_live_always_debrief_after_the_end_internal_never() -> None:
    card = _rows()["frame:coach.card"]
    debrief = StoredEvent(**{**card.__dict__, "visibility": "debrief"})
    internal = StoredEvent(**{**card.__dict__, "visibility": "internal"})
    assert wire_deltas([debrief], RUNNING) == []
    assert len(wire_deltas([debrief], ENDED)) == 1
    assert wire_deltas([internal], ENDED) == []
    assert len(wire_deltas([card], RUNNING)) == 1


def test_mutating_anything_after_the_call_cannot_change_the_emitted_bytes() -> None:
    payload = copy.deepcopy(dict(_rows()["frame:finding.committed"].payload))
    row = _row("finding_committed", 20, 12, payload)
    messages = wire_deltas([row], ENDED)
    before = list(messages)
    payload["rationale"] = "Changed after the projection."
    payload["cited_turns"].append(9)
    assert all(isinstance(m, bytes) for m in messages)
    assert messages == before
    assert b"Changed after" not in messages[0]


@pytest.mark.gateproof
def test_no_public_api_turns_a_frame_into_wire_bytes() -> None:
    not_a_row: list[Any] = [_fixture("frame:notice")]
    with pytest.raises(TypeError, match="projects stored events"):
        wire_deltas(not_a_row, ENDED)
    for module in (projections, sse):
        for name, obj in vars(module).items():
            if name.startswith("_") or not inspect.isfunction(obj) or obj.__module__ != module.__name__:
                continue
            annotations = " ".join(str(a) for a in obj.__annotations__.values())
            assert "Frame" not in annotations, f"{module.__name__}.{name} takes or returns a frame"
    assert not hasattr(projections, "ProjectedFrame")


def test_a_row_the_projection_cannot_map_is_a_defect() -> None:
    with pytest.raises(ValueError, match="unknown event kind"):
        wire_deltas([_row("referee_labeled", 5, 5, {})], ENDED)
    evidence = _rows()["frame:evidence.released"]
    with pytest.raises(ValueError, match="needs its release row"):
        wire_deltas([StoredEvent(**{**evidence.__dict__, "release": None})], ENDED)
    with pytest.raises(ValueError, match="needs the trial's terminal record"):
        wire_deltas([_row("trial_ended", 21, 12, {"reason": "completed"})], ENDED)


def test_a_frame_that_breaks_the_contract_is_never_serialized() -> None:
    bad = _row("subject_turn", 2, 2, {"turn_no": 13, "answer": "x", "partial": False, "channel": "text"})
    with pytest.raises(ValueError, match="turn_no"):
        wire_deltas([bad], ENDED)


def test_an_oversize_delta_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    assert projections.MAX_DELTA_BYTES == 16 * 1024  # S5 6.2: every delta at most 16 KB
    monkeypatch.setattr(projections, "MAX_DELTA_BYTES", 10)
    with pytest.raises(ValueError, match="exceeds 10"):
        wire_deltas([_rows()["frame:subject.answer"]], ENDED)


def _evidence_of_body_size(size: int) -> StoredEvent:
    """An evidence event whose serialized frame body (the SSE `data:` JSON) is exactly `size` bytes, padded with
    a table of 200-character cells and then the record body (ASCII: one byte per character)."""
    base = _rows()["frame:evidence.released"]
    payload = dict(base.payload)

    def body_bytes(content: dict[str, Any]) -> int:
        """Measured with the bound lifted, so sizes on both sides of it can be found."""
        row = StoredEvent(**{**base.__dict__, "payload": {**payload, "content": content}})
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(projections, "MAX_DELTA_BYTES", 10**9)
            (message,) = wire_deltas([row], ENDED)
        return len(message.split(b"data: ", 1)[1]) - 2  # less the closing blank line

    cells = ["x" * 200] * 8
    columns = [f"c{i}" for i in range(8)]

    def content_of(rows: list[list[str]], body: str = "b") -> dict[str, Any]:
        return {"body": body, "table": {"columns": columns, "rows": rows}}

    rows = [cells]
    while body_bytes(content_of([*rows, cells])) < size:  # each row adds about 1,650 bytes
        rows.append(cells)
    content = content_of(rows, "b" * (1 + size - body_bytes(content_of(rows))))  # the rest, under 2,000 characters
    assert body_bytes(content) == size
    return StoredEvent(**{**base.__dict__, "payload": {**payload, "content": content}})


def test_the_real_16_kb_bound_admits_exactly_the_limit_and_refuses_one_byte_more() -> None:
    limit = 16 * 1024
    at_limit = wire_deltas([_evidence_of_body_size(limit)], ENDED)
    assert len(at_limit) == 1
    with pytest.raises(ValueError, match=f"{limit + 1} bytes exceeds {limit}"):
        wire_deltas([_evidence_of_body_size(limit + 1)], ENDED)


def test_the_stream_writes_only_the_projections_bytes() -> None:
    written: list[bytes] = []
    rows = list(_rows().values())
    assert write_deltas(written.append, rows, ENDED) == len(rows)
    assert written == wire_deltas(rows, ENDED)
