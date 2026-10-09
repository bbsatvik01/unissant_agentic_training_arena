"""The one finding object (S2 4.1 `$defs.Finding`, 4.2 rules, 4.8 stored finding; C-27, D5, SG2-24).

- `Finding`: the model-output finding inside card.v1, deep.v1 and final.v1. Its own citation lists are capped at
  8 turns and 6 records; a `deceptive` label needs at least one basis flag (assistants only, S2 4.2).
- `StoredFinding`: every finding the arena stores (running card finding, deep update, committed final finding,
  committed training finding), for assistants and investigators alike. The citation caps are 12 turns and 10
  records, so the distinct union of a model's own citations and its basis flags' citations always fits.
- `InvestigatorFinding`: the body of `POST /api/trials/{id}/finding` (S5 5.4): the S6 4.6 form, with
  `basis_flag_refs` always empty and no code-filled field.

Rules that need the trial (a cited turn is a committed answer at or before the current turn, a cited record is an
initial document or released, basis references resolve) are checked by the enclosing output model against a
`CitationContext` passed as Pydantic validation context (`coaching`), so a failure names its field path and
triggers the one repair (S2 10).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Annotated, Any, Protocol, Self

from pydantic import Field, model_validator

from arena_core.contracts.common import (
    AlternativeExplanation,
    CitableRecordId,
    Confidence,
    Contract,
    Corroboration,
    Distinct,
    FlagRef,
    Label,
    Likelihood,
    Rationale,
    TurnNo,
    turn_no,
    when,
)
from arena_core.contracts.rendered import rendered_overruns

LIKELIHOODS = (
    "almost_no_chance",
    "very_unlikely",
    "unlikely",
    "roughly_even_chance",
    "likely",
    "very_likely",
    "almost_certain",
)
# S2 4.2: the likelihoods each label allows, in ICD 203 order.
ALLOWED_LIKELIHOOD: dict[str, tuple[str, ...]] = {
    "deceptive": ("likely", "very_likely", "almost_certain"),
    "truthful": ("almost_no_chance", "very_unlikely", "unlikely"),
    "insufficient_evidence": LIKELIHOODS,
}
MAX_CORROBORATION = 3


def label_json_rules() -> list[dict[str, Any]]:
    """S2 4.2 as JSON Schema rules (the browser's copy of `_check_label_rules`)."""
    return [
        when("label", ["deceptive"], {"likelihood": {"enum": list(ALLOWED_LIKELIHOOD["deceptive"])}}),
        when("label", ["truthful"], {"likelihood": {"enum": list(ALLOWED_LIKELIHOOD["truthful"])}}),
        when("label", ["insufficient_evidence"], {"corroboration_needed": {"type": "array", "minItems": 1}}),
    ]


def _check_label_rules(label: str, likelihood: str, corroboration_needed: list[str]) -> None:
    """S2 4.2: the label's allowed likelihoods; 1 to 3 corroboration entries for `insufficient_evidence`."""
    if likelihood not in ALLOWED_LIKELIHOOD[label]:
        msg = f"likelihood: {likelihood} is not allowed with label {label}"
        raise ValueError(msg)
    if label == "insufficient_evidence" and not 1 <= len(corroboration_needed) <= MAX_CORROBORATION:
        msg = "corroboration_needed: insufficient_evidence needs 1 to 3 entries (EX-3)"
        raise ValueError(msg)


class Finding(Contract):
    """S2 4.1 `$defs.Finding`, the model-output finding (validated by S2 4.2 and 4.3)."""

    label: Label
    likelihood: Likelihood
    confidence: Confidence
    basis_flag_refs: Annotated[list[FlagRef], Field(max_length=6), Distinct]
    cited_turns: Annotated[
        list[TurnNo],
        Field(
            max_length=8,
            description="Turn numbers whose answers the finding rests on, adverse or corroborating; t04 is 4",
        ),
        Distinct,
    ]
    cited_records: Annotated[
        list[CitableRecordId],
        Field(max_length=6, description="doc-NN or rec-NN records the finding rests on"),
        Distinct,
    ]
    corroboration_needed: Annotated[list[Corroboration], Field(max_length=3)]
    rationale: Rationale

    @model_validator(mode="after")
    def _rules(self) -> Self:
        _check_label_rules(self.label, self.likelihood, self.corroboration_needed)
        if self.label == "deceptive" and not self.basis_flag_refs:
            msg = "basis_flag_refs: a deceptive finding needs at least one basis flag"
            raise ValueError(msg)
        return self


class StoredFinding(Contract):
    """S2 4.8: the one stored finding (`StoredFinding`), for assistants and investigators."""

    label: Label
    likelihood: Likelihood
    confidence: Confidence
    basis_flag_refs: Annotated[list[FlagRef], Field(max_length=6), Distinct]
    cited_turns: Annotated[list[TurnNo], Field(max_length=12), Distinct]
    cited_records: Annotated[list[CitableRecordId], Field(max_length=10), Distinct]
    corroboration_needed: Annotated[list[Corroboration], Field(max_length=3)]
    rationale: Rationale
    alternative_explanations: Annotated[list[AlternativeExplanation], Field(max_length=3)] | None
    last_revised_turn: TurnNo | None

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return label_json_rules()

    @model_validator(mode="after")
    def _rules(self) -> Self:
        _check_label_rules(self.label, self.likelihood, self.corroboration_needed)
        return self


class InvestigatorFinding(Contract):
    """The investigator's commit (S5 5.4 body `finding`; S6 4.6; S2 4.8 investigator column)."""

    label: Label
    likelihood: Likelihood
    confidence: Confidence
    basis_flag_refs: Annotated[list[FlagRef], Field(max_length=0)]
    cited_turns: Annotated[list[TurnNo], Field(max_length=12), Distinct]
    cited_records: Annotated[list[CitableRecordId], Field(max_length=10), Distinct]
    corroboration_needed: Annotated[list[Corroboration], Field(max_length=3)]
    rationale: Rationale
    alternative_explanations: Annotated[list[AlternativeExplanation], Field(max_length=3)] | None = None

    @classmethod
    def json_rules(cls) -> list[dict[str, Any]]:
        return label_json_rules()

    @model_validator(mode="after")
    def _rules(self) -> Self:
        _check_label_rules(self.label, self.likelihood, self.corroboration_needed)
        # D11: each text field within its byte cap as a prompt renders it (R3 carries the finding, S2 7.5).
        overruns = rendered_overruns(self)
        if overruns:
            raise ValueError("; ".join(overruns))
        return self

    def stored(self) -> StoredFinding:
        """The stored form: committed as entered, with no `last_revised_turn` (S2 4.8)."""
        return StoredFinding(**self.model_dump(), last_revised_turn=None)


@dataclass(frozen=True)
class CitationContext:
    """What an output may cite and reference, from the trial at the moment the output was requested.

    `current_turn`: the card's exchange, the deep update's `as_of_turn`, or the completed exchanges for a final
    finding. `answered_turns`: committed, non-partial answers at or before `current_turn`. `citable_records`:
    the initial documents and the records released before the output was requested (a card on exchange n sees
    releases with `released_after <= n - 1`; S2 4.4.1). `requestable`: the record IDs currently requestable.
    `flag_refs`: the flag references of the trial's earlier valid cards (for a deep update or a final finding,
    every valid card up to it)."""

    current_turn: int
    answered_turns: frozenset[int]
    citable_records: frozenset[str]
    requestable: frozenset[str] = frozenset()
    flag_refs: frozenset[str] = frozenset()


def finding_context_errors(
    finding: Finding, ctx: CitationContext, path: str, own_refs: frozenset[str] = frozenset()
) -> list[str]:
    """S2 4.2-4.3 trial checks on one finding; `own_refs` are the references the enclosing card's own flags
    will get (`t07.f1`...)."""
    errors = [
        f"{path}.cited_turns[{i}]: turn {t} is not a committed, non-partial answer at or before turn {ctx.current_turn}"
        for i, t in enumerate(finding.cited_turns)
        if t > ctx.current_turn or t not in ctx.answered_turns
    ]
    errors += [
        f"{path}.cited_records[{i}]: {r} is not an initial document or a record released before this output"
        for i, r in enumerate(finding.cited_records)
        if r not in ctx.citable_records
    ]
    errors += [
        f"{path}.basis_flag_refs[{i}]: {ref} names no flag of an earlier valid card or of this card"
        for i, ref in enumerate(finding.basis_flag_refs)
        if ref not in ctx.flag_refs and ref not in own_refs
    ]
    return errors


class BasisFlag(Protocol):
    """The citation fields of a flag a finding's `basis_flag_refs` names."""

    @property
    def turn_id(self) -> str: ...
    @property
    def conflict_turn_id(self) -> str | None: ...
    @property
    def conflict_record_id(self) -> str | None: ...


def store_finding(
    finding: Finding,
    basis_flags: Iterable[BasisFlag],
    last_revised_turn: int,
    alternative_explanations: list[str] | None = None,
) -> StoredFinding:
    """S2 4.8: the model's own citations plus, added by code, the turns (`turn_id`, `conflict_turn_id`) and
    records (`conflict_record_id`) of the flags named in `basis_flag_refs`; sorted and distinct."""
    turns = set(finding.cited_turns)
    records = set(finding.cited_records)
    for flag in basis_flags:
        turns.add(turn_no(flag.turn_id))
        if flag.conflict_turn_id is not None:
            turns.add(turn_no(flag.conflict_turn_id))
        if flag.conflict_record_id is not None:
            records.add(flag.conflict_record_id)
    return StoredFinding(
        label=finding.label,
        likelihood=finding.likelihood,
        confidence=finding.confidence,
        basis_flag_refs=list(finding.basis_flag_refs),
        cited_turns=sorted(turns),
        cited_records=sorted(records),
        corroboration_needed=list(finding.corroboration_needed),
        rationale=finding.rationale,
        alternative_explanations=alternative_explanations,
        last_revised_turn=last_revised_turn,
    )


def last_revised_turn(previous: StoredFinding | None, new: Finding, current_turn: int) -> int:
    """S2 4.1: the current turn when `label` or `likelihood` differs from the previous valid finding's (the
    later of the previous card's and the previous deep update's), or for the first one; otherwise carried
    forward."""
    if previous is None or previous.last_revised_turn is None:
        return current_turn
    if (previous.label, previous.likelihood) != (new.label, new.likelihood):
        return current_turn
    return previous.last_revised_turn
