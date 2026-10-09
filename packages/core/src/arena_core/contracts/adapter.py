"""The S2-to-S3 scorer adapter (S3 1.3.1 and 1.3.2; C-04, C-05, C-09, C-11, C-27, SG2-02, SG2-32).

The one place S3's internal types are read from S2's stored shapes; S2 4.9 points here and defines no second
mapping. It adds no information, keeps every stored value's meaning (all five flag kinds; `shape` is display
grouping only) and fails closed: a stored card that does not validate as card.v1 with its code-filled fields and
a `StoredFinding` raises `AdapterError`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from arena_core.contracts.citations import Cite, cites_of, normalize
from arena_core.contracts.coaching import StoredCard
from arena_core.contracts.common import turn_no
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import FlagVerdict, RefereeAssistantReport, RefereeSubjectReport

KINDS = ("gap", "non_responsive", "possible_evasion", "contradiction", "evidence_conflict")
SHAPE = {
    "gap": "gap",
    "non_responsive": "gap",
    "possible_evasion": "gap",
    "contradiction": "contradiction",
    "evidence_conflict": "contradiction",
}
AST8 = frozenset({"non_responsive", "contradiction", "possible_evasion"})
LIKELIHOOD_TERMS = {
    "almost_no_chance": "almost no chance",
    "very_unlikely": "very unlikely",
    "unlikely": "unlikely",
    "roughly_even_chance": "roughly even chance",
    "likely": "likely",
    "very_likely": "very likely",
    "almost_certain": "almost certain",
}
NO_QUOTE_GIVEN = "no quote given"
NO_QUOTE_MATCH = "no quote: quote did not match"


class AdapterError(ValueError):
    """A stored shape the scorer must not read."""


@dataclass(frozen=True)
class Flag:
    flag_ref: str
    kind: str
    shape: str
    category: str | None
    turn_no: int
    quote: str
    citations: tuple[Cite, ...]
    basis: str | None
    demeanor_based: bool


@dataclass(frozen=True)
class AdaptedFinding:
    label: str
    likelihood_term: str
    analytic_confidence: str
    basis: str
    corroboration_to_seek: tuple[str, ...]
    cited_turns: tuple[int, ...]
    cited_records: tuple[str, ...]
    alternative_explanations: tuple[str, ...] | None
    last_revised_turn: int | None


@dataclass(frozen=True)
class FollowUp:
    question: str
    tactic: str
    record_request: str | None


@dataclass(frozen=True)
class Card:
    turn_no: int
    valid: bool
    question_type: str
    neutrality_issues: tuple[str, ...]
    flags: tuple[Flag, ...]
    follow_up: FollowUp
    finding: AdaptedFinding
    demeanor_in_rationale: bool


def adapt_finding(finding: StoredFinding) -> AdaptedFinding:
    """S3 1.3.1 finding rows; the same mapping for assistants and investigators (C-27)."""
    return AdaptedFinding(
        label=finding.label,
        likelihood_term=LIKELIHOOD_TERMS[finding.likelihood],
        analytic_confidence=finding.confidence,
        basis=finding.rationale,
        corroboration_to_seek=tuple(finding.corroboration_needed),
        cited_turns=tuple(finding.cited_turns),
        cited_records=tuple(finding.cited_records),
        alternative_explanations=(
            None if finding.alternative_explanations is None else tuple(finding.alternative_explanations)
        ),
        last_revised_turn=finding.last_revised_turn,
    )


def adapt_card(stored: Mapping[str, Any]) -> Card:
    """One `coach_card` event payload (S2 card.v1 plus its code-filled fields) as S3's internal `Card`."""
    if stored.get("schema_version") != "card.v1":
        msg = "not a card.v1 payload"
        raise AdapterError(msg)
    try:
        card = StoredCard.model_validate(stored)
    except ValidationError as exc:
        msg = f"stored card does not validate as card.v1 with a StoredFinding: {exc}"
        raise AdapterError(msg) from exc
    flags = []
    for f in card.flags:
        raw = f.model_dump()
        flags.append(
            Flag(
                flag_ref=f.flag_ref,
                kind=f.kind,
                shape=SHAPE[f.kind],
                category=f.kind if f.kind in AST8 else None,
                turn_no=turn_no(f.turn_id),
                quote=f.quote,
                citations=tuple(cites_of(raw)),
                basis=f.missing_fact,
                demeanor_based=card.validation.flags[f.flag_ref].demeanor_based,
            )
        )
    return Card(
        turn_no=card.turn_no,
        valid=card.validation.valid,
        question_type=card.question.question_type,
        neutrality_issues=tuple(card.question.neutrality_issues),
        flags=tuple(flags),
        follow_up=FollowUp(card.follow_up.question, card.follow_up.tactic, card.follow_up.record_request),
        finding=adapt_finding(card.finding),
        demeanor_in_rationale=card.validation.demeanor_in_rationale,
    )


