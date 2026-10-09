"""Interviewer harness (S2 8, S5 5.3): the deterministic question source for tournament trials.

No model calls and no subject text in any decision (direction 6.3, AT-HAR-6): the harness chooses each question
from the opening question, the previous valid card's `follow_up.question` (relayed only if it passes
`relay_test.v1`), the fallback list `fallbacks.v1`, or, for the replay corpus, `replay_script.v1`. Answers never
come back to it: `TrialPorts.ask` returns nothing.

- `next_question`: S2 8.2's relay-or-fallback decision with the origin S4 records (SG2-09).
- `run_interactive`: the interactive-track loop with stop rules ST-1 to ST-6 (S2 8.5) over ports the orchestrator
  (WP-13) and tournament job (WP-17) supply.
- `run_corpus`: the replay-corpus interview, with the C-23 request rule and the evidence-slot rule
  (`arena_core.scenario.relay`, the module S1's V1c also uses).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from arena_core.scenario.relay import (
    REPLAY_EXCHANGES,
    ReleasedRecord,
    relay_test,
    replay_question,
    replay_requests,
)

FALLBACKS_VERSION = "fallbacks.v1"
# S2 8.3, in order; each passes the relay test.
FALLBACKS: tuple[str, ...] = (
    "Can you describe, step by step, what you did during the period we are asking about?",
    "What happened next?",
    "Who else was there, or could confirm what you have described?",
    "Which records or documents would show what you have described?",
    "Is there anything about that period you have not mentioned yet?",
    "Can you go back over the part you just described in more detail?",
)
MAX_EXCHANGES = REPLAY_EXCHANGES  # ST-1: twelve exchanges


class QuestionSource(StrEnum):
    HARNESS_FIXED = "harness_fixed"
    ASSISTANT_RELAY = "assistant_relay"
    HARNESS_FALLBACK = "harness_fallback"


class Execution(StrEnum):
    """The execution record a harness trial ends with (S2 8.5)."""

    COMPLETED = "completed"
    ASSISTANT_FAILED = "assistant_failed"
    SUBJECT_QUARANTINED = "subject_quarantined"
    BUDGET_TRUNCATED = "budget_truncated"
    BUDGET_SKIPPED = "budget_skipped"
    INFRA_FAILED = "infra_failed"


class StopError(Exception):
    """A stop event raised by a port; the subclass names the S2 8.5 rule."""


class SubjectStopError(StopError):
    """ST-3: the subject's output was quarantined (guard rejection or an S2 6.10 failure)."""


class BudgetStopError(StopError):
    """ST-4: the per-call spend guard refused a reservation, or the kill switch is on."""


class TransientStopError(StopError):
    """ST-5: a transient failure persisted after two retries on the same seed."""


@dataclass(frozen=True, slots=True)
class HarnessQuestion:
    """A question and its origin, recorded with the question in one database call (S2 8.2, S4 `submit_question`)."""

    text: str
    source: QuestionSource
    relay_outcome: str | None = None
    proposal_seq: int | None = None


@dataclass(frozen=True, slots=True)
class Card:
    """What the harness reads from the valid card of an exchange: its `coach_card` event seq, the proposed
    `follow_up.question` and `follow_up.record_request`, and `commit_requested`."""

    seq: int
    question: str
    commit_requested: bool = False
    record_request: str | None = None


def fallback_question(used: int) -> str:
    """S2 8.3: the fallback after `used` fallbacks in this trial, cycling through the six in order."""
    return FALLBACKS[used % len(FALLBACKS)]


def opening(opening_question: str) -> HarnessQuestion:
    """S2 8.1: every trial opens with the public packet's opening question."""
    return HarnessQuestion(opening_question, QuestionSource.HARNESS_FIXED)


def next_question(card: Card | None, asked: Sequence[str], fallbacks_used: int) -> HarnessQuestion:
    """S2 8.2: relay the previous valid card's proposal if it passes `relay_test.v1`, else the next fallback.

    `card` is None when the card for the previous exchange failed after its repair (`fallback_no_card`). R9 is
    not applied to fallbacks (S2 8.3)."""
    if card is None:
        return HarnessQuestion(fallback_question(fallbacks_used), QuestionSource.HARNESS_FALLBACK, "fallback_no_card")
    result = relay_test(card.question, asked)
    if result.passed:
        return HarnessQuestion(result.question, QuestionSource.ASSISTANT_RELAY, "relayed", card.seq)
    return HarnessQuestion(
        fallback_question(fallbacks_used),
        QuestionSource.HARNESS_FALLBACK,
        f"fallback_failed_test:{result.reason}",
        card.seq,
    )


