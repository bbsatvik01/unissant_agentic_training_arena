"""`SubjectTurn` (subject.v1) and its schema-level validators V1-V4 (S2 6.8).

V1 and V3 need only the output; V2 (IDs exist in this packet, gates opened are CLOSED) and V4 (the behavior is
in the role's allowed set) run when a `SubjectContext` is passed as validation context. A failure triggers the
one repair (S2 10). The validators never judge faithfulness; that is J2's job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import Field, ValidationInfo, model_validator

from arena_core.contracts.common import Answer, Contract, Distinct, FactId, GateId, UncertaintyId

Behavior = Literal[
    "responsive", "omission", "deflection", "minimization", "explicit_uncertainty", "legitimate_non_disclosure"
]
MAX_UTTERANCE_WORDS = 120

Utterance = Answer


@dataclass(frozen=True)
class SubjectContext:
    """The subject's private packet at this turn: its fact, uncertainty and currently CLOSED gate IDs, and the
    behaviors its role block allows after `permitted_behaviors` filtering (S2 6.4, 6.8)."""

    fact_ids: frozenset[str]
    uncertainty_ids: frozenset[str]
    closed_gate_ids: frozenset[str]
    allowed_behaviors: frozenset[str]


class SubjectTag(Contract):
    disclosed: Annotated[list[FactId], Field(max_length=30), Distinct]
    withheld: Annotated[list[FactId], Field(max_length=30), Distinct]
    uncertainty_used: Annotated[list[UncertaintyId], Field(max_length=4), Distinct]
    behavior: Behavior
    gates_opened: Annotated[list[GateId], Field(max_length=6), Distinct]


class SubjectTurn(Contract):
    utterance: Utterance
    tag: SubjectTag

    @model_validator(mode="after")
    def _rules(self, info: ValidationInfo) -> Self:
        errors: list[str] = []
        if len(self.utterance.split()) > MAX_UTTERANCE_WORDS:
            errors.append(f"utterance: more than {MAX_UTTERANCE_WORDS} words (V1)")
        if overlap := sorted(set(self.tag.disclosed) & set(self.tag.withheld)):
            errors.append(f"tag: {overlap} both disclosed and withheld (V3)")
        ctx = info.context
        if ctx is not None:
            if not isinstance(ctx, SubjectContext):
                msg = f"validation context must be a SubjectContext, not {type(ctx).__name__}"
                raise TypeError(msg)
            tag = self.tag
            for field, ids, known, what in (
                ("disclosed", tag.disclosed, ctx.fact_ids, "a fact ID of this packet"),
                ("withheld", tag.withheld, ctx.fact_ids, "a fact ID of this packet"),
                ("uncertainty_used", tag.uncertainty_used, ctx.uncertainty_ids, "an uncertainty ID of this packet"),
                ("gates_opened", tag.gates_opened, ctx.closed_gate_ids, "a gate that is currently CLOSED"),
            ):
                errors += [f"tag.{field}: {i} is not {what} (V2)" for i in ids if i not in known]
            if tag.behavior not in ctx.allowed_behaviors:
                errors.append(f"tag.behavior: {tag.behavior} is not allowed for this role (V4)")
        if errors:
            raise ValueError("; ".join(errors))
        return self
