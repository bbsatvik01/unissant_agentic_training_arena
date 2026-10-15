"""R3 and `debrief.v1` publication (S2 7.5; S4 D8; S3 5.7; S5 5.4). R3 is the two referee calls run in
investigator mode on a training session (`r3_subject` then `r3_investigator`, S2 7.5): the same `run_r1`/
`run_r2` as an interactive trial's R1/R2, just with the session's own investigator questions in place of an
assistant's proposals. A voice session runs the same R3 over its stored exchanges, read as question-and-answer turns
(`arena_referee.db.fetch_trial_data`; UI v2 amendment to D7), and publishes the same scored debrief.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from arena_core.agents.post_checks import lexicon_pattern
from arena_core.contracts.adapter import adapt_subject_report, contradiction_triggers, verdicts_by_key
from arena_core.contracts.citations import Turn
from arena_core.contracts.common import Label
from arena_core.contracts.debrief import Debrief
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.contracts.rendered import clean
from arena_core.referee.pipeline import ScoredDebriefInputs, assemble_scored_debrief
from arena_core.safety.demeanor import DEMEANOR_LEXICON
from arena_core.scoring.rubric import (
    Closure,
    RubricResult,
    score_rubric,
)
from arena_core.scoring.rubric import investigator_questions as rubric_investigator_questions
from arena_core.scoring.rubric import triggers_from as rubric_triggers_from
from arena_referee.mapping import (
    TrialData,
    adapted_cards,
    available_after,
    investigator_turn_numbers,
    question_sources,
    record_released_after,
    trial_rows,
)
from arena_referee.scoring import PromptContext, ScoringDeps, run_r1, run_r2

_DEMEANOR_PATTERN = lexicon_pattern(DEMEANOR_LEXICON)


def demeanor_hit(text: str) -> bool:
    """S2 4.4's lexicon (the same `lexicon_pattern` the coach post-check uses), applied to a finding's
    rationale or an investigator question: raw text and `clean`-rendered text alike, so a disguised form
    cannot hide a term."""
    return _DEMEANOR_PATTERN.search(text) is not None or _DEMEANOR_PATTERN.search(clean(text)) is not None


async def run_r3(
    deps: ScoringDeps, data: TrialData, ctx: PromptContext
) -> tuple[RefereeSubjectReport, RefereeAssistantReport]:
    """`r3_subject` then `r3_investigator` (S2 7.5): `r3_investigator` runs only after `r3_subject` validates
    (the same ordering `run_r2` enforces for R2, AT-REF-1)."""
    subject_report, _ = await run_r1(deps, data, ctx.prompts, "r3_subject")
    assistant_report = await run_r2(deps, data, ctx, subject_report, "investigator")
    return subject_report, assistant_report


def investigator_rubric_result(
    data: TrialData,
    subject_report: RefereeSubjectReport,
    assistant_report: RefereeAssistantReport,
    committed_finding: StoredFinding | None,
) -> RubricResult:
    """S3 2.2's investigator rubric from R3's two reports: unscorable below three questions (S3 2.2, SG2-38),
    computed by `score_rubric` itself, so nothing here special-cases it."""
    available = available_after(data)
    sources = question_sources(data)
    question_text = {t["turn_no"]: t["question"] for t in data.transcript}
    lexicon_hits = frozenset(n for n in investigator_turn_numbers(data) if demeanor_hit(question_text[n]))
    questions = rubric_investigator_questions(sources, assistant_report.followups, lexicon_hits)
    labels = adapt_subject_report(subject_report, frozenset())
    contradictions = contradiction_triggers(subject_report, available)
    triggers = rubric_triggers_from(labels, record_released_after(data), contradictions)
    turns = {t["turn_no"]: Turn(answer=t["answer"], partial=False) for t in data.transcript}
    closure = Closure(
        finding=committed_finding,
        turns=turns,
        records=trial_rows(data).records,
        as_of=len(data.transcript),
        demeanor_in_rationale=committed_finding is not None and demeanor_hit(committed_finding.rationale),
        citations=tuple(assistant_report.citations),
    )
    return score_rubric(questions, triggers, assistant_report.subchecks, closure)


@dataclass(frozen=True, kw_only=True)
class DebriefProvenance:
    """`debrief.v1`'s `provenance` block (S3 5.7): fixed for the referee's current frozen state."""

    rubric_sha256: str
    r3_prompt_sha256: tuple[str, str]
    referee_model_ids: tuple[str, str]
    scorer_git_sha: str


@dataclass(frozen=True, kw_only=True)
class SessionInfo:
    """What `publish_session_debrief` needs about the session beyond its trial's own data (S5 5.4)."""

    trial_id: str
    voice: bool  # scored like text since the UI v2 amendment to D7; kept for the caller's own reporting
    trial_status: str
    evaluator_packet: Mapping[str, Any]
    committed_finding: StoredFinding | None


class SessionNotEndedError(RuntimeError):
    """`training.publish_debrief` itself refuses this (AR001: "a debrief follows the end of the session"),
    but only after R3's model calls and writes have already run; checked here first so a request on a
    running session fails fast instead of wasting them."""


@dataclass(frozen=True, kw_only=True)
class DebriefDeps:
    scoring: ScoringDeps
    fetch_session: Callable[[str], Awaitable[SessionInfo]]
    get_debrief: Callable[[str], Awaitable[Mapping[str, Any] | None]]
    publish_debrief: Callable[[str, Mapping[str, Any]], Awaitable[None]]
    store_rubric_score: Callable[[str, RubricResult, str], Awaitable[None]]
    provenance: DebriefProvenance


def _committed_label(finding: StoredFinding | None) -> Label | None:
    return None if finding is None else finding.label


_ENDED_TRIAL_STATUSES = frozenset({"finalized", "terminated"})


async def publish_session_debrief(deps: DebriefDeps, ctx: PromptContext, session_id: str) -> Mapping[str, Any]:
    """`POST /api/sessions/{id}/debrief` (S5 5.4): idempotent per session, zero model calls on a repeat."""
    existing = await deps.get_debrief(session_id)
    if existing is not None:
        return existing
    session = await deps.fetch_session(session_id)
    if session.trial_status not in _ENDED_TRIAL_STATUSES:
        msg = f"session {session_id}'s trial has status {session.trial_status!r}, not yet ended"
        raise SessionNotEndedError(msg)
    label = _committed_label(session.committed_finding)
    data = await deps.scoring.fetch_trial_data(session.trial_id)
    subject_report, assistant_report = await run_r3(deps.scoring, data, ctx)
    rubric_result = investigator_rubric_result(data, subject_report, assistant_report, session.committed_finding)
    if rubric_result.scorable:
        await deps.store_rubric_score(session_id, rubric_result, deps.provenance.rubric_sha256)
    cards = adapted_cards(data)
    debrief: Debrief = assemble_scored_debrief(
        ScoredDebriefInputs(
            session_id=session_id,
            evaluator_packet=session.evaluator_packet,
            committed_label=label,
            subject_report=subject_report,
            quote_invalid=frozenset(),
            rubric_result=rubric_result,
            cards=cards,
            flag_verdicts=verdicts_by_key(cards, assistant_report),
            trial_rows=trial_rows(data),
            rubric_sha256=deps.provenance.rubric_sha256,
            r3_prompt_sha256=deps.provenance.r3_prompt_sha256,
            referee_model_ids=list(deps.provenance.referee_model_ids),
            scorer_git_sha=deps.provenance.scorer_git_sha,
        )
    )
    payload = debrief.model_dump(mode="json")
    await deps.publish_debrief(session_id, payload)
    return payload
