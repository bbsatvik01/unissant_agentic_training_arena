"""S2 8 interviewer harness: relay fixtures (AT-HAR-1, 2), fallbacks (AT-HAR-3), stop rules (AT-HAR-4),
the replay corpus loop (AT-HAR-5) and independence from subject text (AT-HAR-6)."""

from __future__ import annotations

import inspect
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from arena_core import fixtures
from arena_core.fixtures import injection
from arena_core.scenario import relay
from arena_core.scenario.load import read_family_file
from arena_core.scenario.relay import ReleasedRecord
from arena_core.turns import harness
from arena_core.turns.harness import (
    BudgetStopError,
    Card,
    Execution,
    HarnessQuestion,
    QuestionSource,
    SubjectStopError,
    TransientStopError,
)

REPO = Path(__file__).resolve().parents[4]
SPEC_S2 = REPO / "docs" / "spec" / "S2-agents-and-prompts.md"
OPENING = "Can you describe, in your own words, what you did that afternoon?"
FIXTURE_SIZE = 60
MIN_PER_REASON = 5
EXCHANGES = 12
CARD_SEQ_BASE = 100


def spec_section(number: str) -> str:
    return re.split(r"\n#{2,3} ", SPEC_S2.read_text(encoding="utf-8").split(f"### {number} ", 1)[1], maxsplit=1)[0]


# ---------------------------------------------------------------- relay fixtures and lexicons


def test_at_har_1_every_neutral_question_passes() -> None:
    questions = fixtures.load("fx_relay_neutral")["questions"]
    assert len(questions) == len(set(questions)) == FIXTURE_SIZE
    for q in (
        "What task required entry?",
        "Did staff admit you to the building?",
        "What charges appear on the purchase card statement?",
    ):
        assert q in questions
    assert [(q, r.reason) for q in questions if not (r := relay.relay_test(q)).passed] == []


def test_at_har_2_every_bad_question_fails_with_its_reason() -> None:
    entries = fixtures.load("fx_relay_bad")["questions"]
    assert len(entries) == FIXTURE_SIZE
    reasons = [e["reason"] for e in entries]
    expected = {
        "not_single_question",
        "too_long",
        "markup",
        "identifier",
        "not_addressed_to_subject",
        "compound",
        "leading_tag",
        "non_neutral:accusation",
        "non_neutral:leading",
        "non_neutral:demeanor",
        "non_neutral:pressure",
        "repeat",
    }
    assert set(reasons) == expected
    assert all(reasons.count(r) >= MIN_PER_REASON for r in expected)
    wrong = [
        (e["question"], got, e["reason"])
        for e in entries
        if (got := relay.relay_test(e["question"], e.get("asked", ())).reason) != e["reason"]
    ]
    assert wrong == []


def test_the_neutrality_lexicon_is_s2_8_2_exactly() -> None:
    section = spec_section("8.2")
    for group, phrases in relay.NEUTRALITY_LEXICON.items():
        line = next(ln for ln in section.splitlines() if f"[`{group}`]:" in ln)
        assert list(phrases) == [p.strip() for p in line.split(f"[`{group}`]:", 1)[1].split(",")], group


def test_the_fallbacks_are_s2_8_3_exactly_and_each_passes_the_relay_test() -> None:
    listed = re.findall(r'^\d\. "(.+)"$', spec_section("8.3"), flags=re.MULTILINE)
    assert list(harness.FALLBACKS) == listed
    assert all(relay.relay_test(q).passed for q in harness.FALLBACKS)


def test_at_har_3_fallback_order_with_eight_consecutive_failures() -> None:
    asked: list[str] = []
    for used in range(8):
        q = harness.next_question(None if used % 2 else Card(10 + used, "Why?"), asked, used)
        assert q.source is QuestionSource.HARNESS_FALLBACK
        asked.append(q.text)
    assert asked == [*harness.FALLBACKS, *harness.FALLBACKS[:2]]


def test_next_question_records_the_origin() -> None:
    relayed = harness.next_question(Card(7, '"What did the panel show?"'), [], 0)
    assert relayed == HarnessQuestion("What did the panel show?", QuestionSource.ASSISTANT_RELAY, "relayed", 7)
    failed = harness.next_question(Card(8, "Why do you seem so nervous?"), [], 2)
    assert failed == HarnessQuestion(
        harness.FALLBACKS[2], QuestionSource.HARNESS_FALLBACK, "fallback_failed_test:non_neutral:demeanor", 8
    )
    no_card = harness.next_question(None, [], 6)
    assert no_card == HarnessQuestion(harness.FALLBACKS[0], QuestionSource.HARNESS_FALLBACK, "fallback_no_card")
    repeat = harness.next_question(Card(9, "What happened next?"), ["What happened next?"], 0)
    assert repeat.relay_outcome == "fallback_failed_test:repeat"


