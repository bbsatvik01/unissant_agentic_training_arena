"""R1 then R2 ordering and resumability (S2 7.1; AT-REF-1 scheduling test), against fake dependencies: no
database, no model call."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Coroutine, Mapping
from dataclasses import replace
from typing import Any

import pytest

import arena_referee.scoring as scoring_module
from arena_core.agents.manifests import load_prompts, referee_manifest, with_hash
from arena_core.agents.rubric import Rubric
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.providers.types import AgentCall
from arena_core.scoring.rubric import CHECKS
from arena_referee.mapping import TrialData
from arena_referee.scoring import PromptContext, ScoreResult, ScoringDeps, run_r2, score_trial
from arena_referee.scoring import run_r1 as _run_r1


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


def trial_data() -> TrialData:
    return TrialData(
        trial_id="00000000-0000-0000-0000-00000000000a",
        split="dev",
        canonical_facts=[
            {"id": "f:01", "statement": "A fact.", "material": False},
            {"id": "f:02", "statement": "A material fact.", "material": True},
        ],
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
        transcript=[
            {
                "turn_no": 1,
                "question": "Why were you there?",
                "answer": "I had a work order.",
                "question_source": "investigator",
            }
        ],
        cards=[],
        final_finding=None,
    )


def subject_report() -> RefereeSubjectReport:
    return RefereeSubjectReport.model_validate(
        {
            "schema_version": "ref_subj.v5",
            "turns": [
                {
                    "turn_id": "t01",
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
            ],
            "trajectory": {"self_consistent": True, "conflicts": []},
        }
    )


def assistant_report() -> RefereeAssistantReport:
    return RefereeAssistantReport.model_validate(
        {"schema_version": "ref_asst.v2", "flags": [], "followups": [], "citations": [], "subchecks": []}
    )


class FakeDeps:
    """Records call order and resumes from a fake judgment store, exactly as `ScoringDeps` requires.

    `run_subject_call`/`run_assistant_call`/`store_labels` are plain instance attributes (assigned in
    `__init__`, not defined as methods on the class) so a test can swap one out for a scripted callable with
    the same signature by ordinary attribute assignment -- no `type: ignore[method-assign]` needed, since
    mypy's method-assignment restriction only applies to functions defined on the class itself.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.judgments: dict[str, Mapping[str, Any]] = {}
        self.labels: list[tuple[str, str, list[dict[str, Any]], str]] = []
        self.adjudications: list[tuple[str, str, str]] = []
        self.run_subject_call: Callable[[AgentCall[RefereeSubjectReport]], Awaitable[RefereeSubjectReport]] = (
            self._default_subject_call
        )
        self.run_assistant_call: Callable[[AgentCall[RefereeAssistantReport]], Awaitable[RefereeAssistantReport]] = (
            self._default_assistant_call
        )
        self.store_labels: Callable[[str, str, list[dict[str, Any]], str], Awaitable[None]] = self._default_store_labels

    async def fetch_trial_data(self, trial_id: str) -> TrialData:
        assert trial_id == trial_data().trial_id
        return trial_data()

    async def get_judgment(self, key: str) -> Mapping[str, Any] | None:
        return self.judgments.get(key)

    async def _default_store_labels(
        self, trial_id: str, labeler: str, rows: list[dict[str, Any]], prompt_sha256: str
    ) -> None:
        self.labels.append((trial_id, labeler, rows, prompt_sha256))

    async def store_judgment(
        self, _trial_id: str, _kind: str, _rater_id: str | None, payload: Mapping[str, Any], idempotency_key: str
    ) -> None:
        self.judgments[idempotency_key] = payload

    async def adjudicate_valid(self, trial_id: str, reason: str, evidence_ref: str) -> None:
        self.adjudications.append((trial_id, reason, evidence_ref))

    async def _default_subject_call(self, _call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        self.calls.append("r1")
        return subject_report()

    async def _default_assistant_call(self, _call: AgentCall[RefereeAssistantReport]) -> RefereeAssistantReport:
        self.calls.append("r2")
        return assistant_report()

    def deps(self) -> ScoringDeps:
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


def test_r2_never_runs_before_r1_for_a_trial() -> None:
    """AT-REF-1 scheduling test."""
    fake = FakeDeps()
    result = run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    assert fake.calls == ["r1", "r2"]
    assert isinstance(result, ScoreResult)


def test_a_clean_report_is_auto_adjudicated_valid() -> None:
    fake = FakeDeps()
    result = run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    assert result.validity.verdict == "valid"
    assert result.validity.auto_recordable is True
    assert len(fake.adjudications) == 1


def test_resuming_a_scored_trial_calls_the_model_zero_times() -> None:
    """S2 7.1: "a re-run of the scoring route skips every stage whose row exists"."""
    fake = FakeDeps()
    run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    first_calls = len(fake.calls)
    run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    assert len(fake.calls) == first_calls


def test_resuming_r1_only_still_runs_r2_once() -> None:
    """A crash between R1 and R2 resumes at R2, R1 is never re-run (S2 7.1)."""
    fake = FakeDeps()
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    assert fake.calls == ["r1"]
    run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    assert fake.calls == ["r1", "r2"]


def test_a_platform_attack_turn_proposes_subject_invalid_and_is_never_auto_recorded() -> None:
    fake = FakeDeps()

    async def attacked_subject_call(_call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        fake.calls.append("r1")
        report = subject_report()
        return report.model_copy(update={"turns": [report.turns[0].model_copy(update={"platform_attack": True})]})

    fake.run_subject_call = attacked_subject_call
    result = run(score_trial(fake.deps(), trial_data().trial_id, CTX))
    assert result.validity.verdict == "subject_invalid"
    assert result.validity.auto_recordable is False
    assert fake.adjudications == []


def test_run_r1_with_an_empty_transcript_returns_and_stores_the_empty_report() -> None:
    """S2 6.10: a trial with no committed answer never reaches the model; `run_r1` stores R1's fixed empty
    report directly (the `elif not data.transcript` branch)."""
    fake = FakeDeps()
    empty_trial = replace(trial_data(), transcript=[])
    report, decision = run(_run_r1(fake.deps(), empty_trial, REFEREE, "referee_subject"))
    assert report.turns == []
    assert fake.calls == []  # no model call
    assert decision is not None
    stage_key = f"{empty_trial.trial_id}:referee_subject"
    assert stage_key in fake.judgments


def test_score_trial_raises_if_run_r1_ever_returns_no_validity_decision(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defensive check: `run_r1("referee_subject", ...)` always computes a decision; `score_trial` still
    guards the invariant explicitly rather than trusting it silently."""

    async def fake_run_r1(
        _deps: ScoringDeps, _data: TrialData, _prompts: object, _purpose: str
    ) -> tuple[RefereeSubjectReport, None]:
        return subject_report(), None

    monkeypatch.setattr(scoring_module, "run_r1", fake_run_r1)
    fake = FakeDeps()
    with pytest.raises(scoring_module.ScoringError, match="always returns a validity decision"):
        run(score_trial(fake.deps(), trial_data().trial_id, CTX))


def test_run_r1_resuming_from_a_stored_report_re_derives_identical_labels() -> None:
    """A process that died after `store_labels` but before `store_judgment` (or crashed before either)
    resumes into the `stored is not None` branch; `store_labels`/`store_judgment` must still run and submit
    the exact same content the interrupted attempt did, since the real S4 functions accept identical
    resubmission as 'exists' but refuse (AR003) a stage key resubmitted with different content."""
    fake = FakeDeps()
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    assert len(fake.labels) == 1
    first_rows = fake.labels[0][2]
    first_judgment = fake.judgments[f"{trial_data().trial_id}:referee_subject"]

    # Simulate a resume: the judgment is already stored (fake.get_judgment finds it), no model call happens.
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    expected_label_calls = 2
    assert fake.calls == ["r1"]  # the model was never called a second time
    assert len(fake.labels) == expected_label_calls  # store_labels ran again on resume (the fix), not skipped
    assert fake.labels[1][2] == first_rows  # identical content: the real SQL would accept it, never AR003
    assert fake.judgments[f"{trial_data().trial_id}:referee_subject"] == first_judgment


def test_run_r1_resuming_a_report_with_a_quote_invalid_turn_keeps_the_same_rationale() -> None:
    """`apply_quote_check` blanks an invalid `evidence_quote` to "" (S2 7.2); re-running the check on an
    already-blanked report cannot tell "no quote given" from "had a quote that didn't match" -- both read
    as falsy -- and would recompute the wrong rationale for that turn's label on resume, which the real SQL
    would then reject as different content (AR003). The fix stores and reads back which turns were
    quote-invalid directly, instead of re-deriving it from the (by then blanked) report."""
    fake = FakeDeps()
    bad_quote_report = subject_report().model_copy(
        update={"turns": [subject_report().turns[0].model_copy(update={"evidence_quote": "not in the answer"})]}
    )

    async def bad_quote_call(_call: AgentCall[RefereeSubjectReport]) -> RefereeSubjectReport:
        fake.calls.append("r1")
        return bad_quote_report

    fake.run_subject_call = bad_quote_call
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    first_rows = fake.labels[0][2]
    assert first_rows[0]["rationale"] == "no quote: quote did not match"

    # Resume: the stored report already has this turn's quote blanked to "".
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    assert fake.calls == ["r1"]  # no second model call
    assert fake.labels[1][2] == first_rows  # same rationale on resume, not "no quote given"


def test_run_r1_crash_between_judgment_and_labels_resumes_without_a_second_model_call() -> None:
    """The judgment is stored before the labels specifically so a crash between the two resumes
    deterministically from the already-committed judgment, never by re-calling the model (whose output
    could differ and then conflict with labels a first attempt already committed, AR003)."""
    fake = FakeDeps()
    attempts = 0

    async def flaky_store_labels(trial_id: str, labeler: str, rows: list[dict[str, Any]], prompt_sha256: str) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            msg = "connection lost after the judgment landed"
            raise ConnectionError(msg)
        fake.labels.append((trial_id, labeler, rows, prompt_sha256))

    fake.store_labels = flaky_store_labels
    with contextlib.suppress(ConnectionError):
        run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    assert fake.calls == ["r1"]
    assert len(fake.labels) == 0  # the simulated crash prevented the first attempt's store

    # Resume: the judgment already landed before the simulated crash.
    run(_run_r1(fake.deps(), trial_data(), REFEREE, "referee_subject"))
    assert fake.calls == ["r1"]  # still no second model call
    assert len(fake.labels) == 1  # labels now stored, successfully, on the repair attempt


def test_run_r2_resuming_repairs_a_missing_questioning_quality_row() -> None:
    """A process that stored `flag_support` then died before `questioning_quality` resumes by writing the
    missing row from the already-stored report, with no second model call -- the row is never permanently
    absent just because the first attempt returned early."""
    fake = FakeDeps()
    data = trial_data()
    purpose = "referee_assistant"
    flag_key, qq_key = f"{data.trial_id}:{purpose}:flag_support", f"{data.trial_id}:{purpose}:questioning_quality"
    deps = fake.deps()
    report = run(run_r2(deps, data, CTX, subject_report(), "assistant"))
    assert fake.calls == ["r2"]
    assert flag_key in fake.judgments
    assert qq_key in fake.judgments
    # Simulate the interrupted process: questioning_quality never made it to the store.
    del fake.judgments[qq_key]

    repaired = run(run_r2(deps, data, CTX, subject_report(), "assistant"))
    assert fake.calls == ["r2"]  # still no second model call -- flag_support alone proves the stage is done
    assert qq_key in fake.judgments  # the missing row is repaired
    assert repaired.model_dump(mode="json") == report.model_dump(mode="json")