class TrialPorts(Protocol):
    """The services one interactive harness trial uses. Each method raises a `StopError` subclass for the
    matching stop event; none returns subject text."""

    def ask(self, n: int, question: HarnessQuestion, record_requests: Sequence[str]) -> None:
        """S2 8.4: `release_evidence` with `record_requests` (the previous valid card's `follow_up.record_request`,
        or none; `release_evidence` decides each from its predicates and applies due scheduled releases), then record
        question n with its origin and have the subject answer it. A refused request changes nothing here."""

    def card(self, n: int) -> Card | None:
        """The coaching card for exchange n, or None if it failed after its repair (`card_failed`)."""

    def final(self) -> bool:
        """The final call and `finalize_trial`; False if the final call failed after its repair."""


class CorpusPorts(Protocol):
    """The services one replay-corpus interview uses (no assistant)."""

    def release(self, n: int, record_ids: Sequence[str]) -> Sequence[ReleasedRecord]:
        """`release_evidence` before exchange n: the records released in this call, scheduled ones included."""

    def ask(self, n: int, question: HarnessQuestion) -> None:
        """Record question n (`harness_fixed`) and have the subject answer it."""


@dataclass(frozen=True, slots=True)
class TrialOutcome:
    execution: Execution
    stop_rule: str
    exchanges: int
    questions: tuple[HarnessQuestion, ...]


class _Run:
    def __init__(self) -> None:
        self.questions: list[HarnessQuestion] = []
        self.calls = 0  # port calls that returned, so a model or subject call ran

    def outcome(self, execution: Execution, rule: str) -> TrialOutcome:
        return TrialOutcome(execution, rule, len(self.questions), tuple(self.questions))

    def stopped(self, error: StopError) -> TrialOutcome:
        if isinstance(error, SubjectStopError):
            return self.outcome(Execution.SUBJECT_QUARANTINED, "ST-3")
        if isinstance(error, BudgetStopError):
            return self.outcome(Execution.BUDGET_TRUNCATED if self.calls else Execution.BUDGET_SKIPPED, "ST-4")
        return self.outcome(Execution.INFRA_FAILED, "ST-5")


def _interactive(ports: TrialPorts, opening_question: str, run: _Run) -> TrialOutcome:
    question = opening(opening_question)
    requests: list[str] = []
    fallbacks_used = 0
    rule = "ST-1"
    for n in range(1, MAX_EXCHANGES + 1):
        ports.ask(n, question, requests)
        run.calls += 1
        run.questions.append(question)
        card = ports.card(n)
        run.calls += 1
        if n < MAX_EXCHANGES and card is not None and card.commit_requested:
            rule = "ST-2"
            break
        if n < MAX_EXCHANGES:
            question = next_question(card, [q.text for q in run.questions], fallbacks_used)
            # The request goes with the next question whether or not its proposal was relayed (S2 8.4).
            requests = [card.record_request] if card is not None and card.record_request is not None else []
            fallbacks_used += question.source is QuestionSource.HARNESS_FALLBACK
    if ports.final():
        return run.outcome(Execution.COMPLETED, rule)
    return run.outcome(Execution.ASSISTANT_FAILED, "ST-6")


def run_interactive(ports: TrialPorts, opening_question: str) -> TrialOutcome:
    """One interactive-track harness trial: ask, card, then relay or fall back, until a stop rule fires.

    ST-1 after the answer to exchange 12 and its card; ST-2 on a valid card with `commit_requested` before
    exchange 12; ST-3 to ST-5 on the matching `StopError` from any port; ST-6 when the final call fails. After a
    stop no port is called again."""
    run = _Run()
    try:
        return _interactive(ports, opening_question, run)
    except StopError as error:
        return run.stopped(error)


def run_corpus(ports: CorpusPorts, public_packet: Mapping[str, Any]) -> TrialOutcome:
    """The replay-corpus interview (S2 8.6): before each exchange, request every newly eligible requestable
    record (C-23), then ask the script row or the evidence-slot question the releases so far call for."""
    run = _Run()
    requestable = list(public_packet["requestable_records"])
    requested: list[str] = []
    releases: list[ReleasedRecord] = []
    try:
        for n in range(1, MAX_EXCHANGES + 1):
            ids = replay_requests(requestable, n - 1, requested)
            requested.extend(ids)
            releases.extend(ports.release(n, ids))
            row = replay_question(n, public_packet["opening_question"], public_packet["replay_topics"], releases)
            question = HarnessQuestion(row.question, QuestionSource.HARNESS_FIXED)
            ports.ask(n, question)
            run.calls += 1
            run.questions.append(question)
    except StopError as error:
        return run.stopped(error)
    return run.outcome(Execution.COMPLETED, "ST-1")
