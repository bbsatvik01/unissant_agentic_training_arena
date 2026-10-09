"""D11 byte bounds: questions and answers are bounded after normalization, model fields are repaired when their
rendered text exceeds the byte cap, and every dev family's worst case fits every call kind (S2 2, O-10)."""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from arena_core.agents import budget
from arena_core.agents.budget import (
    INPUT_LIMITS,
    REPAIR_BYTES,
    max_context,
    over_limit,
    question_fill,
    request_bytes,
    worst_view,
)
from arena_core.agents.coach_prompts import Prompt
from arena_core.agents.referee_prompts import FindingProjection, FollowUpLine
from arena_core.agents.repair import output_errors
from arena_core.agents.subject_prompts import SubjectPacket, SubjectTurnState, build_subject_prompt
from arena_core.agents.untrusted import (
    QUESTION_MAX_BYTES,
    QUESTION_MAX_CHARS,
    TextTooLongError,
    check_question,
    clean,
    clean_lines,
    rendered_bytes,
)
from arena_core.agents.views import TranscriptTurn, public_case
from arena_core.contracts.citations import quote_ok
from arena_core.contracts.coaching import CoachingCard, FinalFinding
from arena_core.contracts.common import MAX_TURNS
from arena_core.contracts.findings import InvestigatorFinding
from arena_core.contracts.review import MAX_TRIGGERS
from arena_core.contracts.routes import TurnSubmit
from arena_core.contracts.subject import SubjectTurn
from arena_core.providers.structured import sent_schema
from arena_core.scenario.content import content_text
from arena_core.scenario.validators import validate_family

from . import fixtures as fx
from .test_coach_outputs import CTX7, good_card

FAMILIES = [f"F0{k}" for k in range(1, 10)]
EXPANDING = "ﷺ" * 599 + "?"  # 600 characters, 19,768 UTF-8 bytes once NFKC-normalized


def test_an_expanding_question_is_refused_before_it_reaches_a_prompt() -> None:
    assert len(EXPANDING) == QUESTION_MAX_CHARS
    assert rendered_bytes(EXPANDING) > 8 * QUESTION_MAX_BYTES
    with pytest.raises(TextTooLongError, match="question: 10783 characters as rendered"):
        check_question(EXPANDING)
    with pytest.raises(ValueError, match="as rendered"):
        TranscriptTurn(turn_no=1, question=EXPANDING, answer="Yes.")
    with pytest.raises(ValueError, match="as rendered"):
        SubjectTurnState(n=1, transcript=[], question=EXPANDING, released={}, opened_gates={}, first_disclosed={})
    with pytest.raises(ValueError, match="as rendered"):
        FollowUpLine(turn_id="t01", tactic=None, question=EXPANDING)
    # Few characters that expand past the character cap (U+2167 is "VIII"): the stored text is the rendered form.
    with pytest.raises(TextTooLongError, match="801 characters as rendered"):
        check_question("\u2167" * 200 + "?")
    with pytest.raises(TextTooLongError, match="empty as rendered"):
        check_question("\u200b")


def test_the_question_bounds_are_600_characters_and_2400_bytes_as_rendered() -> None:
    # S2 1, 2: 600 characters of 4 bytes is a valid question.
    assert check_question("\U00020000" * 599 + "?")
    assert rendered_bytes(question_fill()) == QUESTION_MAX_BYTES
    assert check_question(question_fill()) == question_fill()
    with pytest.raises(TextTooLongError, match="601 characters"):
        check_question("a" * 601)


def test_an_expanding_answer_is_refused() -> None:
    with pytest.raises(ValueError, match=r"answer: 1800 characters as rendered, more than 900"):
        TranscriptTurn(turn_no=1, question="What happened?", answer="ﷺ" * 100)


@pytest.mark.parametrize(
    ("path", "value", "message"),
    [
        (("finding", "rationale"), "\ufdfa" * 300, "longer than 600 characters as rendered"),
        (("flags", 0, "missing_fact"), "\ufdfa" * 30, "longer than 120 characters as rendered"),
        (("follow_up", "question"), "\ufdfa" * 100, "longer than 300 characters as rendered"),
        # Within every raw cap (600 characters, 1,200 bytes) but 1,500 bytes once backslashes are escaped.
        (("finding", "rationale"), "\u4e00" * 300 + "\\" * 300, "longer than 1200 bytes as rendered (D11)"),
        (("follow_up", "purpose"), "\u200b", "empty as rendered"),
    ],
)
def test_a_model_field_that_breaks_its_caps_as_rendered_is_repaired(
    path: tuple[Any, ...], value: str, message: str
) -> None:
    card = copy.deepcopy(good_card())
    node: Any = card
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    parsed, errors = output_errors(CoachingCard, json.dumps(card), CTX7)
    assert parsed is None
    assert errors == [f"{'.'.join(str(p) for p in path)}: {message}"]


