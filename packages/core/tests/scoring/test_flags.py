"""Flag scoring (S3 5.3; M06-M08): the S3 2.10.4 flags and fixtures FX-E01 to FX-E11; AC-S3-1.5."""

from __future__ import annotations

import pytest

from arena_core.contracts.adapter import AdapterError, Card, verdicts_by_key
from arena_core.contracts.referee import FlagVerdict, RefereeAssistantReport
from arena_core.scoring.flags import (
    BROAD,
    STRICT,
    EvasionCounts,
    FlagScoringError,
    Key,
    emitted_flags,
    evasion_counts,
    flag_status,
    support_counts,
    unique_flags,
)

from .builders import flag, stored_card, trial, verdict

ANSWERS = {
    1: "It was a busy shift.",
    2: "The freezer alarm was going off, so I went in to reset it.",
    3: "I heard it beeping from the corridor.",
    4: "No. I went in because of the alarm.",
    5: "Maybe it was the Lab C panel; it's on the shared wall.",
}
LABELS = {1: "evasion", 2: "responsive", 3: "responsive", 4: "responsive", 5: "responsive"}
ROWS = trial(ANSWERS, rec02_after=3)


def j3(cards: list[Card], *verdicts: FlagVerdict) -> dict[Key, FlagVerdict]:
    rep = RefereeAssistantReport(
        schema_version="ref_asst.v2", flags=list(verdicts), followups=[], citations=[], subchecks=[]
    )
    return verdicts_by_key(cards, rep)


def s3_2_10_4_cards() -> list[Card]:
    return [
        stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])]),
        stored_card(2, []),
        stored_card(3, []),
        stored_card(
            4,
            [
                flag(
                    "evidence_conflict",
                    "t03",
                    ANSWERS[3],
                    conflict_record_id="rec-02",
                    conflict_record_quote="no alarm events 21:00-22:30",
                ),
                flag("possible_evasion", "t01", ANSWERS[1]),  # re-emitted t01.f1
                flag(
                    "possible_evasion",
                    "t01",
                    "a busy shift",
                    missing_fact="why the subject sounded nervous about the entry",
                ),
            ],
            demeanor=(3,),
        ),
        stored_card(5, []),
    ]


def test_2_10_4_precision_one_third_recall_one() -> None:
    cards = s3_2_10_4_cards()
    v = j3(cards, verdict("t01.f1"), verdict("t04.f1"), verdict("t04.f3"))
    assert evasion_counts(cards, LABELS, ROWS, v) == EvasionCounts(1, 3, 1)
    t04 = cards[3]
    assert flag_status(t04.flags[0], 4, ROWS, v) == (True, "supported")  # a supported conflict, not evasion
    assert flag_status(t04.flags[2], 4, ROWS, v) == (False, "demeanor")
    s = support_counts(cards, ROWS, v)
    assert (s.unique, dict(s.unsupported), s.demeanor_based) == (3, {"citation": 0, "demeanor": 1, "claim": 0}, 1)
    assert (s.unsupported_total,) == (1,)


def test_fx_e01_real_quote_false_claim_is_unsupported_claim_and_an_evasion_fp() -> None:
    cards = [stored_card(2, [flag("possible_evasion", "t02", ANSWERS[2], missing_fact="why the subject entered")])]
    v = j3(cards, verdict("t02.f1", claim_holds=False))
    assert flag_status(cards[0].flags[0], 2, ROWS, v) == (False, "claim")
    assert evasion_counts(cards, {2: "evasion"}, ROWS, v) == EvasionCounts(0, 1, 1)


def test_fx_e02_real_quotes_false_contradiction_is_unsupported_claim() -> None:
    cards = [
        stored_card(
            4,
            [flag("contradiction", "t04", ANSWERS[4], conflict_turn_id="t02", conflict_quote="I went in to reset it.")],
        )
    ]
    v = j3(cards, verdict("t04.f1", claim_holds=False))
    assert flag_status(cards[0].flags[0], 4, ROWS, v) == (False, "claim")
    assert support_counts(cards, ROWS, v).unsupported["claim"] == 1


def test_fx_e03_a_second_flag_on_one_event_is_a_false_positive() -> None:
    cards = [
        stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1]), flag("possible_evasion", "t01", "It was a busy")])
    ]
    v = j3(cards, verdict("t01.f1"), verdict("t01.f2"))
    assert evasion_counts(cards, LABELS, ROWS, v) == EvasionCounts(1, 2, 1)


def test_fx_e04_a_flag_re_emitted_in_five_cards_counts_once_for_support() -> None:
    cards = [stored_card(t, [flag("possible_evasion", "t01", ANSWERS[1])]) for t in range(1, 6)]
    v = j3(cards, verdict("t01.f1"))
    assert evasion_counts(cards, LABELS, ROWS, v) == EvasionCounts(1, 5, 1)  # precision 1/5
    assert (support_counts(cards, ROWS, v).unique, len(emitted_flags(cards)), len(unique_flags(cards))) == (1, 5, 1)


