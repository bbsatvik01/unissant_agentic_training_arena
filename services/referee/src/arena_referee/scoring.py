"""R1 (`referee_subject`) then R2 (`referee_assistant`) on one trial (S2 7.1-7.3; AT-REF-1 ordering): R2 never
starts before R1's report is stored and validated. Every dependency (the database reads and writes, the agent
port call) is injected as a plain async callable, so the ordering and the resumability (S2 7.1: "a re-run of
the scoring route skips every stage whose row exists") are unit-tested against fakes, with no connection and
no model call.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from arena_core.agents.manifests import PromptSet
from arena_core.agents.referee_prompts import (
    RefereeAssistantInput,
    RefereeSubjectInput,
    build_referee_assistant_prompt,
    build_referee_subject_prompt,
    empty_subject_report,
)
from arena_core.agents.rubric import Rubric, canonical_rubric, manifest_rubric
from arena_core.contracts.adapter import adapt_subject_report
from arena_core.contracts.common import turn_id
from arena_core.contracts.referee import (
    RefAsstContext,
    RefereeAssistantReport,
    RefereeSubjectReport,
    RefSubjContext,
    apply_quote_check,
)
from arena_core.providers.types import AgentCall, CallContext, Message
from arena_core.referee.pipeline import ValidityDecision, decide_validity, independent_label_rows
from arena_core.spend.limits import REFEREE_COMBINATIONS, CallType
from arena_referee.mapping import TrialData, build_assistant_input, build_subject_input, build_triggers

RefereeSubjectCall = Callable[[AgentCall[RefereeSubjectReport]], Awaitable[RefereeSubjectReport]]
RefereeAssistantCall = Callable[[AgentCall[RefereeAssistantReport]], Awaitable[RefereeAssistantReport]]
Purpose = Literal["referee_subject", "r3_subject", "referee_assistant", "r3_investigator"]
AssistantMode = Literal["assistant", "investigator"]
ASSISTANT_PURPOSE_FOR_MODE: dict[AssistantMode, Literal["referee_assistant", "r3_investigator"]] = {
    "assistant": "referee_assistant",
    "investigator": "r3_investigator",
}


def default_dev_rubric() -> Rubric:
    """S2 7.4: rubric.v1's real, published text (`arena_core.agents.rubric.canonical_rubric`, spec S3 2.3-2.7),
    for a referee manifest built without its own `rubric.v1` file registered (`manifests.referee_manifest
    (rubric=None)`; such a manifest cannot freeze, `manifests.check_referee_freeze`). The default manifest now
    registers the real file, so `dev_rubric_for` below is what callers should use: it falls back to this only
    when the manifest's own prompts carry none."""
    return canonical_rubric()


def dev_rubric_for(prompts: PromptSet) -> Rubric | None:
    """`None` once `prompts` already carries its own `rubric.v1` (`manifest_rubric`, true for the default
    referee manifest, S2 3.4/7.4): the assistant/investigator prompt builder then renders that file directly,
    and a development placeholder passed alongside it would conflict (`ManifestMismatchError`, "cannot replace
    it"). Only a manifest built with no rubric.v1 registered (`referee_manifest(rubric=None)`) still needs the
    development fallback (`default_dev_rubric`)."""
    return None if manifest_rubric(prompts) is not None else default_dev_rubric()


@dataclass(frozen=True, kw_only=True)
class PromptContext:
    """The manifest's rendered prompts and, only when the manifest carries no `rubric.v1` of its own
    (`dev_rubric_for`), the development rubric (S2 7.4, `default_dev_rubric`); `referee_assistant` and
    `r3_investigator` both render from whichever one applies."""

    prompts: PromptSet
    rubric: Rubric | None


class ScoringError(RuntimeError):
    """A scoring stage returned something `score_trial`'s caller cannot act on."""