def test_an_expanding_subject_answer_is_repaired() -> None:
    utterance = ("o\ufb03cial " * 110).strip()  # 769 characters, 989 once the ligature is unfolded
    tag = {"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []}
    parsed, errors = output_errors(SubjectTurn, json.dumps({"utterance": utterance, "tag": tag}))
    assert parsed is None
    assert errors == ["utterance: longer than 900 characters as rendered"]


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
    body = {"question": "\u2167" * 200 + "?", "release_ids": [], "expected_version": 0}
    body["idem_key"] = "00000000-0000-4000-8000-000000000001"
    with pytest.raises(ValueError, match="801 characters as rendered"):
        TurnSubmit.model_validate(body)
    ok = TurnSubmit.model_validate({**body, "question": question_fill()})
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
    with pytest.raises(ValueError, match="characters as rendered"):
        InvestigatorFinding.model_validate(raw)
    with pytest.raises(ValueError, match="characters as rendered"):
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


@pytest.mark.parametrize(
    ("path", "value"),
    [(("flags", 0, "missing_fact"), "  x  "), (("finding", "corroboration_needed", 0), "  y  ")],
)
def test_a_field_shorter_than_its_minimum_as_rendered_is_repaired(path: tuple[Any, ...], value: str) -> None:
    card = copy.deepcopy(good_card())
    node: Any = card
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    _, errors = output_errors(CoachingCard, json.dumps(card), CTX7)
    assert errors == [f"{'.'.join(str(p) for p in path)}: shorter than 3 characters as rendered"]


def test_an_alternative_explanation_shorter_than_three_characters_as_rendered_is_repaired() -> None:
    final = {"schema_version": "final.v1", "finding": good_card()["finding"], "alternative_explanations": [" z "]}
    _, errors = output_errors(FinalFinding, json.dumps(final), CTX7)
    assert errors == ["alternative_explanations.0: shorter than 3 characters as rendered"]


def test_the_word_limit_applies_to_the_rendered_answer() -> None:
    utterance = "\ufdfa " * 31  # 31 words as typed, 124 once normalized
    tag = {"disclosed": [], "withheld": [], "uncertainty_used": [], "behavior": "responsive", "gates_opened": []}
    _, errors = output_errors(SubjectTurn, json.dumps({"utterance": utterance.strip(), "tag": tag}))
    assert errors == ["utterance: more than 120 words (V1)"]


def test_a_record_the_renderer_would_change_is_refused_at_authoring() -> None:
    family = copy.deepcopy(fx.family("F01"))
    for role in ("truthful", "deceptive"):
        for doc in family["variants"][role]["public_packet"]["initial_documents"]:
            if doc["doc_id"] == "doc-01":
                doc["content"]["body"] = doc["content"]["body"].replace("Generated", "Gener­ated")
        for art in family["variants"][role]["evaluator_packet"]["evidence_artifacts"]:
            if art["artifact_id"] == "doc-01":
                art["content"]["body"] = art["content"]["body"].replace("Generated", "Gener­ated")
    # The path the check closes: the coach quotes the record as shown, and the quote rule reads the stored text.
    stored = content_text(family["variants"]["deceptive"]["public_packet"]["initial_documents"][0]["content"])
    shown = clean_lines(stored)
    assert not quote_ok("Generated 16:00 by the end-of-day roster check", stored)
    assert quote_ok("Generated 16:00 by the end-of-day roster check", shown)
    issues = [(i.variant, i.message) for i in validate_family(family) if i.rule == "V1d.canonical"]
    message = "doc-01: the rendered text differs from the stored text"
    # Each variant holds doc-01 twice: its evaluator artifact and its public initial document.
    assert issues == [("truthful", message)] * 2 + [("deceptive", message)] * 2


def _codex_f02() -> dict[str, Any]:
    """F02 with author text at the caps where it reaches the subject's ledger (a validator-accepted family)."""
    family = copy.deepcopy(fx.family("F02"))
    for role in ("truthful", "deceptive"):
        variant = family["variants"][role]
        variant["private_packet"]["persona"]["background"] = "ﷺ" * 400
        position = "ﷺ" * 49 + "x" * 31
        variant["private_packet"]["persona"]["position"] = position
        variant["public_packet"]["interview_context"]["subject"]["position"] = position
    return family


@pytest.mark.parametrize("family", [fx.family("F02"), _codex_f02()], ids=["F02", "F02-at-caps"])
def test_the_subject_estimate_bounds_every_gate_status_combination(family: dict[str, Any]) -> None:
    variant = family["variants"]["deceptive"]
    packet = SubjectPacket.from_private_packet(variant["private_packet"], split="dev")
    estimate = max_context(family, "deceptive")["subject"]
    gates = [g.id for g in packet.gates]
    prompts = fx.prompts("S3")
    for mask in range(2 ** len(gates)):
        opened = {g for i, g in enumerate(gates) if mask >> i & 1}
        for released in (True, False):
            state = budget._subject_state(packet, variant, opened)
            if not released:
                state = state.model_copy(update={"released": {}})
            prompt = build_subject_prompt(packet, state, prompts, salt=budget.SALT)
            assert budget._sized(prompts, "subject", prompt) <= estimate


def test_the_trigger_population_is_the_legal_maximum() -> None:
    entries = budget._triggers()
    assert len(entries) == MAX_TRIGGERS
    for e in entries:
        start = max(e.trigger_turns, default=1)
        assert e.question_turns == list(range(start, start + len(e.question_turns)))
        assert e.question_turns[-1] <= MAX_TURNS
        limit = {"2a": 2, "3c": 3, "4b": 3}.get(e.subcheck_id)
        assert len(e.question_turns) == min(limit or MAX_TURNS, MAX_TURNS - start + 1)


def test_an_authored_question_the_runtime_cannot_commit_is_refused() -> None:
    family = copy.deepcopy(fx.family("F01"))
    for role in ("truthful", "deceptive"):
        family["variants"][role]["public_packet"]["opening_question"] = "Can you describe " + "Ⅷ" * 200 + "?"
    issues = [(i.variant, i.message) for i in validate_family(family) if i.rule == "V1c.question"]
    assert [v for v, _ in issues] == ["truthful", "deceptive"]
    assert "row 1 cannot be committed: question: 818 characters as rendered" in issues[0][1]
    assert [i for i in validate_family(fx.family("F01")) if i.rule == "V1c.question"] == []
