"""A voice session's stored exchanges as question-and-answer turns (UI v2 amendment to D7)."""

from __future__ import annotations

from arena_core.contracts.rendered import ANSWER_MAX_CHARS, QUESTION_MAX_CHARS, check_answer, check_question
from arena_core.voice.transcript import turns_through, voice_turns


def _ex(no: int, *lines: tuple[str, str, bool]) -> dict[str, object]:
    return {"exchange_no": no, "lines": [{"role": r, "text": t, "partial": p} for r, t, p in lines]}


def test_each_window_with_a_question_and_an_answer_is_one_turn_numbered_in_order() -> None:
    turns = voice_turns(
        [
            _ex(3, ("investigator", "And then?", False), ("subject", "I left.", True)),
            _ex(1, ("subject", "Hello?", False)),
            _ex(
                2,
                ("investigator", "Where   were", False),
                ("investigator", "you?", False),
                ("subject", "Home.", False),
            ),
            _ex(4, ("investigator", "Anything else?", False)),
        ]
    )
    assert turns == [
        {"turn_no": 1, "exchange_no": 2, "question": "Where were you?", "answer": "Home.", "partial": False},
        {"turn_no": 2, "exchange_no": 3, "question": "And then?", "answer": "I left.", "partial": True},
    ]


def test_long_or_wide_speech_is_cut_at_a_word_to_the_typed_bounds() -> None:
    wide = "\U0001f600 " * 700  # every character escapes to many bytes
    turns = voice_turns([_ex(1, ("investigator", wide, False), ("subject", "word " * 500, False))])
    (turn,) = turns
    assert len(turn["question"]) <= QUESTION_MAX_CHARS
    assert len(turn["answer"]) <= ANSWER_MAX_CHARS
    assert check_question(turn["question"]) == turn["question"]
    assert check_answer(turn["answer"]) == turn["answer"]
    assert turn["answer"].endswith("word")


def test_no_exchanges_no_turns() -> None:
    assert voice_turns([]) == []
    assert voice_turns([{"exchange_no": 1, "lines": None}]) == []


def test_a_release_boundary_in_windows_becomes_one_in_turns() -> None:
    turns = [{"exchange_no": 2}, {"exchange_no": 3}, {"exchange_no": 5}]
    assert [turns_through(turns, k) for k in range(7)] == [0, 0, 1, 2, 2, 3, 3]
