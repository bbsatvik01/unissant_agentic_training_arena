"""`arena_core.referee.fake_referee`, exercised from the referee service's own real pipeline (S5 10.4):
`referee_subject_reply`/`referee_assistant_reply` vary with the actual transcript (not fixed text), and a
fake F01-shaped training session publishes a complete `debrief.v1` end to end through the real `AgentPort`
and `FakeAdapter` -- the exact pipeline `ARENA_MODEL_MODE=fake` runs, so a regression here is the 502 a
local fake interview hit before this fix (no canned reply for either referee schema)."""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Coroutine, Mapping
from dataclasses import replace
from decimal import Decimal
from typing import Any

from pydantic import BaseModel

from arena_core.agents.manifests import load_prompts, referee_manifest, with_hash
from arena_core.agents.referee_prompts import FindingProjection
from arena_core.agents.repair import output_errors
from arena_core.agents.rubric import Rubric
from arena_core.contracts.referee import RefAsstContext, RefereeAssistantReport, RefereeSubjectReport
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.port import AgentPort
from arena_core.providers.structured import sent_schema
from arena_core.providers.types import AgentCall, ModelRequest
from arena_core.referee.fake_referee import FAKE_REFEREE_REPLIES, referee_assistant_reply, referee_subject_reply
from arena_core.scoring.rubric import CHECKS, MIN_QUESTIONS, RubricResult
from arena_core.spend.memory import RunBudget
from arena_referee.debrief import DebriefDeps, DebriefProvenance, SessionInfo, publish_session_debrief
from arena_referee.mapping import TrialData, build_assistant_input, build_subject_input, build_triggers
from arena_referee.scoring import (
    PromptContext,
    ScoringDeps,
    _applicable,
    assistant_agent_call,
    subject_agent_call,
)


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


REFEREE = load_prompts(with_hash(referee_manifest()))
RUBRIC = Rubric.model_validate(
    {
        "rubric_version": "rubric.v1",
        "dimensions": [
            {
                "dim_id": dim,
                "name": dim,
                "anchors_0_to_4": [f"anchor {k}" for k in range(5)],
                "subchecks": [{"id": s, "text": f"placeholder {s}", "na_when": None} for s in ids],
            }
            for dim, ids in CHECKS.items()
        ],
    }
)
CTX = PromptContext(prompts=REFEREE, rubric=RUBRIC)
SESSION_ID = "00000000-0000-0000-0000-00000000000b"
TRIAL_ID = "00000000-0000-0000-0000-00000000000a"
EVALUATOR_PACKET: dict[str, Any] = {
    "role": "truthful",
    "synopsis": "J. Doe's account is consistent with the record.",
    "canonical_facts": [{"id": "f:01", "statement": "A fact.", "material": False}],
    "rubric": {"key_questions": [{"intent": "Why was entry made?", "target_fact_ids": ["f:01"]}]},
}
_ANSWERS = [
    "I had a work order for the humidity alarm in B-12.",
    "I checked the panel and reset the sensor myself.",
    "The supervisor asked me to confirm the fix before shift end.",
    "I logged the repair in the facilities system right after.",
]


def _card(n: int) -> dict[str, Any]:
    """One coaching card per turn (S2 4.1), the assistant mode's own source of follow-ups (`mapping.
    build_assistant_input`); without one, `assistant_reply` would have nothing to answer regardless of the
    transcript's length."""
    return {
        "schema_version": "card.v1",
        "turn_id": f"t{n:02d}",
        "question": {"question_type": "open", "neutrality_issues": [], "assessment": "An open question."},
        "answer_category": "responsive",
        "flags": [],
        "follow_up": {
            "question": f"Can you say more about exchange {n}?",
            "tactic": "funnel_probe",
            "purpose": "Ask for the next part of the account.",
            "record_request": None,
        },
        "finding": {
            "label": "insufficient_evidence",
            "likelihood": "roughly_even_chance",
            "confidence": "low",
            "basis_flag_refs": [],
            "cited_turns": [],
            "cited_records": [],
            "corroboration_needed": ["the work order"],
            "rationale": "Not yet established.",
            "alternative_explanations": None,
            "last_revised_turn": n,
        },
        "boundary_notice": False,
        "commit_requested": False,
        "card_seq": n,
        "turn_no": n,
        "candidate_sha256": "a" * 64,
        "validation": {"valid": True, "flags": {}, "demeanor_in_rationale": False},
        "latency_ms": 1200,
        "work_item": "0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "transcript_version": 2 * n,
    }