def flag_key(f: Flag) -> tuple[str, int, str]:
    """S2 4.4 duplicate rule: same kind, cited turn and normalized quote (C-05)."""
    return (f.kind, f.turn_no, normalize(f.quote))


def verdicts_by_key(cards: Iterable[Card], report: RefereeAssistantReport) -> dict[tuple[str, int, str], FlagVerdict]:
    """J3 verdicts keyed by `flag_key`: J3 saw each flag once (deduplicated, citation-checked), so a duplicate
    takes the verdict of its first occurrence (S3 1.3.2)."""
    by_ref = {v.flag_ref: v for v in report.flags}
    out: dict[tuple[str, int, str], FlagVerdict] = {}
    for card in sorted(cards, key=lambda c: c.turn_no):
        for f in card.flags:
            if flag_key(f) not in out and f.flag_ref in by_ref:
                out[flag_key(f)] = by_ref[f.flag_ref]
    return out


@dataclass(frozen=True)
class SubjectLabel:
    """One subject turn as S3 reads it (S3 1.3.2 and 3.8)."""

    turn_no: int
    label: str
    eva_subtype: str | None
    pfq_reason: str | None
    asked_fact_status: str
    uncertainty_expressed: bool
    innocent_explanation_offered: bool
    asked_fact_ids: tuple[str, ...]
    violated_fact_ids: tuple[str, ...]
    record_conflict_ids: tuple[str, ...]
    f1: bool
    f2_f4: bool
    f3: bool
    f5: bool
    f6: bool
    style_followed: bool
    compliant: bool
    rationale: str


def inconsistent_turn_ids(report: RefereeSubjectReport) -> frozenset[str]:
    """Every turn named in `trajectory.conflicts`, later or earlier (S2 7.2)."""
    return frozenset(i for c in report.trajectory.conflicts for i in (c.turn_id, *c.earlier_turn_ids))


def adapt_subject_report(report: RefereeSubjectReport, quote_invalid: frozenset[str]) -> dict[int, SubjectLabel]:
    """ref_subj.v5 to S3's per-turn labels and compliance. `compliant` is F1-F6 all passing and the turn not in
    `inconsistent_turn_ids` (the one rule, SG2-32); the stored rationale is never empty (SG2-08)."""
    inconsistent = inconsistent_turn_ids(report)
    out: dict[int, SubjectLabel] = {}
    for t in report.turns:
        f1 = t.no_contradiction and t.no_invention
        checks = (f1, t.disclosure_policy_respected, t.uncertainty_respected, not t.platform_attack, t.in_character)
        rationale = t.evidence_quote or (NO_QUOTE_MATCH if t.turn_id in quote_invalid else NO_QUOTE_GIVEN)
        out[turn_no(t.turn_id)] = SubjectLabel(
            turn_no=turn_no(t.turn_id),
            label=t.label,
            eva_subtype=t.eva_subtype,
            pfq_reason=t.pfq_reason,
            asked_fact_status=t.asked_fact_status,
            uncertainty_expressed=t.uncertainty_expressed,
            innocent_explanation_offered=t.innocent_explanation_offered,
            asked_fact_ids=tuple(t.requested_fact_ids),
            violated_fact_ids=tuple(t.violated_fact_ids),
            record_conflict_ids=tuple(t.record_conflict_ids),
            f1=checks[0],
            f2_f4=checks[1],
            f3=checks[2],
            f5=checks[3],
            f6=checks[4],
            style_followed=t.style_followed,
            compliant=all(checks) and t.turn_id not in inconsistent,
            rationale=rationale,
        )
    return out


@dataclass(frozen=True)
class ContradictionTrigger:
    """A check 3e trigger (S3 1.3.2; SG2-37, SG2-40, SG2-41): an (earlier, later) turn pair exactly as
    `trajectory.conflicts` lists it, or a (turn, document) pair; the window opens after `window_after`."""

    turns: tuple[int, ...]
    record_id: str | None
    window_after: int


def contradiction_triggers(
    report: RefereeSubjectReport, available_after: Mapping[str, int]
) -> list[ContradictionTrigger]:
    """`available_after`: record ID -> the exchange after which it was visible (0 for an initial document, its
    release exchange for a released record). A conflict with a canonical fact only is never a trigger."""
    out = [
        ContradictionTrigger((turn_no(e), turn_no(c.turn_id)), None, turn_no(c.turn_id))
        for c in report.trajectory.conflicts
        for e in c.earlier_turn_ids
    ]
    for t in report.turns:
        for r in t.record_conflict_ids:
            out.append(ContradictionTrigger((turn_no(t.turn_id),), r, max(turn_no(t.turn_id), available_after[r])))
    return out