@dataclass(frozen=True, kw_only=True)
class ScoringDeps:
    """Every piece of IO `score_trial` needs, injected so the ordering is testable without a database.

    `get_judgment`: the stored payload for an idempotency key, or None (resumability, S2 7.1).
    `store_labels`: trial, labeler, rows (`sealed.record_independent_labels`'s shape), prompt hash.
    `store_judgment`: trial, kind, rater_id, payload, idempotency_key (`sealed.record_judgment`).
    `adjudicate_valid`: trial, reason, evidence_ref -- called only for an automatic `valid` (S3 4.2 item 1);
    a proposed `subject_invalid` is left for the admin console's blinded human review (S3 4.2 item 2).
    `run_subject_call` / `run_assistant_call`: one logical referee call through the agent port.
    `prompt_sha256`: the manifest's own hash, stored alongside each label and judgment row.
    """

    fetch_trial_data: Callable[[str], Awaitable[TrialData]]
    get_judgment: Callable[[str], Awaitable[Mapping[str, Any] | None]]
    store_labels: Callable[[str, str, list[dict[str, Any]], str], Awaitable[None]]
    store_judgment: Callable[[str, str, str | None, Mapping[str, Any], str], Awaitable[None]]
    adjudicate_valid: Callable[[str, str, str], Awaitable[None]]
    run_subject_call: RefereeSubjectCall
    run_assistant_call: RefereeAssistantCall
    prompt_sha256: str


@dataclass(frozen=True)
class ScoreResult:
    subject_report: RefereeSubjectReport
    assistant_report: RefereeAssistantReport
    validity: ValidityDecision


def _subject_context(inp: RefereeSubjectInput) -> RefSubjContext:
    return RefSubjContext(
        subject_turn_ids=tuple(turn_id(t.turn_no) for t in inp.transcript),
        canonical_fact_ids=frozenset(f.id for f in inp.canonical_facts),
        visible_record_ids=frozenset([d.doc_id for d in inp.initial_documents] + [r.record_id for r in inp.released]),
    )


def _applicable(inp: RefereeAssistantInput) -> frozenset[str]:
    """The sub-checks code knows apply here (scored by `scoring.rubric` with an `na` refused): each one a listed
    trigger names, 5c when a finding was committed, 5e when it is insufficient_evidence (S3 2.7)."""
    out = {t.subcheck_id for t in inp.triggers}
    if inp.finding is not None:
        out.add("5c")
        if inp.finding.label == "insufficient_evidence":
            out.add("5e")
    return frozenset(out)


def _assistant_context(inp: RefereeAssistantInput, rubric: Rubric) -> RefAsstContext:
    return RefAsstContext(
        flag_refs=frozenset(f.flag_ref for f in inp.flags),
        followup_turn_ids=frozenset(f.turn_id for f in inp.followups),
        citation_ids=frozenset([*(turn_id(t) for t in inp.citations.cited_turns), *inp.citations.cited_records]),
        rubric_subcheck_ids=frozenset(s.id for dim in rubric.dimensions for s in dim.subchecks),
        transcript_turn_ids=frozenset(turn_id(t.turn_no) for t in inp.transcript),
        applicable_subcheck_ids=_applicable(inp),
    )


def subject_agent_call(
    inp: RefereeSubjectInput, prompts: PromptSet, trial_id: str, purpose: Purpose
) -> AgentCall[RefereeSubjectReport]:
    prompt = build_referee_subject_prompt(inp, prompts)
    model, thinking = REFEREE_COMBINATIONS[purpose]
    return AgentCall(
        model=model,
        thinking=thinking,
        system=prompt.system_instruction,
        messages=(Message("user", prompt.user_message),),
        schema=RefereeSubjectReport,
        context=CallContext(
            call_type=CallType.REFEREE,
            purpose=purpose,
            step_key=f"{trial_id}:{purpose}",
            trial_id=UUID(trial_id),
            data_class="evaluator",
        ),
        validation_context=_subject_context(inp),
        salt=prompt.salt,
    )