def _turn(n: int) -> dict[str, Any]:
    return {
        "turn_no": n,
        "question": f"Why were you in the room at exchange {n}?",
        "answer": _ANSWERS[(n - 1) % len(_ANSWERS)],
        "question_source": "investigator",
    }


def trial_data(n_questions: int) -> TrialData:
    return TrialData(
        trial_id=TRIAL_ID,
        split="dev",
        canonical_facts=EVALUATOR_PACKET["canonical_facts"],
        private_packet={
            "case_id": "C-7Q2MXK4D",
            "role": "truthful",
            "persona": {
                "name": "J. Doe",
                "position": "Technician",
                "organization": "Agency",
                "background": "Works here.",
            },
            "matter": "Why J. Doe was in the room.",
            "facts": [{"id": "f:01", "class": "FREE", "text": "A fact."}],
            "uncertainty": [],
            "gates": [],
            "permitted_behaviors": [],
            "style": {
                "verbosity": "terse",
                "fluency": "fluent",
                "affect": "calm",
                "register": "formal",
                "language": "native",
            },
        },
        public_packet={
            "case_id": "C-7Q2MXK4D",
            "investigation_objective": "Establish why J. Doe was in the room.",
            "known_timeline": [{"time": "09:00", "event": "Shift began.", "source": "doc-01"}],
            "initial_documents": [
                {
                    "doc_id": "doc-01",
                    "kind": "access_exception_report",
                    "title": "Access log",
                    "content": {"body": "Entry at 09:05."},
                }
            ],
            "interview_context": {
                "agency": "Agency",
                "facility": "Annex",
                "timezone": "America/New_York",
                "interview_date": "2026-03-16",
                "setting": "Interview room.",
                "investigator_role": "Reviewer",
                "subject": {"name": "J. Doe", "position": "Technician", "unit": "Ops", "tenure_years": 4},
                "purpose_statement": "An administrative review of the entry.",
            },
            "requestable_records": [{"record_id": "rec-01", "title": "Work order", "requestable_after_exchanges": 1}],
        },
        released=[],
        transcript=[_turn(n) for n in range(1, n_questions + 1)],
        cards=[_card(n) for n in range(1, n_questions + 1)],
        final_finding=None,
    )


# ---------------------------------------------------------------- referee_subject_reply / referee_assistant_reply


def _request_of[T: BaseModel](call: AgentCall[T]) -> ModelRequest:
    """What the real `AgentPort` actually hands `FakeAdapter.generate` (`_Plan.request`, port.py): the one
    shape `referee_subject_reply`/`referee_assistant_reply` are typed to read, built here the same way for
    a direct test."""
    return ModelRequest(
        model=call.model,
        system=call.system,
        messages=call.messages,
        json_schema=sent_schema(call.schema),
        max_output_tokens=4000,
        thinking=call.thinking,
        seed=0,
    )


def test_replies_ignore_a_line_shaped_collision_inside_a_document_body() -> None:
    """A record or initial document's own body (untrusted case content) can legitimately contain a line
    that reads like a turn, flag, follow-up or citation reference -- "doc-01" alone, "t01 | ...",
    "t01.f1 | ...", "t01 Subject: ..." -- without that line being one. Each extractor is scoped to its own
    `<untrusted_{kind}_{salt}>` block (or, for citations, the template's own static headers) specifically so
    content from a DIFFERENT section can never be mistaken for a line the request actually asked about."""
    data = trial_data(MIN_QUESTIONS)
    for collision in ("doc-01", "t01 | inspection note", "t01.f1 | inspection note", "t01 Subject: copied line"):
        docs = [dict(d) for d in data.public_packet["initial_documents"]]
        docs[0] = {**docs[0], "content": {**docs[0]["content"], "body": docs[0]["content"]["body"] + "\n" + collision}}
        poisoned = replace(data, public_packet={**data.public_packet, "initial_documents": docs})

        triggers = build_triggers(poisoned, _empty_subject_report(), "assistant")
        a_inp = build_assistant_input(poisoned, "assistant", triggers)
        acall = assistant_agent_call(a_inp, REFEREE, RUBRIC, poisoned.trial_id, "referee_assistant")
        _validated(acall, referee_assistant_reply(_request_of(acall)))  # raises (via the assert) if poisoned

        scall = subject_agent_call(build_subject_input(poisoned), REFEREE, poisoned.trial_id, "referee_subject")
        _validated(scall, referee_subject_reply(_request_of(scall)))


