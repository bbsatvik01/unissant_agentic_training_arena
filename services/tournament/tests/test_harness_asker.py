"""`HarnessAsker`/`CorpusAsker` against a real `Orchestrator` on `FakeArenaDb` (`packages.core.tests.turns.
test_orchestrator.Rig`, the same double the orchestrator's own suite uses): the three `ask()` stop paths,
`card()`'s budget-stop and happy path, `final()`'s two failure paths, and `CorpusAsker`'s release/title
fallback -- the branches it_tournament.py's real-database happy path never reaches (budget refusals,
quarantine, a discarded card).

Each port call runs the way the runner drives it: in a worker thread (`asyncio.to_thread`), handing its
coroutine back to the one event loop that owns the clients (`on_loop`)."""

from __future__ import annotations

import asyncio
import socket
import socketserver
import threading
from collections.abc import Awaitable, Callable, Iterator
from decimal import Decimal
from uuid import UUID

import pytest

from arena_core.turns.harness import (
    BudgetStopError,
    Card,
    HarnessQuestion,
    QuestionSource,
    SubjectStopError,
    TransientStopError,
)
from arena_core.turns.orchestrator import Orchestrator, SubjectOutcome, SubjectUnavailableError, TrialSignals
from arena_tournament.harness_asker import CorpusAsker, HarnessAsker
from packages.core.tests.turns.fakedb import PACKET
from packages.core.tests.turns.test_orchestrator import Rig

QUESTION = HarnessQuestion(text="What did you do in B-12?", source=QuestionSource.HARNESS_FIXED)
Loop = asyncio.AbstractEventLoop
EXCHANGES = 3


def on_loop[T](fn: Callable[[Loop], T]) -> T:
    """`fn(loop)` in a worker thread while `loop` (the caller's own running loop) stays free to serve the
    port's coroutines: exactly `runner._run_interactive_trial`'s shape."""

    async def _main() -> T:
        return await asyncio.to_thread(fn, asyncio.get_running_loop())

    return asyncio.run(_main())


def test_ask_records_the_question_and_answer_on_the_happy_path() -> None:
    rig = Rig()
    on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))
    assert rig.kinds() == ["question_recorded", "subject_turn"]


def test_ask_raises_subjectstoperror_on_a_quarantined_answer() -> None:
    rig = Rig()
    rig.quarantine = True
    with pytest.raises(SubjectStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))


def test_ask_raises_budgetstoperror_when_the_subject_call_is_budget_refused() -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("budget_refused")
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))


def test_ask_raises_transientstoperror_and_stops_the_trial_on_an_infra_failure() -> None:
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("subject_unavailable")
    with pytest.raises(TransientStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))
    assert rig.db.execution_state == "infra_failed"


def test_ask_raises_budgetstoperror_when_the_subjects_kill_switch_is_on() -> None:
    """ST-4 groups the kill switch with a budget refusal ("the per-call spend guard refused a reservation,
    or the kill switch is on"): a real bug (Codex round 1) had this fall through to the generic
    TurnRefusedError handler instead, recording infra_failed (ST-5, retriable) rather than budget_truncated."""
    rig = Rig()
    rig.subject_error = SubjectUnavailableError("kill_switch_on")
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))
    assert rig.db.execution_state == "budget_truncated"


def test_card_raises_budgetstoperror_once_the_trial_is_already_budget_truncated() -> None:
    rig = Rig()
    on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).ask(1, QUESTION, []))
    rig.db.execution_state = "budget_truncated"
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).card(1))


def test_card_returns_the_real_follow_up_question_on_the_happy_path() -> None:
    rig = Rig()

    def ask_then_card(loop: Loop) -> Card | None:
        asker = HarnessAsker(rig.db.trial_id, rig.orch, loop)
        asker.ask(1, QUESTION, [])
        return asker.card(1)

    card = on_loop(ask_then_card)
    assert card is not None
    assert card.question


def test_final_raises_budgetstoperror_when_the_final_call_is_budget_refused() -> None:
    rig = Rig()
    rig.turn()  # one completed exchange first: PublicTrialView needs exchange >= 1
    rig.budget.ceiling_usd = Decimal(0)  # drain the budget for the final call specifically
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).final())
    assert rig.db.execution_state == "budget_truncated"


def test_final_returns_true_and_commits_on_the_happy_path() -> None:
    rig = Rig()
    rig.turn()
    assert on_loop(lambda loop: HarnessAsker(rig.db.trial_id, rig.orch, loop).final()) is True
    assert rig.db.status == "finalized"


def test_corpus_asker_release_returns_nothing_when_no_record_was_due() -> None:
    rig = Rig()
    assert on_loop(lambda loop: CorpusAsker(rig.db.trial_id, rig.orch, PACKET, loop).release(1, [])) == []