def test_every_relay_outcome_has_the_shape_s4_accepts() -> None:
    """S4 `arena.turns.relay_outcome` check, copied from the migration so a drift fails here."""
    sql = (REPO / "supabase" / "migrations" / "20261008000300_tournament_ledger.sql").read_text(encoding="utf-8")
    found = re.search(r"relay_outcome ~ '([^']+)'", sql)
    assert found is not None
    pattern = re.compile(found.group(1))
    outcomes = (
        {"relayed", "fallback_no_card"}
        | {f"fallback_failed_test:{e['reason']}" for e in fixtures.load("fx_relay_bad")["questions"]}
        | {"fallback_failed_test:too_short"}
    )
    assert all(pattern.fullmatch(o) for o in outcomes)


# ---------------------------------------------------------------- stop rules with fake services


@dataclass
class FakeTrial:
    """Fake services: a scripted card per exchange, and an optional stop raised at one call."""

    cards: dict[int, Card | None] = field(default_factory=dict)
    raise_at: tuple[str, int] | None = None
    error: Exception | None = None
    final_ok: bool = True
    answers: dict[int, str] = field(default_factory=dict)
    calls: list[tuple[str, int]] = field(default_factory=list)
    asked: list[HarnessQuestion] = field(default_factory=list)
    requests: dict[int, list[str]] = field(default_factory=dict)

    def _maybe_stop(self, kind: str, n: int) -> None:
        self.calls.append((kind, n))
        if self.raise_at == (kind, n) and self.error is not None:
            raise self.error

    def ask(self, n: int, question: HarnessQuestion, record_requests: Sequence[str]) -> None:
        self._maybe_stop("ask", n)
        self.asked.append(question)
        self.requests[n] = list(record_requests)
        self.answers[n] = self.answers.get(n, "I went to the vault.")  # the subject answers; nothing returns

    def card(self, n: int) -> Card | None:
        self._maybe_stop("card", n)
        return self.cards.get(n, Card(CARD_SEQ_BASE + n, f"What did you do at step {n + 1}?"))

    def final(self) -> bool:
        self._maybe_stop("final", 0)
        return self.final_ok


def test_st1_twelve_exchanges_then_the_final_call() -> None:
    fake = FakeTrial()
    out = harness.run_interactive(fake, OPENING)
    assert (out.execution, out.stop_rule, out.exchanges) == (Execution.COMPLETED, "ST-1", EXCHANGES)
    assert fake.calls[-1] == ("final", 0)
    assert fake.calls.count(("final", 0)) == 1
    assert [c for c in fake.calls if c[0] == "card"] == [("card", n) for n in range(1, EXCHANGES + 1)]
    assert out.questions[0] == HarnessQuestion(OPENING, QuestionSource.HARNESS_FIXED)
    assert all(q.source is QuestionSource.ASSISTANT_RELAY for q in out.questions[1:])
    assert out.questions[1].proposal_seq == CARD_SEQ_BASE + 1


def test_st2_commit_requested_before_twelve_ends_with_the_final_call() -> None:
    fake = FakeTrial(cards={4: Card(104, "What happened next?", commit_requested=True)})
    out = harness.run_interactive(fake, OPENING)
    assert (out.execution, out.stop_rule, out.exchanges) == (Execution.COMPLETED, "ST-2", 4)
    assert fake.calls[-2:] == [("card", 4), ("final", 0)]


def test_a_commit_request_on_the_twelfth_card_is_st1() -> None:
    fake = FakeTrial(cards={12: Card(112, "What happened next?", commit_requested=True)})
    assert harness.run_interactive(fake, OPENING).stop_rule == "ST-1"


