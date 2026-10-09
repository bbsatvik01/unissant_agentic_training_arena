"""The send-path guarantee (S5 1.2 item 2, 6.5): only a frame that passed the projection reaches the wire."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter

from arena_core.contracts.events import TrialFrame
from arena_core.events import projections
from arena_core.events.projections import ProjectedFrame
from arena_core.events.sse import MAX_DELTA_BYTES, sse_message

FIXTURES = Path(__file__).resolve().parents[4] / "contracts" / "fixtures" / "wire.json"


def _valid(case_id: str) -> dict[str, Any]:
    cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["valid"]
    value = next(c["value"] for c in cases if c["id"] == case_id)
    assert isinstance(value, dict)
    return value


def _frame(case_id: str) -> TrialFrame:
    adapter: TypeAdapter[TrialFrame] = TypeAdapter(TrialFrame)
    return adapter.validate_python(_valid(case_id))


def test_a_projected_frame_is_sent_with_its_seq_as_the_sse_id() -> None:
    message = sse_message(projections._seal(_frame("frame:subject.answer")))
    head, data = message.split("\n", 1)
    assert head == "id: 2"
    assert data.startswith("data: ")
    assert message.endswith("\n\n")
    assert json.loads(data[len("data: ") :].strip()) == _valid("frame:subject.answer")


def test_a_synthesized_frame_carries_no_sse_id() -> None:
    message = sse_message(projections._seal(_frame("frame:notice")))
    assert message.startswith("data: ")
    assert "id:" not in message


@pytest.mark.gateproof
def test_a_frame_built_outside_the_projection_cannot_be_sent() -> None:
    built_elsewhere = _frame("frame:notice")  # a valid frame model, constructed by this test module
    with pytest.raises(TypeError, match="only a ProjectedFrame"):
        sse_message(built_elsewhere)
    with pytest.raises(TypeError, match="only a ProjectedFrame"):
        sse_message(_valid("frame:notice"))


@pytest.mark.gateproof
def test_a_projected_frame_cannot_be_forged_without_the_projections_seal() -> None:
    with pytest.raises(PermissionError, match=r"only by arena_core\.events\.projections"):
        ProjectedFrame(_frame("frame:notice"), object())
    with pytest.raises(PermissionError):
        ProjectedFrame(_frame("frame:notice"), None)


def test_an_oversize_delta_is_a_defect_and_is_not_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    projected = projections._seal(_frame("frame:notice"))
    monkeypatch.setattr("arena_core.events.sse.MAX_DELTA_BYTES", 10)
    with pytest.raises(ValueError, match="exceeds 10"):
        sse_message(projected)
    assert MAX_DELTA_BYTES == 16 * 1024