def test_subject_reply_quotes_a_real_span_of_each_turns_own_answer() -> None:
    data = trial_data(MIN_QUESTIONS)
    inp = build_subject_input(data)
    call = subject_agent_call(inp, REFEREE, data.trial_id, "referee_subject")
    reply = referee_subject_reply(_request_of(call))
    report = _validated(call, reply)
    assert [t.turn_id for t in report.turns] == [f"t0{n}" for n in range(1, MIN_QUESTIONS + 1)]
    for n, t in enumerate(report.turns, start=1):
        assert t.evidence_quote
        assert t.evidence_quote in _ANSWERS[(n - 1) % len(_ANSWERS)]


_SHORT_TURNS = 3
_LONG_TURNS = 5


def test_assistant_reply_varies_with_a_longer_and_a_shorter_transcript() -> None:
    """Not a constant: a 3-turn and a 5-turn request get differently-sized followup lists."""
    short = trial_data(_SHORT_TURNS)
    long_ = trial_data(_LONG_TURNS)
    triggers_short = build_triggers(short, _empty_subject_report(), "assistant")
    triggers_long = build_triggers(long_, _empty_subject_report(), "assistant")
    short_call = assistant_agent_call(
        build_assistant_input(short, "assistant", triggers_short), REFEREE, RUBRIC, short.trial_id, "referee_assistant"
    )
    long_call = assistant_agent_call(
        build_assistant_input(long_, "assistant", triggers_long), REFEREE, RUBRIC, long_.trial_id, "referee_assistant"
    )
    short_report = _validated(short_call, referee_assistant_reply(_request_of(short_call)))
    long_report = _validated(long_call, referee_assistant_reply(_request_of(long_call)))
    assert len(short_report.followups) == _SHORT_TURNS
    assert len(long_report.followups) == _LONG_TURNS
    assert len(short_report.followups) != len(long_report.followups)


def _empty_subject_report() -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {"schema_version": "ref_subj.v5", "turns": [], "trajectory": {"self_consistent": True, "conflicts": []}}
    )


def _validated[T: BaseModel](call: AgentCall[T], reply: str) -> T:
    value, errors = output_errors(call.schema, reply, call.validation_context, call.salt)
    assert not errors, errors
    assert value is not None
    return value


# ---------------------------------------------------------------- end to end, through the real AgentPort


