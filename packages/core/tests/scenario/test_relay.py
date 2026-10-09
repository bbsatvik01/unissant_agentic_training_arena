"""S2 8.2 `relay_test.v1` and S2 8.6 `replay_script.v1` (the module V1c and the harness share)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from arena_core.scenario import relay

LINE_SEPARATOR = chr(0x2028)
PARAGRAPH_SEPARATOR = chr(0x2029)
RIGHT_QUOTE = chr(0x2019)
LEFT_DOUBLE, RIGHT_DOUBLE = chr(0x201C), chr(0x201D)
LEFT_SINGLE = chr(0x2018)
ZERO_WIDTH_SPACE = chr(0x200B)
REPLAY_ROWS = 12  # S2 8.6: twelve exchanges

NEUTRAL = [
    "What task required entry?",  # EX-2 follow-up
    "Did staff admit you to the building?",  # near-miss: "admit" alone is not "admit it"
    "What charges appear on the purchase card statement?",  # near-miss: not "press charges"
    "What did you do between 9 and 10?",  # "and" between numbers is not compound
    "Can you describe, in your own words, what you did at the Halvern Street Annex on the afternoon of 12 March 2026?",
    "Who else was present, or could confirm what you have described?",
    "Can you go through that period again, starting from the end and working backwards?",
]


@pytest.mark.parametrize("question", NEUTRAL)
def test_neutral_questions_pass(question: str) -> None:
    result = relay.relay_test(question)
    assert result.passed, result.reason
    assert result.question == question


@pytest.mark.parametrize(
    ("question", "reason"),
    [
        ("Why?", "too_short"),
        ("Where " + "exactly " * 40 + "were you?", "too_long"),
        ("Where were you. What next", "not_single_question"),
        ("Where were you? Who saw you?", "not_single_question"),
        ("Where were you at <b>noon</b>?", "markup"),
        ("Did you see the log at https://example.invalid today?", "markup"),
        ("Did you use the door_held override?", "markup"),
        ("Where were\nyou at noon?", "markup"),
        ("What does rec-03 show about the vault?", "identifier"),
        ("Why does fact f:12 matter to you?", "identifier"),
        ("Question: where were you at noon?", "not_addressed_to_subject"),
        ("Ask him whether the door was open?", "not_addressed_to_subject"),
        ("Do you think the subject should explain the gap?", "not_addressed_to_subject"),
        ("Do you think you should ask about the gap?", "not_addressed_to_subject"),
        ("Who was there and what did they do?", "compound"),
        ("You went into the vault that afternoon, didn't you?", "leading_tag"),
        ("You were there at noon, right?", "leading_tag"),
        ("Why did you lie to your supervisor about it?", "non_neutral:accusation"),
        ("Isn't it true that you held the door?", "non_neutral:leading"),
        ("Why do you seem so nervous about the door?", "non_neutral:demeanor"),
        ("Do you understand this is your last chance here?", "non_neutral:pressure"),
    ],
)
def test_each_failure_returns_its_reason(question: str, reason: str) -> None:
    assert relay.relay_test(question).reason == reason


def test_steps_run_in_spec_order() -> None:
    # A two-word question with a newline is too short before it is markup (R1 before R3).
    assert relay.relay_test("Why\nnot?").reason == "too_short"
    # Two question marks fail R2 before the identifier rule R4 is reached.
    assert relay.relay_test("What is rec-03? And rec-04?").reason == "not_single_question"
    # A compound tag question reports compound (R6 before R7).
    assert relay.relay_test("Who was there and what did they do, didn't they?").reason == "compound"


@pytest.mark.parametrize("separator", ["\r", LINE_SEPARATOR, PARAGRAPH_SEPARATOR])
def test_every_line_break_in_the_raw_string_is_markup(separator: str) -> None:
    assert relay.relay_test(f"Where were{separator}you at noon?").reason == "markup"


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [
        ('"Where were you at noon?"', "Where were you at noon?"),
        ("'Where were you at noon?'", "Where were you at noon?"),
        (f"{LEFT_DOUBLE}Where were you at noon?{RIGHT_DOUBLE}", "Where were you at noon?"),
        (f"{LEFT_SINGLE}Where were you at noon?{RIGHT_QUOTE}", "Where were you at noon?"),
        ("  Where   were\tyou at noon?  ", "Where were you at noon?"),
        (f"Where were{ZERO_WIDTH_SPACE} you at noon?", "Where were you at noon?"),
    ],
)
def test_normalization_strips_quotes_hidden_characters_and_extra_space(raw: str, normalized: str) -> None:
    result = relay.relay_test(raw)
    assert result.passed
    assert result.question == normalized


def test_typographic_apostrophes_cannot_bypass_the_lexicon_or_tag_rule() -> None:
    assert relay.relay_test(f"Isn{RIGHT_QUOTE}t it true that you held the door?").reason == "non_neutral:leading"
    assert relay.relay_test(f"You held the door, didn{RIGHT_QUOTE}t you?").reason == "leading_tag"
    # The relayed text keeps the author's apostrophe; only the matching copy is folded.
    result = relay.relay_test(f"What didn{RIGHT_QUOTE}t you see at the door?")
    assert result.passed
    assert RIGHT_QUOTE in result.question


def test_repeat_ignores_case_punctuation_and_spacing() -> None:
    asked = ["What happened next?"]
    assert relay.relay_test("what happened, next?", asked).reason == "repeat"
    assert relay.relay_test("What   happened next?", [f"What happened{ZERO_WIDTH_SPACE} next?"]).reason == "repeat"
    assert relay.relay_test("What happened after that?", asked).passed


def test_repeat_key_collapses_whitespace_left_by_removed_punctuation() -> None:
    assert relay.repeat_key("Was it B - 12?") == relay.repeat_key("was it b 12")


def test_replay_script_renders_twelve_rows_from_the_public_packet() -> None:
    rows = relay.render_replay_script("Can you describe what you did?", ["topic one", "topic two", "topic three"])
    assert len(rows) == len(relay.REPLAY_SCRIPT) == REPLAY_ROWS
    assert rows[0] == "Can you describe what you did?"
    assert rows[3] == "Can you tell me about topic one?"
    assert rows[4] == "What was the purpose of topic one?"
    assert rows[6] == "Can you tell me about topic two?"
    assert rows[8] == "Can you tell me about topic three?"
    assert rows[9] == "Is there anything about topic one you have not mentioned yet?"
    assert rows[10] == "Earlier you described topic one. Is there anything you would like to add or correct?"


@pytest.mark.parametrize("topics", [[], ["a"], ["a", "b"], ["a", "b", "c", "d"]])
def test_replay_script_needs_exactly_three_topics(topics: list[str]) -> None:
    with pytest.raises(ValueError, match="exactly 3 replay topics"):
        relay.render_replay_script("Can you describe what you did?", topics)


def test_evidence_slot_question_uses_the_date_only_when_listed() -> None:
    assert relay.evidence_slot_question("Incident ticket INC-1", "2026-03-13") == (
        "We have Incident ticket INC-1, dated 2026-03-13. Can you tell me about it?"
    )
    assert relay.evidence_slot_question("Seal audit") == "We have Seal audit. Can you tell me about it?"


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03"])
def test_every_seed_script_and_slot_question_passes_in_order(
    family_id: str, seed: Callable[[str], dict[str, Any]]
) -> None:
    """AT-HAR-5 / AC-S1-27 on the seeds: the script in order with the repeat rule, then every slot question."""
    family = seed(family_id)
    public = family["variants"]["truthful"]["public_packet"]
    asked: list[str] = []
    for question in relay.render_replay_script(public["opening_question"], public["replay_topics"]):
        assert relay.relay_test(question, asked).passed, question
        asked.append(question)
    dates = {r["record_id"]: r.get("date") for r in public["requestable_records"]}
    artifacts = family["variants"]["truthful"]["evaluator_packet"]["evidence_artifacts"]
    for artifact in artifacts:
        if artifact["release"]["type"] != "initial":
            question = relay.evidence_slot_question(artifact["title"], dates.get(artifact["artifact_id"]))
            assert relay.relay_test(question, asked).passed, question


QUOTES = ("'", '"', LEFT_SINGLE + RIGHT_QUOTE, chr(0x201C) + chr(0x201D))


@pytest.mark.parametrize("quote", QUOTES)
@pytest.mark.parametrize(
    ("group", "phrase"), [(group, phrase) for group, phrases in relay.NEUTRALITY_LEXICON.items() for phrase in phrases]
)
def test_a_quoted_lexicon_term_is_still_a_whole_word(quote: str, group: str, phrase: str) -> None:
    """R8 'whole words or phrases': quotation marks around a term are a word boundary, not a disguise."""
    opening, closing = quote[0], quote[-1]
    result = relay.relay_test(f"Did you hear the words {opening}{phrase}{closing} at the door?").reason
    assert result == f"non_neutral:{group}"


@pytest.mark.parametrize("phrase", ["jail", "prison"])
def test_a_possessive_lexicon_term_is_still_a_whole_word(phrase: str) -> None:
    assert relay.relay_test(f"Was the {phrase}'s door open?").reason == "non_neutral:pressure"


def test_no_lexicon_term_is_a_contraction_tail() -> None:
    """Apostrophes are boundaries, which is safe only while no term is what follows a contraction's apostrophe."""
    tails = {"s", "t", "d", "ll", "re", "ve", "m"}
    assert not tails & {p for phrases in relay.NEUTRALITY_LEXICON.values() for p in phrases}
    assert relay.relay_test("What didn't you see at the door that you'd expected?").passed