def assistant_agent_call(
    inp: RefereeAssistantInput, prompts: PromptSet, rubric: Rubric | None, trial_id: str, purpose: Purpose
) -> AgentCall[RefereeAssistantReport]:
    prompt = build_referee_assistant_prompt(inp, prompts, dev_rubric=rubric)
    # The rubric the prompt rendered: the manifest's rubric.v1 when it hashes one, else the development rubric
    # (the builder refuses any other combination), so the validation context always matches the prompt.
    rendered = manifest_rubric(prompts) or rubric
    model, thinking = REFEREE_COMBINATIONS[purpose]
    return AgentCall(
        model=model,
        thinking=thinking,
        system=prompt.system_instruction,
        messages=(Message("user", prompt.user_message),),
        schema=RefereeAssistantReport,
        context=CallContext(
            call_type=CallType.REFEREE,
            purpose=purpose,
            step_key=f"{trial_id}:{purpose}",
            trial_id=UUID(trial_id),
            data_class="evaluator",
        ),
        validation_context=_assistant_context(inp, rendered) if rendered is not None else None,
        salt=prompt.salt,
    )


def _evaluator_packet_like(data: TrialData) -> Mapping[str, Any]:
    return {"canonical_facts": data.canonical_facts}


async def run_r1(
    deps: ScoringDeps, data: TrialData, prompts: PromptSet, purpose: Literal["referee_subject", "r3_subject"]
) -> tuple[RefereeSubjectReport, ValidityDecision | None]:
    """R1 (or `r3_subject`): resumable by stage key, then stored (S2 7.2 derived values, S3 4.2 item 1). The
    validity decision is only meaningful for an interactive trial (`referee_subject`); R3 never adjudicates
    validity (training sessions are not tournament interviews, S4 `ledger.adjudicate_validity`)."""
    stage_key = f"{data.trial_id}:{purpose}"
    stored = await deps.get_judgment(stage_key)
    if stored is not None:
        # `apply_quote_check` blanks an invalid `evidence_quote` to "" (S2 7.2); re-running it on an
        # already-blanked report cannot tell "no quote given" from "had a quote that didn't match" (both
        # read as falsy) and would recompute the wrong rationale for that turn's label, so the stored
        # judgment carries the original check's `quote_invalid` turn IDs alongside the report and both are
        # read back directly rather than re-derived.
        report = RefereeSubjectReport.model_validate(stored["report"])
        invalid = frozenset(stored["quote_invalid"])
    elif not data.transcript:
        report, invalid = empty_subject_report(), frozenset()
    else:
        inp = build_subject_input(data)
        call = subject_agent_call(inp, prompts, data.trial_id, purpose)
        raw = await deps.run_subject_call(call)
        answers = {turn_id(t["turn_no"]): t["answer"] for t in data.transcript}
        report, invalid = apply_quote_check(raw, answers)
    # The judgment is stored BEFORE the labels, and both run on every call, never only on the fresh-model-
    # call path: a crash between the two stores (or before either) resumes into the `stored is not None`
    # branch above once the judgment lands, re-deriving the exact same labels from it deterministically and
    # storing them for the first time -- never a second, possibly different, model call racing against
    # labels a first attempt already committed. Labels-before-judgment (the one-sided version of this) left
    # a trial permanently wedged: a crash after labels landed but before the judgment did meant every retry
    # re-called the model, and any output drift tripped AR003 against the labels already on record.
    payload = {"report": report.model_dump(mode="json"), "quote_invalid": sorted(invalid)}
    await deps.store_judgment(data.trial_id, "fidelity_detail", None, payload, stage_key)
    labels = adapt_subject_report(report, invalid)
    await deps.store_labels(data.trial_id, "model", independent_label_rows(labels), deps.prompt_sha256)
    # The validity decision is recomputed on every call (pure and cheap from the stored report); on resume
    # `adjudicate_valid` reaches the same idempotent S4 function with the same evidence_ref, so a repeat is
    # a no-op (ledger.adjudicate_validity returns the existing adjudication for a reused key).
    decision: ValidityDecision | None = None
    if purpose == "referee_subject":
        decision = decide_validity(report, _evaluator_packet_like(data))
        if decision.auto_recordable:
            await deps.adjudicate_valid(data.trial_id, decision.reason, stage_key)
    return report, decision