class FakeStorage:
    """Everything `ScoringDeps`/`DebriefDeps` need besides the model call, in memory -- `run_subject_call`/
    `run_assistant_call` go through a REAL `AgentPort` backed by a REAL `FakeAdapter(canned=
    FAKE_REFEREE_REPLIES)`, the same wiring `create_app()` uses for `ARENA_MODEL_MODE=fake` (S5 10.4)."""

    def __init__(self, n_questions: int) -> None:
        self.data = trial_data(n_questions)
        self.judgments: dict[str, Mapping[str, Any]] = {}
        self.labels: list[Any] = []
        self.adjudications: list[tuple[str, str, str]] = []
        self.rubric_scores: list[tuple[str, RubricResult, str]] = []
        self.published: dict[str, Mapping[str, Any]] = {}
        self.budget = RunBudget(Decimal(10))
        self.port = AgentPort(FakeAdapter(canned=FAKE_REFEREE_REPLIES), self.budget)

    async def fetch_trial_data(self, _trial_id: str) -> TrialData:
        return self.data

    async def get_judgment(self, key: str) -> Mapping[str, Any] | None:
        return self.judgments.get(key)

    async def store_labels(self, trial_id: str, labeler: str, rows: list[dict[str, Any]], prompt_sha256: str) -> None:
        self.labels.append((trial_id, labeler, rows, prompt_sha256))

    async def store_judgment(
        self, _trial_id: str, _kind: str, _rater_id: str | None, payload: Mapping[str, Any], idempotency_key: str
    ) -> None:
        self.judgments[idempotency_key] = payload

    async def adjudicate_valid(self, trial_id: str, reason: str, evidence_ref: str) -> None:
        self.adjudications.append((trial_id, reason, evidence_ref))

    async def run_subject_call(self, call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        return (await self.port.run(call)).value

    async def run_assistant_call(self, call: AgentCall[RefereeAssistantReport]) -> RefereeAssistantReport:
        return (await self.port.run(call)).value

    def scoring_deps(self) -> ScoringDeps:
        return ScoringDeps(
            fetch_trial_data=self.fetch_trial_data,
            get_judgment=self.get_judgment,
            store_labels=self.store_labels,
            store_judgment=self.store_judgment,
            adjudicate_valid=self.adjudicate_valid,
            run_subject_call=self.run_subject_call,
            run_assistant_call=self.run_assistant_call,
            prompt_sha256="a" * 64,
        )

    async def fetch_session(self, _session_id: str) -> SessionInfo:
        return SessionInfo(
            trial_id=self.data.trial_id,
            voice=False,
            trial_status="finalized",
            evaluator_packet=EVALUATOR_PACKET,
            committed_finding=None,
        )

    async def get_debrief(self, session_id: str) -> Mapping[str, Any] | None:
        return self.published.get(session_id)

    async def publish_debrief(self, session_id: str, payload: Mapping[str, Any]) -> None:
        self.published[session_id] = payload

    async def store_rubric_score(self, session_id: str, result: RubricResult, scorer_ref: str) -> None:
        self.rubric_scores.append((session_id, result, scorer_ref))

    def deps(self) -> DebriefDeps:
        return DebriefDeps(
            scoring=self.scoring_deps(),
            fetch_session=self.fetch_session,
            get_debrief=self.get_debrief,
            publish_debrief=self.publish_debrief,
            store_rubric_score=self.store_rubric_score,
            provenance=DebriefProvenance(
                rubric_sha256="a" * 64,
                r3_prompt_sha256=("b" * 64, "c" * 64),
                referee_model_ids=("gemini-3.1-flash-lite", "gemini-3.5-flash-lite"),
                scorer_git_sha="d" * 40,
            ),
        )


def test_a_fake_training_session_publishes_a_complete_scored_debrief() -> None:
    """The exact pipeline a local `ARENA_MODEL_MODE=fake` run exercises: R3's two real AgentPort calls,
    backed by the real FakeAdapter and these canned replies, publish a complete debrief.v1 -- scored, with
    a scorable rubric whose dimension scores are not all the same trivial value (D5's closure score differs
    from D1-D4's, since no finding is committed in this fixture, not a flat constant across every run)."""
    storage = FakeStorage(MIN_QUESTIONS + 2)
    debrief = run(publish_session_debrief(storage.deps(), CTX, SESSION_ID))

    assert debrief["schema_version"] == "debrief.v1"
    assert debrief["scored"] is True
    assert debrief["rubric"]["scorable"] is True
    assert debrief["rubric"]["total"] is not None
    dims = debrief["rubric"]["dimensions"]
    assert len(dims) == len(CHECKS)
    scores = {d["score"] for d in dims}
    assert len(scores) > 1  # not every dimension landed on the same score
    assert len(storage.rubric_scores) == 1
    assert storage.published[SESSION_ID] == debrief
    # The call actually went through the real port, not a stub: usage settled against the in-memory guard,
    # one reservation per R3 call (r3_subject then r3_investigator).
    expected_r3_calls = 2
    assert len(storage.budget.reservations) == expected_r3_calls


def test_the_assistant_call_refuses_na_on_every_subcheck_its_triggers_list() -> None:
    """The validation context names the sub-checks the input's code-built triggers list (S2 7.3), so an `na` on
    one of them is a schema failure the one repair answers, never a stored report the scorer refuses."""
    data = dataclasses.replace(
        trial_data(4),
        released=[
            {
                "record_id": "rec-01",
                "title": "Work order",
                "content": {"body": "Work order at 09:00."},
                "released_after": 1,
                "date": None,
            }
        ],
    )
    triggers = build_triggers(data, _empty_subject_report(), "investigator")
    assert {t.subcheck_id for t in triggers} == {"3c"}
    call = assistant_agent_call(
        build_assistant_input(data, "investigator", triggers), REFEREE, RUBRIC, data.trial_id, "r3_investigator"
    )
    assert isinstance(call.validation_context, RefAsstContext)
    assert call.validation_context.applicable_subcheck_ids == frozenset({"3c"})
    finding = FindingProjection(
        label="insufficient_evidence",
        likelihood="roughly_even_chance",
        confidence="low",
        rationale="Not yet tested against the work orders.",
        corroboration_needed=["the work orders"],
        alternative_explanations=[],
    )
    inp = build_assistant_input(data, "investigator", triggers)
    assert _applicable(inp.model_copy(update={"finding": finding})) == frozenset({"3c", "5c", "5e"})
    truthful = finding.model_copy(update={"label": "truthful", "likelihood": "unlikely"})
    assert _applicable(inp.model_copy(update={"finding": truthful})) == frozenset({"3c", "5c"})