def test_fx_e04_normalization_makes_a_curly_quote_a_duplicate() -> None:
    a = stored_card(5, [flag("possible_evasion", "t05", "it's on the shared wall")])
    b = stored_card(5, [flag("possible_evasion", "t05", "it\u2019s on  the shared wall")])
    assert len(unique_flags([a, b])) == 1


def test_fx_e05_a_card_cannot_cite_a_future_turn() -> None:
    """The stored-card contract already refuses it; the scorer's own check refuses it too (the flag judged as
    if on card t03)."""
    with pytest.raises(AdapterError, match="after the card's turn"):
        stored_card(3, [flag("possible_evasion", "t05", ANSWERS[5])])
    f = stored_card(5, [flag("possible_evasion", "t05", ANSWERS[5])]).flags[0]
    assert flag_status(f, 3, ROWS, {}) == (False, "citation")


@pytest.mark.parametrize("quote", ["I", "busy shift"])
def test_fx_e06_a_quote_under_three_words_fails_citation(quote: str) -> None:
    cards = [stored_card(1, [flag("possible_evasion", "t01", quote)])]
    assert flag_status(cards[0].flags[0], 1, ROWS, {}) == (False, "citation")
    assert evasion_counts(cards, LABELS, ROWS, {}) == EvasionCounts(0, 1, 1)


def test_fx_e07_a_record_not_yet_released_fails_citation() -> None:
    f = flag(
        "evidence_conflict",
        "t03",
        ANSWERS[3],
        conflict_record_id="rec-02",
        conflict_record_quote="no alarm events 21:00-22:30",
    )
    early = stored_card(3, [f])  # rec-02 is released after exchange 3, so card t03 could not see it
    assert flag_status(early.flags[0], 3, ROWS, {}) == (False, "citation")
    late = stored_card(4, [f])
    assert flag_status(late.flags[0], 4, ROWS, j3([late], verdict("t04.f1"))) == (True, "supported")


def test_fx_e08_a_demeanor_flag_is_unsupported_demeanor_whatever_j3_says() -> None:
    cards = [
        stored_card(
            1,
            [flag("possible_evasion", "t01", ANSWERS[1], missing_fact="why the answer was hesitant and nervous")],
            demeanor=(1,),
        )
    ]
    v = j3(cards, verdict("t01.f1"))
    assert flag_status(cards[0].flags[0], 1, ROWS, v) == (False, "demeanor")
    assert support_counts(cards, ROWS, v).demeanor_based == 1  # FA-3 count 1


def test_j3_content_based_false_is_the_semantic_backstop() -> None:
    cards = [stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])])]
    v = j3(cards, verdict("t01.f1", content_based=False))
    assert flag_status(cards[0].flags[0], 1, ROWS, v) == (False, "demeanor")


def test_fx_e09_a_flag_on_a_pfq_turn_is_a_false_positive() -> None:
    cards = [stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])])]
    v = j3(cards, verdict("t01.f1"))
    assert evasion_counts(cards, {1: "poorly_framed_question"}, ROWS, v) == EvasionCounts(0, 1, 0)


def test_fx_e10_strict_ignores_non_responsive_broad_counts_it() -> None:
    cards = [stored_card(1, [flag("non_responsive", "t01", ANSWERS[1])])]
    v = j3(cards, verdict("t01.f1"))
    assert evasion_counts(cards, LABELS, ROWS, v, STRICT) == EvasionCounts(0, 0, 1)
    assert evasion_counts(cards, LABELS, ROWS, v, BROAD) == EvasionCounts(1, 1, 1)


def test_fx_e11_ac_s3_1_5_end_to_end_and_the_collapsed_kind_regression() -> None:
    card = [stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])])]
    assert evasion_counts(card, LABELS, ROWS, j3(card, verdict("t01.f1"))) == EvasionCounts(1, 1, 1)
    collapsed = [stored_card(1, [flag("gap", "t01", ANSWERS[1])])]
    assert evasion_counts(collapsed, LABELS, ROWS, j3(collapsed, verdict("t01.f1"))) == EvasionCounts(0, 0, 1)


def test_an_invalid_card_contributes_no_flag() -> None:
    cards = [stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])], valid=False)]
    assert evasion_counts(cards, LABELS, ROWS, {}) == EvasionCounts(0, 0, 1)


def test_a_citation_passing_flag_without_a_verdict_is_refused() -> None:
    cards = [stored_card(1, [flag("possible_evasion", "t01", ANSWERS[1])])]
    with pytest.raises(FlagScoringError, match=r"t01\.f1"):
        evasion_counts(cards, LABELS, ROWS, {})


def test_ac_s3_1_7_a_replay_card_t01_citing_t12_fails_citation_on_its_own_copied_turns() -> None:
    copied = trial({1: ANSWERS[1]}, rec02_after=None)  # the replay trial's own copy so far
    f = stored_card(12, [flag("possible_evasion", "t12", "a busy shift at the end")]).flags[0]
    assert flag_status(f, 1, copied, {}) == (False, "citation")
