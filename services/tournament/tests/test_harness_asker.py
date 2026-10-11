"""`HarnessAsker`/`CorpusAsker` against a real `Orchestrator` on `FakeArenaDb` (`packages.core.tests.turns.
test_orchestrator.Rig`, the same double the orchestrator's own suite uses): the three `ask()` stop paths,
`card()`'s budget-stop and happy path, `final()`'s two failure paths, and `CorpusAsker`'s release/title
fallback -- the branches it_tournament.py's real-database happy path never reaches (budget refusals,
quarantine, a discarded card)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from arena_core.turns.harness import (
    BudgetStopError,
    HarnessQuestion,
    QuestionSource,
    SubjectStopError,
    TransientStopError,
)
from arena_core.turns.orchestrator import SubjectUnavailableError
from arena_tournament.harness_asker import CorpusAsker, HarnessAsker
from packages.core.tests.turns.fakedb import PACKET
from packages.core.tests.turns.test_orchestrator import Rig

QUESTION = HarnessQuestion(text="What did you do in B-12?", source=QuestionSource.HARNESS_FIXED)


def test_ask_records_the_question_and_answer_on_the_happy_path() -> None:
    rig = Rig()
    HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])
    assert rig.kinds() == ["question_recorded", "subject_turn"]


def test_ask_raises_subjectstoperror_on_a_quarantined_answer() -> None:
    rig = Rig()
    rig.quarantine = True
    with pytest.raises(SubjectStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])


def test_ask_raises_budgetstoperror_when_the_subject_call_is_budget_refused() -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("budget_refused")
    with pytest.raises(BudgetStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])


def test_ask_raises_transientstoperror_and_stops_the_trial_on_an_infra_failure() -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("subject_unavailable")
    with pytest.raises(TransientStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])
    assert rig.db.execution_state == "infra_failed"


def test_ask_raises_budgetstoperror_when_the_subjects_kill_switch_is_on() -> None:
    """ST-4 groups the kill switch with a budget refusal ("the per-call spend guard refused a reservation,
    or the kill switch is on"): a real bug (Codex round 1) had this fall through to the generic
    TurnRefusedError handler instead, recording infra_failed (ST-5, retriable) rather than budget_truncated."""
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("kill_switch_on")
    with pytest.raises(BudgetStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])
    assert rig.db.execution_state == "budget_truncated"


def test_card_raises_budgetstoperror_once_the_trial_is_already_budget_truncated() -> None:
    rig = Rig()
    HarnessAsker(rig.db.trial_id, rig.orch).ask(1, QUESTION, [])
    rig.db.execution_state = "budget_truncated"
    with pytest.raises(BudgetStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).card(1)


def test_card_returns_the_real_follow_up_question_on_the_happy_path() -> None:
    rig = Rig()
    asker = HarnessAsker(rig.db.trial_id, rig.orch)
    asker.ask(1, QUESTION, [])
    card = asker.card(1)
    assert card is not None
    assert card.question


def test_final_raises_budgetstoperror_when_the_final_call_is_budget_refused() -> None:
    rig = Rig()
    rig.turn()  # one completed exchange first: PublicTrialView needs exchange >= 1
    rig.budget.ceiling_usd = Decimal(0)  # drain the budget for the final call specifically
    with pytest.raises(BudgetStopError):
        HarnessAsker(rig.db.trial_id, rig.orch).final()
    assert rig.db.execution_state == "budget_truncated"


def test_final_returns_true_and_commits_on_the_happy_path() -> None:
    rig = Rig()
    rig.turn()
    assert HarnessAsker(rig.db.trial_id, rig.orch).final() is True
    assert rig.db.status == "finalized"


def test_corpus_asker_release_returns_nothing_when_no_record_was_due() -> None:
    rig = Rig()
    asker = CorpusAsker(rig.db.trial_id, rig.orch, PACKET)
    assert asker.release(1, []) == []


def test_corpus_asker_release_returns_the_released_record_with_its_title() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()  # two exchanges: rec-01 (on_request, after_exchanges=2) is now releasable
    asker = CorpusAsker(rig.db.trial_id, rig.orch, PACKET)
    released = asker.release(3, ["rec-01"])
    assert [r.record_id for r in released] == ["rec-01"]
    expected_title = next(r["title"] for r in PACKET["requestable_records"] if r["record_id"] == "rec-01")
    assert released[0].title == expected_title


def test_corpus_asker_ask_records_the_question_with_no_releases() -> None:
    rig = Rig()
    asker = CorpusAsker(rig.db.trial_id, rig.orch, PACKET)
    asker.ask(1, QUESTION)
    assert rig.kinds()[-2:] == ["question_recorded", "subject_turn"]