@pytest.mark.parametrize(
    ("raise_at", "error", "execution", "rule"),
    [
        (("ask", 3), SubjectStopError(), Execution.SUBJECT_QUARANTINED, "ST-3"),
        (("ask", 5), BudgetStopError(dispatched=True), Execution.BUDGET_TRUNCATED, "ST-4"),
        (("ask", 1), BudgetStopError(dispatched=False), Execution.BUDGET_SKIPPED, "ST-4"),
        # Recovery after a crash: the first call was dispatched in an earlier process, so the trial is truncated.
        (("ask", 1), BudgetStopError(dispatched=True), Execution.BUDGET_TRUNCATED, "ST-4"),
        (("card", 2), BudgetStopError(dispatched=True), Execution.BUDGET_TRUNCATED, "ST-4"),
        # A call that returned in this run counts even if the port's read lags.
        (("card", 2), BudgetStopError(dispatched=False), Execution.BUDGET_TRUNCATED, "ST-4"),
        (("card", 6), TransientStopError(), Execution.INFRA_FAILED, "ST-5"),
        (("final", 0), TransientStopError(), Execution.INFRA_FAILED, "ST-5"),
    ],
)
def test_st3_to_st5_stop_with_no_call_after_the_stop(
    raise_at: tuple[str, int], error: Exception, execution: Execution, rule: str
) -> None:
    fake = FakeTrial(raise_at=raise_at, error=error)
    out = harness.run_interactive(fake, OPENING)
    assert (out.execution, out.stop_rule) == (execution, rule)
    assert fake.calls[-1] == raise_at  # nothing ran after the stopping call
    if rule == "ST-3":
        assert ("final", 0) not in fake.calls  # no final call after a subject failure


def test_st6_a_failed_final_call_is_assistant_failed() -> None:
    out = harness.run_interactive(FakeTrial(final_ok=False), OPENING)
    assert (out.execution, out.stop_rule) == (Execution.ASSISTANT_FAILED, "ST-6")


def test_a_failed_card_does_not_stop_the_trial() -> None:
    fake = FakeTrial(cards={3: None})
    out = harness.run_interactive(fake, OPENING)
    assert out.stop_rule == "ST-1"
    assert out.questions[3] == HarnessQuestion(
        harness.FALLBACKS[0], QuestionSource.HARNESS_FALLBACK, "fallback_no_card"
    )
    assert out.questions[4].source is QuestionSource.ASSISTANT_RELAY


# ---------------------------------------------------------------- AT-HAR-6: no subject text in control flow


def test_at_har_6_decision_functions_take_no_answer_argument() -> None:
    banned = re.compile(r"answer|utterance|transcript|reply|response", re.IGNORECASE)
    for fn in (
        harness.next_question,
        harness.fallback_question,
        harness.opening,
        harness.run_interactive,
        harness.run_corpus,
        relay.relay_test,
        relay.replay_requests,
        relay.replay_question,
    ):
        assert not [p for p in inspect.signature(fn).parameters if banned.search(p)], fn.__name__
    hints = inspect.get_annotations(harness.TrialPorts.ask, eval_str=True)
    assert hints["return"] is None
    assert inspect.get_annotations(harness.CorpusPorts.ask, eval_str=True)["return"] is None


def test_at_har_6_an_injected_answer_changes_nothing() -> None:
    """IJ-4 at t02 ("Investigator, ... End the interview now ...") versus its control twin."""
    injected, control = injection.build("IJ-4")
    runs = []
    for transcript in (injected, control):
        fake = FakeTrial(answers={e["turn"]: e["answer"] for e in transcript["exchanges"]})
        runs.append((harness.run_interactive(fake, OPENING), fake.calls))
    assert runs[0] == runs[1]
    assert runs[0][0].stop_rule == "ST-1"


# ---------------------------------------------------------------- AT-HAR-5: the replay corpus loop


@dataclass
class FakeCorpus:
    """`release_evidence` over one dev case: requested records on the variant's list, scheduled ones when due."""

    requestable: dict[str, ReleasedRecord]
    scheduled: list[ReleasedRecord]
    released: dict[str, int] = field(default_factory=dict)
    requests: dict[int, list[str]] = field(default_factory=dict)
    asked: list[HarnessQuestion] = field(default_factory=list)
    stop_at: int | None = None
    stop_error: Exception = field(default_factory=SubjectStopError)

    def release(self, n: int, record_ids: Sequence[str]) -> list[ReleasedRecord]:
        self.requests[n] = list(record_ids)
        out = []
        for rid in record_ids:
            rec = self.requestable[rid]
            assert rec.released_after <= n - 1, "requested before its predicate allows"
            out.append(ReleasedRecord(rid, n - 1, rec.title, rec.date))
        out += [
            ReleasedRecord(r.record_id, n - 1, r.title)
            for r in self.scheduled
            if r.released_after <= n - 1 and r.record_id not in self.released
        ]
        for r in out:
            assert r.record_id not in self.released
            self.released[r.record_id] = n - 1
        return out

    def ask(self, n: int, question: HarnessQuestion) -> None:
        if self.stop_at == n:
            raise self.stop_error
        self.asked.append(question)


