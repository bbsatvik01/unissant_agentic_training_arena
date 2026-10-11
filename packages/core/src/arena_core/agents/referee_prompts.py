"""Referee prompt builders: R1 (J1, J2) and R2 (J3, J4), and R3 in investigator mode (S2 7; AT-REF-1).

Imported by `arena_referee` only (`tools/check_roles.py` refuses it in `arena_api` and `arena_tournament`).

- `build_referee_subject_prompt` (purposes `referee_subject`, `r3_subject`) takes a `RefereeSubjectInput`: the
  canonical facts, the subject's ledger, the initial documents, the released records with their release turns and
  the transcript. It has no field for the subject's tag proposals, coaching output, candidate identity, committed
  finding or role word (S2 7.1); the ledger is rendered without gate status and with each gate's precondition
  records (C-20), and the role selects nothing.
- `build_referee_assistant_prompt` (purposes `referee_assistant`, `r3_investigator`) takes a
  `RefereeAssistantInput`: the public case file, the released records, the transcript, the flags that passed the
  citation check (deduplicated), the follow-ups (or the investigator's questions), the committed finding only as a
  `FindingProjection`, the finding's cited IDs and the code-built `TriggerEntry` list. A trigger carries a
  sub-check ID and turn or record IDs only, never a label word, a fidelity check or an R1 quote (C-12), and the
  trusted blocks carry identifiers only (D5). The rubric's names and sub-check texts are rendered from `Rubric`
  (spec S3's `rubric.v1`, S2 7.4); anchors are never sent.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from arena_core.agents.coach_prompts import Prompt
from arena_core.agents.manifests import ManifestMismatchError, PromptSet
from arena_core.agents.render import (
    NONE,
    case_values,
    flag_line,
    lines_or_none,
    record_text,
    released_records,
    transcript,
)
from arena_core.agents.rubric import Rubric, manifest_rubric
from arena_core.agents.subject_prompts import STYLE_AXES, LedgerView, SubjectPacket, ledger
from arena_core.agents.templates import TemplateError, join_blocks, render, require
from arena_core.agents.untrusted import check_salt, clean, new_salt, wrap
from arena_core.agents.views import InitialDocument, PublicCase, Question, ReleasedRecord, TranscriptTurn
from arena_core.contracts.coaching import StoredFlag, Tactic
from arena_core.contracts.common import (
    MAX_TURNS,
    AlternativeExplanation,
    CitableRecordId,
    Confidence,
    Contract,
    Corroboration,
    FactId,
    Label,
    Likelihood,
    Rationale,
    TurnId,
    TurnNo,
    turn_id,
)
from arena_core.contracts.findings import Finding, StoredFinding
from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS, RefereeSubjectReport, Trajectory
from arena_core.contracts.rendered import rendered_overruns
from arena_core.contracts.review import MAX_TRIGGERS, TriggerEntry

# ICD 203 terms and ranges (S2 4.2), rendered for the finding projection; the model never types numbers.
LIKELIHOOD_TERMS: dict[str, tuple[str, str]] = {
    "almost_no_chance": ("almost no chance", "01-05%"),
    "very_unlikely": ("very unlikely", "05-20%"),
    "unlikely": ("unlikely", "20-45%"),
    "roughly_even_chance": ("roughly even chance", "45-55%"),
    "likely": ("likely", "55-80%"),
    "very_likely": ("very likely", "80-95%"),
    "almost_certain": ("almost certain", "95-99%"),
}


class CanonicalFact(Contract):
    """One canonical fact as R1 sees it: ID and statement only (no materiality, tag or role field, SG2-07)."""

    id: FactId
    statement: Annotated[str, StringConstraints(min_length=1, max_length=400)]


class RefereeSubjectInput(Contract):
    """Everything R1 (and R3's `r3_subject`) may read (S2 7.1)."""

    canonical_facts: Annotated[list[CanonicalFact], Field(min_length=1, max_length=40)]
    packet: SubjectPacket
    initial_documents: Annotated[list[InitialDocument], Field(min_length=1, max_length=4)]
    released: Annotated[list[ReleasedRecord], Field(max_length=6)]
    # Empty when the first answer was quarantined (S2 6.10): there is nothing to label, and no prompt is built.
    transcript: Annotated[list[TranscriptTurn], Field(max_length=MAX_TURNS)]

    @model_validator(mode="after")
    def _turns(self) -> Self:
        if [t.turn_no for t in self.transcript] != list(range(1, len(self.transcript) + 1)):
            msg = "transcript: turns must be 1..n in order"
            raise ValueError(msg)
        return self


class NoSubjectAnswerError(ValueError):
    """R1 has no answer to label (the first answer was quarantined, S2 6.10)."""


def empty_subject_report() -> RefereeSubjectReport:
    """R1's report for a trial with no committed answer: no turn labeled, nothing invented (S2 6.10: R1 never
    labels a nonexistent answer); the quarantined turn counts against the subject through its quarantine record."""
    return RefereeSubjectReport(
        schema_version="ref_subj.v5", turns=[], trajectory=Trajectory(self_consistent=True, conflicts=[])
    )


class FindingProjection(Contract):
    """The committed finding as a referee receives it (S2 7.3, D5): no candidate, role, outcome or basis refs."""

    label: Label
    likelihood: Likelihood
    confidence: Confidence
    rationale: Rationale
    corroboration_needed: Annotated[list[Corroboration], Field(max_length=3)]
    alternative_explanations: Annotated[list[AlternativeExplanation], Field(max_length=3)]

    @model_validator(mode="after")
    def _rendered(self) -> Self:
        overruns = rendered_overruns(self)
        if overruns:
            raise ValueError("; ".join(overruns))
        return self

    @classmethod
    def of(cls, finding: StoredFinding | Finding, alternatives: list[str] | None = None) -> FindingProjection:
        stored = getattr(finding, "alternative_explanations", None)
        return cls(
            label=finding.label,
            likelihood=finding.likelihood,
            confidence=finding.confidence,
            rationale=finding.rationale,
            corroboration_needed=list(finding.corroboration_needed),
            alternative_explanations=list(alternatives if alternatives is not None else stored or []),
        )


class FindingCitations(Contract):
    """The finding's stored `cited_turns` and `cited_records`: the trusted "Finding citations" block (IDs only)."""

    cited_turns: Annotated[list[TurnNo], Field(max_length=12)]
    cited_records: Annotated[list[CitableRecordId], Field(max_length=10)]


class FollowUpLine(Contract):
    """A proposed follow-up (tactic set) or, in investigator mode, an investigator question (tactic null)."""

    turn_id: TurnId
    tactic: Tactic | None
    question: Question


class RefereeAssistantInput(Contract):
    """Everything R2 (and R3's `r3_investigator`) may read (S2 7.1, 7.3, 7.5)."""

    mode: Literal["assistant", "investigator"]
    case: PublicCase
    released: Annotated[list[ReleasedRecord], Field(max_length=6)]
    transcript: Annotated[list[TranscriptTurn], Field(min_length=1, max_length=MAX_TURNS)]
    flags: Annotated[list[StoredFlag], Field(max_length=3 * MAX_TURNS)]
    followups: Annotated[list[FollowUpLine], Field(max_length=MAX_TURNS)]
    # None when no finding was committed (an `assistant_failed` trial, S2 10): the flags and follow-ups are still
    # judged, and the finding block says so instead of carrying a fabricated finding.
    finding: FindingProjection | None
    citations: FindingCitations
    triggers: Annotated[list[TriggerEntry], Field(max_length=MAX_TRIGGERS)]

    @model_validator(mode="after")
    def _mode(self) -> Self:
        if any((f.tactic is None) != (self.mode == "investigator") for f in self.followups):
            msg = "followups: a tactic on every assistant follow-up and on no investigator question"
            raise ValueError(msg)
        if self.finding is None and (self.citations.cited_turns or self.citations.cited_records):
            msg = "citations: a trial without a committed finding has no finding citations"
            raise ValueError(msg)
        return self


def rubric_subchecks(rubric: Rubric) -> str:
    """S2 7.3: each dimension's name, then every sub-check other than the five asked per question. The texts are
    rendered through the same cleaning as every other text (`clean`), so the rubric's byte caps, measured on that
    form, bound what the prompt carries."""
    lines: list[str] = []
    for dim in rubric.dimensions:
        lines.append(f"{dim.dim_id} {clean(dim.name)}")
        lines += [f"{s.id}: {clean(s.text)}" for s in dim.subchecks if s.id not in PER_QUESTION_SUBCHECKS]
    return "\n".join(lines)


def finding_projection(finding: FindingProjection, salt: str) -> str:
    """S2 7.3: the one renderer of a committed finding for a referee, inside its salted tag."""
    term, span = LIKELIHOOD_TERMS[finding.likelihood]
    body = "\n".join(
        [
            f"Label: {finding.label}",
            f"Likelihood: {term} ({span}) that the subject is concealing involvement in the matter under review",
            f"Confidence: {finding.confidence}",
            f"Rationale: {clean(finding.rationale)}",
            f"Corroboration needed: {'; '.join(clean(c) for c in finding.corroboration_needed) or NONE}",
            f"Alternative explanations: {'; '.join(clean(a) for a in finding.alternative_explanations) or NONE}",
        ]
    )
    return wrap("finding", body, salt)


def _citation_lines(citations: FindingCitations) -> str:
    return lines_or_none([*(turn_id(t) for t in citations.cited_turns), *citations.cited_records])


def _trigger_lines(triggers: list[TriggerEntry]) -> str:
    """`sub-check ID | trigger turn, turn pair or record | question turns to judge` (S2 7.3), IDs only."""
    lines = []
    for t in triggers:
        target = [turn_id(n) for n in t.trigger_turns] + ([t.trigger_record] if t.trigger_record else [])
        window = ", ".join(turn_id(n) for n in t.question_turns) or NONE
        lines.append(f"{t.subcheck_id} | {', '.join(target) or NONE} | {window}")
    return lines_or_none(lines)


def _followup_line(f: FollowUpLine) -> str:
    if f.tactic is None:
        return f'{f.turn_id} | "{clean(f.question)}"'
    return f'{f.turn_id} | {f.tactic} | "{clean(f.question)}"'


def _check(prompts: PromptSet) -> None:
    if prompts.manifest.kind != "referee":
        msg = f"manifest {prompts.manifest.candidate_id} is not the referee"
        raise TemplateError(msg)


def build_referee_subject_prompt(inp: RefereeSubjectInput, prompts: PromptSet, salt: str | None = None) -> Prompt:
    """R1 or `r3_subject` (S2 7.2)."""
    inp = require(inp, RefereeSubjectInput, "referee prompt builder")
    if not inp.transcript:
        msg = "no subject answer to label: R1 records empty_subject_report() for this trial instead (S2 6.10, 7.2)"
        raise NoSubjectAnswerError(msg)
    _check(prompts)
    salt = check_salt(salt or new_salt())
    packet = inp.packet
    documents = [f"{d.doc_id} | {d.kind} | {clean(d.title)}\n{record_text(d.content)}" for d in inp.initial_documents]
    user = render(
        prompts.user_template("subject.user.v1.txt"),
        {
            "canonical_facts": "\n".join(f"{f.id} | {clean(f.statement)}" for f in inp.canonical_facts),
            "ledger": ledger(packet, LedgerView(status=None, openable_after=True)),
            "permitted_behaviors": ", ".join(packet.permitted_behaviors) or NONE,
            "style": ", ".join(f"{axis} {packet.style.level(axis)}" for axis in STYLE_AXES),
            "salt": salt,
            "records": "\n".join([*documents, *([released_records(inp.released)] if inp.released else [])]),
            "transcript": transcript(inp.transcript),
            "last": turn_id(inp.transcript[-1].turn_no),
        },
    )
    return Prompt(join_blocks(prompts.assembly("referee_subject")), user, salt)


def build_referee_assistant_prompt(
    inp: RefereeAssistantInput, prompts: PromptSet, salt: str | None = None, dev_rubric: Rubric | None = None
) -> Prompt:
    """R2 or `r3_investigator` (S2 7.3, 7.5). The rubric is the `rubric.v1` file the manifest hashes, parsed from
    its verified bytes; a manifest without one (before spec S3 publishes it) renders the development placeholder
    passed as `dev_rubric`, and such a manifest cannot freeze (S2 7.4)."""
    inp = require(inp, RefereeAssistantInput, "referee prompt builder")
    _check(prompts)
    salt = check_salt(salt or new_salt())
    rubric = manifest_rubric(prompts)
    if rubric is not None and dev_rubric is not None:
        msg = "the referee manifest hashes rubric.v1; a development placeholder cannot replace it"
        raise ManifestMismatchError(msg)
    rubric = rubric or dev_rubric
    if rubric is None:
        msg = "no rubric: the referee manifest has no rubric.v1 and no development placeholder was given"
        raise ManifestMismatchError(msg)
    system = render(join_blocks(prompts.assembly("referee_assistant")), {"rubric_subchecks": rubric_subchecks(rubric)})
    user = render(
        prompts.user_template("assistant.user.v1.txt"),
        {
            "salt": salt,
            **case_values(inp.case),
            "released_records": released_records(inp.released),
            "transcript": transcript(inp.transcript),
            "flags": lines_or_none(flag_line(f) for f in inp.flags),
            "followups": lines_or_none(_followup_line(f) for f in inp.followups),
            "finding": NONE if inp.finding is None else finding_projection(inp.finding, salt),
            "finding_citations": _citation_lines(inp.citations),
            "triggers": _trigger_lines(inp.triggers),
        },
    )
    return Prompt(system, user, salt)