async def run_r2(
    deps: ScoringDeps,
    data: TrialData,
    ctx: PromptContext,
    subject_report: RefereeSubjectReport,
    mode: AssistantMode,
) -> RefereeAssistantReport:
    """R2 (or `r3_investigator`): never called until `run_r1`'s report for this trial has returned (AT-REF-1
    scheduling test) -- the caller (`score_trial`) enforces this by awaiting `run_r1` first."""
    # Known gap (Codex round 1 on WP-rubric-v1, recorded and skipped per D-022's "rare edge case" posture): the
    # stored-judgment key below carries no rubric or prompt fingerprint, so a trial whose R2 report was already
    # cached before a rubric content change (this change included) is resumed from that cache and published
    # under the new `rubric_sha256`, not re-judged against the new text. Needs a cache key or a stored fingerprint
    # versioned by `lineage_checked_sha256()`; not attempted here (local demo, short-lived synthetic sessions).
    purpose = ASSISTANT_PURPOSE_FOR_MODE[mode]
    flag_key, qq_key = f"{data.trial_id}:{purpose}:flag_support", f"{data.trial_id}:{purpose}:questioning_quality"
    stored = await deps.get_judgment(flag_key)
    if stored is not None:
        report = RefereeAssistantReport.model_validate(stored)
    else:
        triggers = build_triggers(data, subject_report, mode)
        inp = build_assistant_input(data, mode, triggers)
        call = assistant_agent_call(inp, ctx.prompts, ctx.rubric, data.trial_id, purpose)
        report = await deps.run_assistant_call(call)
        await deps.store_judgment(data.trial_id, "flag_support", None, report.model_dump(mode="json"), flag_key)
    # Stored independently of flag_support (both rows derive from the same report, so re-submitting is a
    # no-op once it exists): a process that died after flag_support but before questioning_quality resumes
    # by repairing the missing row here, rather than returning early and leaving it permanently absent.
    if await deps.get_judgment(qq_key) is None:
        await deps.store_judgment(data.trial_id, "questioning_quality", None, report.model_dump(mode="json"), qq_key)
    return report


async def score_trial(deps: ScoringDeps, trial_id: str, ctx: PromptContext) -> ScoreResult:
    """The whole S2 7.1 sequence for one interactive trial: R1 then R2, in that order, resumable at either
    stage (S2 7.1)."""
    data = await deps.fetch_trial_data(trial_id)
    subject_report, decision = await run_r1(deps, data, ctx.prompts, "referee_subject")
    assistant_report = await run_r2(deps, data, ctx, subject_report, "assistant")
    if decision is None:
        msg = "referee_subject always returns a validity decision"
        raise ScoringError(msg)
    return ScoreResult(subject_report=subject_report, assistant_report=assistant_report, validity=decision)


async def score_corpus_trial(deps: ScoringDeps, trial_id: str, prompts: PromptSet) -> ValidityDecision:
    """R1 on a `replay_corpus` transcript, with its initial validity verdict (S5 5.3; BKO-6). No R2: a
    corpus trial has no assistant."""
    data = await deps.fetch_trial_data(trial_id)
    _report, decision = await run_r1(deps, data, prompts, "referee_subject")
    if decision is None:
        msg = "referee_subject always returns a validity decision"
        raise ScoringError(msg)
    return decision


async def score_replay_trial(
    deps: ScoringDeps, trial_id: str, ctx: PromptContext, source_subject_report: RefereeSubjectReport
) -> RefereeAssistantReport:
    """R2 on a `replay` trial, against its source corpus transcript's already-stored R1 report (S5 5.3; D2):
    the labels transfer unchanged, since the replay trial's turns are copies of the source's, so R1 never
    runs again for this trial."""
    data = await deps.fetch_trial_data(trial_id)
    return await run_r2(deps, data, ctx, source_subject_report, "assistant")
