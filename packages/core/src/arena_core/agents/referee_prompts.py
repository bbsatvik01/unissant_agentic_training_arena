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
from arena_core.agents.manifests import REFEREE_ASSISTANT_USER, REFEREE_SUBJECT_USER, PromptSet
from arena_core.agents.render import (
    NONE,
    case_values,
    flag_line,
    lines_or_none,
    record_text,
    released_records,
    transcript,
)
from arena_core.agents.subject_prompts import STYLE_AXES, LedgerView, SubjectPacket, ledger
from arena_core.agents.templates import TemplateError, join_blocks, render, require
from arena_core.agents.untrusted import check_salt, clean, new_salt, wrap
from arena_core.agents.views import InitialDocument, PublicCase, ReleasedRecord, TranscriptTurn
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
from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS

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
    transcript: Annotated[list[TranscriptTurn], Field(min_length=1, max_length=MAX_TURNS)]

    @model_validator(mode="after")
    def _turns(self) -> Self:
        if [t.turn_no for t in self.transcript] != list(range(1, len(self.transcript) + 1)):
            msg = "transcript: turns must be 1..n in order"
            raise ValueError(msg)
        return self


class FindingProjection(Contract):
    """The committed finding as a referee receives it (S2 7.3, D5): no candidate, role, outcome or basis refs."""

    label: Label
    likelihood: Likelihood
    confidence: Confidence
    rationale: Rationale
    corroboration_needed: Annotated[list[Corroboration], Field(max_length=3)]
    alternative_explanations: Annotated[list[AlternativeExplanation], Field(max_length=3)]

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


SubcheckId = Literal["2a", "2b", "3c", "3e", "4b"]
TriggerTarget = Annotated[str, StringConstraints(pattern=r"^(t(0[1-9]|1[0-2])|doc-0[1-4]|rec-0[1-6])$")]


class TriggerEntry(Contract):
    """One applicability trigger (C-12): a sub-check ID, its trigger turn, turn pair, record or turn-record pair,
    and the question turns to judge. IDs only."""

    subcheck_id: SubcheckId
    target: Annotated[list[TriggerTarget], Field(min_length=1, max_length=2)]
    window: Annotated[list[TurnId], Field(max_length=MAX_TURNS)]


class FollowUpLine(Contract):
    """A proposed follow-up (tactic set) or, in investigator mode, an investigator question (tactic null)."""

    turn_id: TurnId
    tactic: Tactic | None
    question: Annotated[str, StringConstraints(min_length=1, max_length=600)]


class RefereeAssistantInput(Contract):
    """Everything R2 (and R3's `r3_investigator`) may read (S2 7.1, 7.3, 7.5)."""

    mode: Literal["assistant", "investigator"]
    case: PublicCase
    released: Annotated[list[ReleasedRecord], Field(max_length=6)]
    transcript: Annotated[list[TranscriptTurn], Field(min_length=1, max_length=MAX_TURNS)]
    flags: Annotated[list[StoredFlag], Field(max_length=3 * MAX_TURNS)]
    followups: Annotated[list[FollowUpLine], Field(max_length=MAX_TURNS)]
    finding: FindingProjection
    citations: FindingCitations
    triggers: Annotated[list[TriggerEntry], Field(max_length=40)]

    @model_validator(mode="after")
    def _mode(self) -> Self:
        if any((f.tactic is None) != (self.mode == "investigator") for f in self.followups):
            msg = "followups: a tactic on every assistant follow-up and on no investigator question"
            raise ValueError(msg)
        return self


MAX_SUBCHECKS = 30  # S2 7.4: at most 30 sub-checks in total


class RubricSubcheck(Contract):
    id: Annotated[str, StringConstraints(pattern=r"^[1-5][a-e]$")]
    text: Annotated[str, StringConstraints(min_length=1, max_length=400)]
    na_when: Annotated[str, StringConstraints(min_length=1, max_length=400)] | None


class RubricDimension(Contract):
    dim_id: Literal["D1", "D2", "D3", "D4", "D5"]
    name: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    anchors_0_to_4: Annotated[list[str], Field(min_length=5, max_length=5)]
    subchecks: Annotated[list[RubricSubcheck], Field(min_length=2, max_length=8)]


class Rubric(Contract):
    """Spec S3's `rubric.v1` as S2 7.4 fixes its form."""

    rubric_version: Literal["rubric.v1"]
    dimensions: Annotated[list[RubricDimension], Field(min_length=5, max_length=5)]

    @model_validator(mode="after")
    def _ids(self) -> Self:
        ids = [s.id for d in self.dimensions for s in d.subchecks]
        if len(ids) > MAX_SUBCHECKS or len(set(ids)) != len(ids):
            msg = f"dimensions: at most {MAX_SUBCHECKS} distinct sub-check IDs"
            raise ValueError(msg)
        return self


def rubric_subchecks(rubric: Rubric) -> str:
    """S2 7.3: each dimension's name, then every sub-check other than the five asked per question."""
    lines: list[str] = []
    for dim in rubric.dimensions:
        lines.append(f"{dim.dim_id} {dim.name}")
        lines += [f"{s.id}: {s.text}" for s in dim.subchecks if s.id not in PER_QUESTION_SUBCHECKS]
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
    return lines_or_none(f"{t.subcheck_id} | {', '.join(t.target)} | {', '.join(t.window) or NONE}" for t in triggers)


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
    _check(prompts)
    salt = check_salt(salt or new_salt())
    packet = inp.packet
    documents = [f"{d.doc_id} | {d.kind} | {clean(d.title)}\n{record_text(d.content)}" for d in inp.initial_documents]
    user = render(
        prompts.text(REFEREE_SUBJECT_USER),
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
    inp: RefereeAssistantInput, rubric: Rubric, prompts: PromptSet, salt: str | None = None
) -> Prompt:
    """R2 or `r3_investigator` (S2 7.3, 7.5)."""
    inp = require(inp, RefereeAssistantInput, "referee prompt builder")
    _check(prompts)
    salt = check_salt(salt or new_salt())
    system = render(join_blocks(prompts.assembly("referee_assistant")), {"rubric_subchecks": rubric_subchecks(rubric)})
    user = render(
        prompts.text(REFEREE_ASSISTANT_USER),
        {
            "salt": salt,
            **case_values(inp.case),
            "released_records": released_records(inp.released),
            "transcript": transcript(inp.transcript),
            "flags": lines_or_none(flag_line(f) for f in inp.flags),
            "followups": lines_or_none(_followup_line(f) for f in inp.followups),
            "finding": finding_projection(inp.finding, salt),
            "finding_citations": _citation_lines(inp.citations),
            "triggers": _trigger_lines(inp.triggers),
        },
    )
    return Prompt(system, user, salt)
