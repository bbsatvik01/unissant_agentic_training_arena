"""`arena_core.referee.fake_referee` (ARENA_MODEL_MODE=fake, S5 10.4): R1 covers every subject turn the
request names, R2 covers every follow-up and finding citation the request names, read back from the
rendered prompt text exactly as `turns/fake_coach.py` reads a card's exchange number."""

from __future__ import annotations

import json

from arena_core.providers.types import Message, ModelRequest
from arena_core.referee.fake_referee import referee_assistant_reply, referee_subject_reply
from arena_core.spend.limits import ThinkingLevel, VertexModel


def _request(text: str) -> ModelRequest:
    return ModelRequest(
        model=VertexModel.FLASH_LITE_31,
        system="system",
        messages=(Message("user", text),),
        json_schema={},
        max_output_tokens=1,
        thinking=ThinkingLevel.LOW,
        seed=1,
    )


def test_referee_subject_reply_covers_every_turn_up_to_the_last_one_named() -> None:
    report = json.loads(referee_subject_reply(_request("Score the subject's turns t01 to t03 below.")))
    assert report["schema_version"] == "ref_subj.v5"
    assert [t["turn_id"] for t in report["turns"]] == ["t01", "t02", "t03"]
    assert all(t["label"] == "responsive" for t in report["turns"])


def test_referee_subject_reply_defaults_to_one_turn_when_the_range_is_not_found() -> None:
    report = json.loads(referee_subject_reply(_request("no turn range here")))
    assert [t["turn_id"] for t in report["turns"]] == ["t01"]


def test_referee_assistant_reply_covers_every_followup_and_citation_the_request_names() -> None:
    text = (
        "<untrusted_followups_x1>\n"
        "t01 | some follow-up question\n"
        "t02 | another follow-up question\n"
        "</untrusted_followups_x1>\n"
        "Finding citations:\n"
        "rec-01\n"
        "rec-02\n"
        "\n"
        "Applicability triggers:\n"
        "none"
    )
    report = json.loads(referee_assistant_reply(_request(text)))
    assert report["schema_version"] == "ref_asst.v2"
    assert report["flags"] == []
    assert [f["turn_id"] for f in report["followups"]] == ["t01", "t02"]
    assert [c["cite"] for c in report["citations"]] == ["rec-01", "rec-02"]
    assert report["subchecks"]
    assert all(s["result"] == "na" for s in report["subchecks"])


def test_referee_assistant_reply_is_empty_when_the_request_names_nothing() -> None:
    report = json.loads(referee_assistant_reply(_request("no followups or citations block here")))
    assert report["followups"] == []
    assert report["citations"] == []


def test_referee_assistant_reply_treats_a_bare_none_citations_line_as_no_citations() -> None:
    text = "Finding citations:\nnone\n\nApplicability triggers:\nnone"
    report = json.loads(referee_assistant_reply(_request(text)))
    assert report["citations"] == []