def test_corpus_asker_release_returns_the_released_record_with_its_title() -> None:
    rig = Rig()
    rig.turn()
    rig.turn()  # two exchanges: rec-01 (on_request, after_exchanges=2) is now releasable
    released = on_loop(lambda loop: CorpusAsker(rig.db.trial_id, rig.orch, PACKET, loop).release(3, ["rec-01"]))
    assert [r.record_id for r in released] == ["rec-01"]
    expected_title = next(r["title"] for r in PACKET["requestable_records"] if r["record_id"] == "rec-01")
    assert released[0].title == expected_title


def test_corpus_asker_ask_records_the_question_with_no_releases() -> None:
    rig = Rig()
    on_loop(lambda loop: CorpusAsker(rig.db.trial_id, rig.orch, PACKET, loop).ask(1, QUESTION))
    assert rig.kinds()[-2:] == ["question_recorded", "subject_turn"]


class _EchoHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        for line in self.rfile:
            self.wfile.write(line)


@pytest.fixture
def echo_server() -> Iterator[tuple[str, int]]:
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _EchoHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    yield str(host), int(port)
    server.shutdown()
    server.server_close()


class PooledSubject:
    """A subject client with a real pooled transport: one TCP connection opened on first use and reused for
    every later call, the way `httpx.AsyncClient` and the Vertex client keep theirs. A connection belongs to
    the loop that opened it, so a port that ran each call on its own short-lived loop (`asyncio.run` per
    call) fails on the second call with "Event loop is closed"."""

    def __init__(
        self, address: tuple[str, int], answer: Callable[[UUID, UUID, UUID | None], Awaitable[SubjectOutcome]]
    ) -> None:
        self.address = address
        self.answer = answer
        self.conn: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None
        self.round_trips = 0

    async def __call__(self, trial: UUID, work_item: UUID, actor: UUID | None) -> SubjectOutcome:
        if self.conn is None:
            self.conn = await asyncio.open_connection(*self.address, family=socket.AF_INET)
        reader, writer = self.conn
        writer.write(b"answer\n")
        await writer.drain()
        assert await reader.readline() == b"answer\n"
        self.round_trips += 1
        return await self.answer(trial, work_item, actor)

    async def aclose(self) -> None:
        if self.conn is not None:
            self.conn[1].close()
            await self.conn[1].wait_closed()


def test_every_port_call_reuses_one_pooled_connection_across_a_whole_trial(echo_server: tuple[str, int]) -> None:
    """The job builds its clients once (`main.build_runner`), so every port call must run on that one loop:
    three exchanges and a card on one pooled connection, all from the harness's worker thread."""
    rig = Rig()
    pooled = PooledSubject(echo_server, rig.subject)
    orch = Orchestrator(db=rig.db, port=rig.port, subject=pooled, signals=TrialSignals())

    def three_exchanges(loop: Loop) -> list[Card | None]:
        asker = HarnessAsker(rig.db.trial_id, orch, loop)
        cards = []
        for n in range(1, EXCHANGES + 1):
            asker.ask(n, HarnessQuestion(text=f"Question {n}?", source=QuestionSource.HARNESS_FIXED), [])
            cards.append(asker.card(n))
        asyncio.run_coroutine_threadsafe(pooled.aclose(), loop).result()
        return cards

    assert all(card is not None for card in on_loop(three_exchanges))
    assert pooled.round_trips == EXCHANGES


def _harness_orch(rig: Rig) -> Orchestrator:
    """The tournament job's orchestrator (`main.build_runner`): `harness=True`."""
    return Orchestrator(db=rig.db, port=rig.port, subject=rig.subject, signals=TrialSignals(), harness=True)


def test_card_with_the_kill_switch_on_stops_the_trial_budget_truncated() -> None:
    """ST-4 ("the kill switch is on" -> budget_truncated), as on the subject path: never a coach_unavailable
    the harness relays past (a real gap, Codex round 2)."""
    rig = Rig()
    orch = _harness_orch(rig)
    on_loop(lambda loop: HarnessAsker(rig.db.trial_id, orch, loop).ask(1, QUESTION, []))
    rig.budget.kill_switch = True
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, orch, loop).card(1))
    assert rig.db.execution_state == "budget_truncated"
    assert "coach_unavailable" not in rig.kinds()


def test_final_with_the_kill_switch_on_stops_the_trial_budget_truncated() -> None:
    """ST-4, not ST-6: the kill switch on the final call is a budget stop, never assistant_failed."""
    rig = Rig()
    rig.turn()
    rig.budget.kill_switch = True
    with pytest.raises(BudgetStopError):
        on_loop(lambda loop: HarnessAsker(rig.db.trial_id, _harness_orch(rig), loop).final())
    assert rig.db.execution_state == "budget_truncated"
