"""Evidence coverage (EVL-2, S3 6.1): reported per session on the learning scorecard (S3 5.7), not part of the
0-100 score. `key_fact_ids` is the evaluator packet's own deterministic projection, never authored; the
numerator comes from `r3_subject`'s per-turn `requested_fact_ids` (ref_subj.v5), code-checked against the
variant's canonical facts (S2 7.2), so a question that asks for a fact the subject does not know still counts
(FX-K05)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from arena_core.contracts.common import turn_no
from arena_core.contracts.referee import RefereeSubjectReport


def key_fact_ids(evaluator_packet: Mapping[str, Any]) -> tuple[str, ...]:
    """The sorted distinct `target_fact_ids` of the evaluator packet's `rubric.key_questions` (at least one:
    S1 requires three or more key questions)."""
    return tuple(sorted({f for q in evaluator_packet["rubric"]["key_questions"] for f in q["target_fact_ids"]}))


@dataclass(frozen=True)
class EvidenceCoverage:
    addressed: int
    key_facts: int
    share: Fraction
    by_fact: Mapping[str, tuple[int, ...]]


def evidence_coverage(report: RefereeSubjectReport, key: Sequence[str]) -> EvidenceCoverage:
    """From `r3_subject`'s validated ref_subj.v5 report: a key fact is addressed when at least one subject
    turn's `requested_fact_ids` names it, whether or not the subject knows it (S3 6.1)."""
    by_fact: dict[str, list[int]] = {f: [] for f in key}
    for t in report.turns:
        for f in t.requested_fact_ids:
            if f in by_fact:
                by_fact[f].append(turn_no(t.turn_id))
    addressed = sum(1 for turns in by_fact.values() if turns)
    return EvidenceCoverage(
        addressed=addressed,
        key_facts=len(key),
        share=Fraction(addressed, len(key)) if key else Fraction(0),
        by_fact={f: tuple(turns) for f, turns in by_fact.items()},
    )
