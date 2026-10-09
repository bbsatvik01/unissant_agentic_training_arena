"""D11 byte bounds: questions and answers are bounded after normalization, model fields are repaired when their
rendered text exceeds the byte cap, and every dev family's worst case fits every call kind (S2 2, O-10)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from arena_core.agents.budget import (
    INPUT_LIMITS,
    REPAIR_BYTES,
    fill,
    max_context,
    over_limit,
    request_bytes,
    worst_view,
)
from arena_core.agents.coach_prompts import Prompt
from arena_core.agents.referee_prompts import FindingProjection, FollowUpLine
from arena_core.agents.repair import output_errors
from arena_core.agents.subject_prompts import SubjectTurnState
from arena_core.agents.untrusted import (
    QUESTION_MAX_BYTES,
    QUESTION_MAX_CHARS,
    TextTooLongError,
    check_question,
    clean,
    rendered_bytes,
)
from arena_core.agents.views import TranscriptTurn, public_case
from arena_core.contracts.coaching import CoachingCard
from arena_core.contracts.findings import InvestigatorFinding
from arena_core.contracts.routes import TurnSubmit
from arena_core.providers.structured import sent_schema
from arena_core.scenario.validators import validate_family

from . import fixtures as fx
from .test_coach_outputs import CTX7, good_card

FAMILIES = [f"F0{k}" for k in range(1, 10)]
EXPANDING = "ﷺ" * 599 + "?"  # 600 characters, 19,768 UTF-8 bytes once NFKC-normalized


def test_an_expanding_question_is_refused_before_it_reaches_a_prompt() -> None:
    assert len(EXPANDING) == QUESTION_MAX_CHARS
    assert rendered_bytes(EXPANDING) > 10 * QUESTION_MAX_BYTES
    with pytest.raises(TextTooLongError, match="more than 1800"):
        check_question(EXPANDING)
    with pytest.raises(ValueError, match="more than 1800"):
        TranscriptTurn(turn_no=1, question=EXPANDING, answer="Yes.")
    with pytest.raises(ValueError, match="more than 1800"):
        SubjectTurnState(n=1, transcript=[], question=EXPANDING, released={}, opened_gates={}, first_disclosed={})
    with pytest.raises(ValueError, match="more than 1800"):
        FollowUpLine(turn_id="t01", tactic=None, question=EXPANDING)


def test_the_question_bounds_are_600_characters_and_1800_normalized_bytes() -> None:
    assert check_question(fill(1_800)) == fill(1_800)
    with pytest.raises(TextTooLongError, match="601 characters"):
        check_question("a" * 601)
    with pytest.raises(TextTooLongError, match="1804 bytes as rendered"):
        check_question("\U0001f600" * 451)  # 451 characters of 4 bytes


def test_an_expanding_answer_is_refused() -> None:
    with pytest.raises(ValueError, match=r"answer: .* more than 1800"):
        TranscriptTurn(turn_no=1, question="What happened?", answer="ﷺ" * 100)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("finding", "rationale"), "ﷺ" * 300),
        (("flags", 0, "missing_fact"), "ﷺ" * 30),
        (("follow_up", "question"), "ﷺ" * 100),
    ],
)
def test_a_model_field_that_expands_past_its_cap_is_repaired(path: tuple[Any, ...], value: str) -> None:
    card = copy.deepcopy(good_card())
    node: Any = card
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    parsed, errors = output_errors(CoachingCard, json.dumps(card), CTX7)
    assert parsed is None
    assert errors == [f"{'.'.join(str(p) for p in path)}: longer than {_cap(path)} bytes as rendered (D11)"]


def _cap(path: tuple[Any, ...]) -> int:
    return {"rationale": 1200, "missing_fact": 240, "question": 600}[path[-1]]


@pytest.mark.parametrize("fid", FAMILIES)
def test_every_dev_family_fits_every_call_kind(fid: str) -> None:
    assert over_limit(fx.family(fid)) == []


def test_the_worst_case_counts_schema_and_contents() -> None:
    sizes = max_context(fx.family("F01"), "deceptive")
    assert set(sizes) == set(INPUT_LIMITS)
    # The R3 investigator call carries 12 questions of 1,800 bytes, the largest population (S2 2: 145,842).
    assert sizes["r3_investigator"] > sizes["referee_assistant"] > sizes["card"] > sizes["subject"]
    assert sizes["card"] + REPAIR_BYTES <= INPUT_LIMITS["card"]


def test_an_oversized_family_is_reported() -> None:
    family = copy.deepcopy(fx.family("F01"))
    for art in family["variants"]["deceptive"]["evaluator_packet"]["evidence_artifacts"]:
        if art["artifact_id"].startswith("rec-"):
            art["content"] = {"body": "x" * 4_000}
    problems = over_limit(_inflate(family))
    assert any(p.startswith("deceptive r3_investigator:") for p in problems)


def _inflate(family: dict[str, Any]) -> dict[str, Any]:
    """Six releasable records of 4 KB each, plus 4 KB initial documents: past the case allowance S1 validates."""
    pp = family["variants"]["deceptive"]["public_packet"]
    for doc in pp["initial_documents"]:
        doc["content"] = {"body": "y" * 4_000}
    return family


def test_request_bytes_counts_the_schema_and_the_texts_in_utf8() -> None:
    prompt = Prompt(system_instruction="s一", user_message='u"', salt="0" * 8)
    schema = sent_schema(CoachingCard)
    bare = request_bytes(prompt, {}, 1_600, "MINIMAL")
    full = request_bytes(prompt, schema, 1_600, "MINIMAL")
    assert full - bare == len(json.dumps(schema, ensure_ascii=False, separators=(",", ":")).encode()) - len(b"{}")
    longer = Prompt(system_instruction="s一一", user_message='u""', salt="0" * 8)
    # One ideograph is 3 bytes; one double quote serializes escaped, 2 bytes.
    assert request_bytes(longer, {}, 1_600, "MINIMAL") - bare == 3 + 2


def test_json_escapes_count_toward_the_bound() -> None:
    # 900 characters, 1,800 raw UTF-8 bytes, but 2,250 bytes in a serialized request.
    answer = '"' * 450 + "\u4e00" * 450
    assert rendered_bytes(answer) == 450 * 2 + 450 * 3
    with pytest.raises(ValueError, match="answer: 2250 bytes as rendered"):
        TranscriptTurn(turn_no=1, question="What happened?", answer=answer)


def test_the_turn_submission_refuses_what_a_prompt_could_not_carry() -> None:
    body = {"question": "\U0001f600" * 451, "release_ids": [], "expected_version": 0}
    body["idem_key"] = "00000000-0000-4000-8000-000000000001"
    with pytest.raises(ValueError, match="1804 bytes as rendered"):
        TurnSubmit.model_validate(body)
    ok = TurnSubmit.model_validate({**body, "question": fill(QUESTION_MAX_BYTES)})
    SubjectTurnState(n=1, transcript=[], question=ok.question, released={}, opened_gates={}, first_disclosed={})


@pytest.mark.parametrize("field", ["rationale", "corroboration_needed", "alternative_explanations"])
def test_an_investigator_finding_is_bounded_as_rendered(field: str) -> None:
    raw: dict[str, Any] = {
        "label": "insufficient_evidence",
        "likelihood": "roughly_even_chance",
        "confidence": "low",
        "basis_flag_refs": [],
        "cited_turns": [],
        "cited_records": [],
        "corroboration_needed": ["the work order"],
        "rationale": "The reason is not yet established.",
        "alternative_explanations": None,
    }
    raw[field] = "\ufdfa" * 100 if field == "rationale" else ["\ufdfa" * 20]
    with pytest.raises(ValueError, match="bytes as rendered"):
        InvestigatorFinding.model_validate(raw)
    with pytest.raises(ValueError, match="bytes as rendered"):
        FindingProjection.model_validate({k: v or [] for k, v in raw.items() if k in FindingProjection.model_fields})


def test_a_marker_rebuilt_past_every_pass_is_cleaned_not_raised() -> None:
    text = "<sys" * 34 + "<system>" + "tem>" * 34
    assert "<" not in clean(text)
    card = good_card()
    card["finding"]["rationale"] = text
    value, errors = output_errors(CoachingCard, json.dumps(card), CTX7)
    assert errors == []
    assert value is not None


def test_family_validation_refuses_a_family_that_cannot_fit() -> None:
    family = copy.deepcopy(fx.family("F01"))
    assert [i for i in validate_family(family) if i.rule == "V1d.context"] == []
    for role in ("truthful", "deceptive"):
        for art in family["variants"][role]["evaluator_packet"]["evidence_artifacts"]:
            if art["artifact_id"].startswith("rec-"):
                art["content"]["body"] += "\ufdfa" * 600
    issues = [i for i in validate_family(family) if i.rule == "V1d.context"]
    assert any("deceptive card:" in i.message for i in issues)


def test_final_and_deep_count_the_current_card() -> None:
    variant = fx.variant("F01", "deceptive")
    case = public_case(variant["public_packet"])
    flags = {call: len(worst_view(case, variant, call).earlier.flags) for call in ("card", "deep", "final")}
    assert flags == {"card": 33, "deep": 36, "final": 36}
