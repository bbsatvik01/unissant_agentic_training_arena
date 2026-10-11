"""R3 and debrief.v1 publication (S2 7.5; S4 D8; S3 5.7; S5 5.4, 5.6), against fake dependencies."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine, Mapping
from typing import Any

import pytest

from arena_core.agents.manifests import load_prompts, referee_manifest, with_hash
from arena_core.agents.rubric import Rubric
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.providers.types import AgentCall
from arena_core.scoring.rubric import CHECKS, MIN_QUESTIONS, RubricResult
from arena_referee.debrief import (
    DebriefDeps,
    DebriefProvenance,
    SessionInfo,
    SessionNotEndedError,
    publish_session_debrief,
)
from arena_referee.mapping import TrialData
from arena_referee.scoring import PromptContext, ScoringDeps


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


def _turn(n: int) -> dict[str, Any]:
    return {"turn_no": n, "question": f"Question {n}?", "answer": f"Answer {n}.", "question_source": "investigator"}


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
        cards=[],
        final_finding=None,
    )


def subject_report(n_questions: int) -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": [
                {
                    "turn_id": f"t{n:02d}",
                    "label": "responsive",
                    "eva_subtype": None,
                    "pfq_reason": None,
                    "requested_fact_ids": [],
                    "asked_fact_status": "known",
                    "uncertainty_expressed": False,
                    "innocent_explanation_offered": False,
                    "record_conflict_ids": [],
                    "no_contradiction": True,
                    "no_invention": True,
                    "violated_fact_ids": [],
                    "uncertainty_respected": True,
                    "disclosure_policy_respected": True,
                    "in_character": True,
                    "style_followed": True,
                    "platform_attack": False,
                    "evidence_quote": "",
                }
                for n in range(1, n_questions + 1)
            ],
            "trajectory": {"self_consistent": True, "conflicts": []},
        }
    )


def assistant_report(n_questions: int) -> RefereeAssistantReport:
    followups = [
        {
            "turn_id": f"t{n:02d}",
            "question_type": "open",
            "not_leading": True,
            "well_framed": True,
            "no_loaded_wording": True,
            "on_objective": True,
            "builds_on_previous": True,
        }
        for n in range(1, n_questions + 1)
    ]
    # Always-applicable sub-checks (3a, 3b, 4a, 4c, 4d) plus 3d, which the referee always answers (its own
    # trigger, S3 2.2): "na" here since no question discloses a record.
    subchecks: list[dict[str, Any]] = [
        {"id": s, "result": "pass", "turn_ids": []} for s in ("3a", "3b", "4a", "4c", "4d")
    ]
    subchecks.append({"id": "3d", "result": "na", "turn_ids": []})
    return RefereeAssistantReport.model_validate(
        {"schema_version": "ref_asst.v2", "flags": [], "followups": followups, "citations": [], "subchecks": subchecks}
    )


class FakeDebriefDeps:
    def __init__(self, n_questions: int, *, voice: bool = False, trial_status: str = "finalized") -> None:
        self.n_questions = n_questions
        self.voice = voice
        self.trial_status = trial_status
        self.calls: list[str] = []
        self.judgments: dict[str, Mapping[str, Any]] = {}
        self.published: dict[str, Mapping[str, Any]] = {}
        self.rubric_scores: list[tuple[str, Any, str]] = []

    async def fetch_trial_data(self, _trial_id: str) -> TrialData:
        return trial_data(self.n_questions)

    async def get_judgment(self, key: str) -> Mapping[str, Any] | None:
        return self.judgments.get(key)

    async def store_labels(self, trial_id: str, labeler: str, rows: list[dict[str, Any]], prompt_sha256: str) -> None:
        pass

    async def store_judgment(
        self, _trial_id: str, _kind: str, _rater_id: str | None, payload: Mapping[str, Any], idempotency_key: str
    ) -> None:
        self.judgments[idempotency_key] = payload

    async def adjudicate_valid(self, trial_id: str, reason: str, evidence_ref: str) -> None:
        pass

    async def run_subject_call(self, _call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        self.calls.append("r1")
        return subject_report(self.n_questions)

    async def run_assistant_call(self, _call: AgentCall[RefereeAssistantReport]) -> RefereeAssistantReport:
        self.calls.append("r2")
        return assistant_report(self.n_questions)

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
            trial_id=TRIAL_ID,
            voice=self.voice,
            trial_status=self.trial_status,
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


def test_unscorable_session_publishes_scored_true_but_rubric_scorable_false() -> None:
    """S5 5.6: fewer than three questions runs R3, writes no rubric_scores row, publishes rubric.scorable
    false with a null total and no dimensions."""
    fake = FakeDebriefDeps(n_questions=MIN_QUESTIONS - 1)
    debrief = run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    assert debrief["scored"] is True
    assert debrief["rubric"]["scorable"] is False
    assert debrief["rubric"]["total"] is None
    assert debrief["rubric"]["dimensions"] == []
    assert fake.rubric_scores == []
    assert fake.calls == ["r1", "r2"]


def test_scorable_session_writes_a_rubric_score_row() -> None:
    fake = FakeDebriefDeps(n_questions=MIN_QUESTIONS)
    debrief = run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    assert debrief["rubric"]["scorable"] is True
    assert debrief["rubric"]["total"] is not None
    assert len(fake.rubric_scores) == 1


def test_a_voice_session_never_runs_r3() -> None:
    fake = FakeDebriefDeps(n_questions=MIN_QUESTIONS, voice=True)
    debrief = run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    assert debrief["scored"] is False
    assert "rubric" not in debrief
    assert fake.calls == []


def test_republishing_is_idempotent_and_calls_the_model_zero_times() -> None:
    fake = FakeDebriefDeps(n_questions=MIN_QUESTIONS)
    first = run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    calls_after_first = len(fake.calls)
    second = run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    assert second == first
    assert len(fake.calls) == calls_after_first


def test_publishing_on_a_running_session_is_refused_before_any_r3_work() -> None:
    """S5 5.4: `training.publish_debrief` itself refuses a running session's trial (AR001), but only after
    R3's model calls and writes already ran; this must fail first, with zero model calls and zero writes."""
    fake = FakeDebriefDeps(n_questions=MIN_QUESTIONS, trial_status="running")
    with pytest.raises(SessionNotEndedError):
        run(publish_session_debrief(fake.deps(), CTX, SESSION_ID))
    assert fake.calls == []
    assert fake.judgments == {}
    assert fake.rubric_scores == []
    assert fake.published == {}
