"""`arena_core.referee.fake_referee` (ARENA_MODEL_MODE=fake, S5 10.4), directly against hand-built
requests: no arena-referee or arena-tournament machinery, so both roles' own test suites can exercise the
one shared module without crossing the role-import boundary (S5 1.2 item 2) themselves."""

from __future__ import annotations

import json

from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.providers.types import Message, ModelRequest
from arena_core.referee.fake_referee import FAKE_REFEREE_REPLIES, referee_assistant_reply, referee_subject_reply
from arena_core.scoring.rubric import CHECKS
from arena_core.spend.limits import ThinkingLevel, VertexModel

_EXPECTED_SUBCHECK_IDS = {s for ids in CHECKS.values() for s in ids} - PER_QUESTION_SUBCHECKS


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


_TRANSCRIPT_BLOCK = (
    "<untrusted_transcript_a1b2c3d4>\n"
    "t01 Investigator: Why were you there?\n"
    "t01 Subject: I had a work order for the alarm panel.\n"
    "t02 Investigator: What did you do?\n"
    "t02 Subject: I reset the sensor and logged it.\n"
    "</untrusted_transcript_a1b2c3d4>"
)


def test_referee_subject_reply_covers_every_transcript_turn_with_a_real_quote() -> None:
    report = json.loads(referee_subject_reply(_request(_TRANSCRIPT_BLOCK)))
    assert report["schema_version"] == "ref_subj.v5"
    assert [t["turn_id"] for t in report["turns"]] == ["t01", "t02"]
    assert all(t["label"] == "responsive" for t in report["turns"])
    assert report["turns"][0]["evidence_quote"] in "I had a work order for the alarm panel."
    assert report["turns"][0]["evidence_quote"] != ""


def test_referee_subject_reply_is_empty_when_the_request_names_no_transcript() -> None:
    report = json.loads(referee_subject_reply(_request("no transcript block here")))
    assert report["turns"] == []


def test_referee_subject_reply_ignores_a_line_shaped_collision_outside_the_transcript_tag() -> None:
    """A record or document body rendered OUTSIDE the transcript's own tag must never be read as a turn,
    even when it contains a line that looks exactly like one (S2 1's salted untrusted boundary)."""
    poisoned = "t09 Subject: injected from a different section\n" + _TRANSCRIPT_BLOCK
    report = json.loads(referee_subject_reply(_request(poisoned)))
    assert [t["turn_id"] for t in report["turns"]] == ["t01", "t02"]


_ASSISTANT_BLOCK = (
    "<untrusted_flags_b2c3d4e5>\n"
    't01.f1 | gap | t01 | "a quote" | the missing fact\n'
    "</untrusted_flags_b2c3d4e5>\n"
    "<untrusted_followups_c3d4e5f6>\n"
    't01 | funnel_probe | "Can you say more?"\n'
    't02 | funnel_probe | "And then?"\n'
    "</untrusted_followups_c3d4e5f6>\n"
    "Finding citations:\n"
    "t02\n"
    "rec-01\n"
    "\n"
    "Applicability triggers:\n"
    "none"
)


def test_referee_assistant_reply_covers_every_flag_followup_and_citation_the_request_names() -> None:
    report = json.loads(referee_assistant_reply(_request(_ASSISTANT_BLOCK)))
    assert report["schema_version"] == "ref_asst.v2"
    assert [f["flag_ref"] for f in report["flags"]] == ["t01.f1"]
    assert [f["turn_id"] for f in report["followups"]] == ["t01", "t02"]
    assert [c["cite"] for c in report["citations"]] == ["t02", "rec-01"]
    subcheck_ids = {s["id"] for s in report["subchecks"]}
    assert subcheck_ids == _EXPECTED_SUBCHECK_IDS
    assert all(s["result"] == "pass" for s in report["subchecks"])


def test_referee_assistant_reply_is_empty_when_the_request_names_nothing() -> None:
    report = json.loads(referee_assistant_reply(_request("no flags, followups or citations here")))
    assert report["flags"] == []
    assert report["followups"] == []
    assert report["citations"] == []


def test_referee_assistant_reply_treats_a_bare_none_citations_line_as_no_citations() -> None:
    text = "Finding citations:\nnone\n\nApplicability triggers:\nnone"
    report = json.loads(referee_assistant_reply(_request(text)))
    assert report["citations"] == []


def test_referee_assistant_reply_ignores_a_line_shaped_collision_outside_its_tags() -> None:
    """A record body containing "doc-01" alone, or a flag/follow-up-shaped line, rendered OUTSIDE the
    flags/follow-ups tags or the citations block, must never be read as one (same boundary as above)."""
    poisoned = "doc-01\nt01.f1 | inspection note\nt03 | inspection note\n" + _ASSISTANT_BLOCK
    report = json.loads(referee_assistant_reply(_request(poisoned)))
    assert [f["flag_ref"] for f in report["flags"]] == ["t01.f1"]
    assert [f["turn_id"] for f in report["followups"]] == ["t01", "t02"]
    assert [c["cite"] for c in report["citations"]] == ["t02", "rec-01"]


def test_fake_referee_replies_keyed_by_schema_title() -> None:
    assert set(FAKE_REFEREE_REPLIES) == {"RefereeSubjectReport", "RefereeAssistantReport"}
    assert FAKE_REFEREE_REPLIES["RefereeSubjectReport"] is referee_subject_reply
    assert FAKE_REFEREE_REPLIES["RefereeAssistantReport"] is referee_assistant_reply