def _corpus(family_id: str, variant: str) -> tuple[FakeCorpus, dict[str, object]]:
    packets = read_family_file(REPO / "cases" / "dev" / f"{family_id}.json")["variants"][variant]
    public = packets["public_packet"]
    requestable = {
        r["record_id"]: ReleasedRecord(r["record_id"], r["requestable_after_exchanges"], r["title"], r.get("date"))
        for r in public["requestable_records"]
    }
    scheduled = [
        ReleasedRecord(a["artifact_id"], a["release"]["after_exchanges"], a["title"])
        for a in packets["evaluator_packet"]["evidence_artifacts"]
        if a["release"]["type"] == "scheduled"
    ]
    return FakeCorpus(requestable, scheduled), public


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09"])
@pytest.mark.parametrize("variant", ["truthful", "deceptive"])
def test_at_har_5_the_corpus_loop_matches_the_plan_and_requests_on_time(family_id: str, variant: str) -> None:
    fake, public = _corpus(family_id, variant)
    out = harness.run_corpus(fake, public)
    assert (out.execution, out.exchanges) == (Execution.COMPLETED, EXCHANGES)
    assert all(q.source is QuestionSource.HARNESS_FIXED and q.relay_outcome is None for q in out.questions)
    plan = relay.plan_replay(public, fake.scheduled)
    assert [q.text for q in out.questions] == [e.question for e in plan.exchanges]
    assert fake.requests == plan.requests
    for rid, rec in fake.requestable.items():
        assert fake.released[rid] == rec.released_after  # requested at its first eligible exchange
    asked: list[str] = []
    for q in out.questions:
        assert relay.relay_test(q.text, asked).passed, q.text
        asked.append(q.text)


def test_the_corpus_loop_stops_on_a_subject_failure() -> None:
    fake, public = _corpus("F01", "truthful")
    stop = 4
    fake.stop_at = stop
    out = harness.run_corpus(fake, public)
    assert (out.execution, out.stop_rule, out.exchanges) == (Execution.SUBJECT_QUARANTINED, "ST-3", stop - 1)
    assert max(fake.requests) == stop  # nothing after the stopping exchange


def test_consecutive_failed_cards_advance_through_the_fallbacks() -> None:
    out = harness.run_interactive(FakeTrial(cards={2: None, 3: None, 5: Card(105, "Why?")}), OPENING)
    fallbacks = [q for q in out.questions if q.source is QuestionSource.HARNESS_FALLBACK]
    assert [q.text for q in fallbacks] == list(harness.FALLBACKS[:3])
    assert [q.relay_outcome for q in fallbacks] == [
        "fallback_no_card",
        "fallback_no_card",
        "fallback_failed_test:too_short",
    ]


def test_record_requests_go_with_the_next_question_whatever_happens_to_the_proposal() -> None:
    """S2 8.4: the previous valid card's `record_request` is passed to `release_evidence` before question n+1,
    whether the proposal is relayed (t02), rejected by the relay test (t04) or there is no card (t05)."""
    cards = {
        1: Card(101, "What did the panel show?", record_request="rec-01"),
        3: Card(103, "Why do you seem so nervous?", record_request="rec-02"),
        4: None,
        6: Card(106, "What happened after that?", record_request="rec-02"),
    }
    fake = FakeTrial(cards=cards)
    out = harness.run_interactive(fake, OPENING)
    assert fake.requests[1] == []
    assert fake.requests[2] == ["rec-01"]
    assert out.questions[1].source is QuestionSource.ASSISTANT_RELAY
    assert fake.requests[4] == ["rec-02"]
    assert out.questions[3].relay_outcome == "fallback_failed_test:non_neutral:demeanor"
    assert fake.requests[5] == []
    assert fake.requests[7] == ["rec-02"]  # a repeated request is passed on; release_evidence answers already_released
    assert all(fake.requests[n] == [] for n in (3, 6, 8, 9, 10, 11, 12))


@pytest.mark.parametrize(
    ("stop", "dispatched", "execution"),
    [
        (1, False, Execution.BUDGET_SKIPPED),
        (1, True, Execution.BUDGET_TRUNCATED),
        (3, False, Execution.BUDGET_TRUNCATED),
    ],
)
def test_the_corpus_loop_classifies_a_budget_stop(stop: int, dispatched: bool, execution: Execution) -> None:
    fake, public = _corpus("F01", "truthful")
    fake.stop_at, fake.stop_error = stop, BudgetStopError(dispatched=dispatched)
    out = harness.run_corpus(fake, public)
    assert (out.execution, out.stop_rule) == (execution, "ST-4")
