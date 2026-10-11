"""Assistant leaderboard body assembly (S3 5.5-5.6; D-020 the leaderboard is a demo centerpiece): turns
WP-15's pure ranking and metric functions into the exact JSON `arena.leaderboards.body` the referee inserts,
bound to its manifest and the scorer's own hashes. Everything here is pure; `arena_referee.leaderboard`
fetches the rows this needs from the database and writes the result.

Scope (D-016: no over-engineering ahead of the data that would make a metric real). The body publishes
every metric computable from `arena.planned_trials`, execution records, adjudications and `ops.model_calls`
alone: M01 recall, M02 FPR (with the family-level bound), M03 PPV, M04 unresolved, M05 the count matrix, M21
the zero-event bound, M22 cost, M23 execution and exclusion rates, M25 role prevalence, eligibility, rank and
rank interval, and the binding fields (5.6's last bullet). The evasion, flag, questioning-quality, closure
and subject metrics (M06-M17) and the fairness audit (M24) need coaching-card and R2/R3 judgment data the
tournament job (WP-17) assembles; rather than publish a fabricated zero for a metric with no real inputs,
the body's `not_computed` list names them.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from typing import Any

from arena_core.scoring.exact import seed_for
from arena_core.scoring.metrics import (
    OUTPUTS,
    ROLES,
    CostSummary,
    TrialOutcome,
    cost_summary,
    count_matrix,
    execution_rates,
    output_of,
    prevalence,
    role_clusters,
)
from arena_core.scoring.ranking import (
    CandidateStats,
    FamilyCounts,
    IsolationResult,
    Leaderboard,
    RankInterval,
    Row,
    rank,
    rank_intervals,
)
from arena_core.scoring.stats import (
    Cluster,
    Eligibility,
    FamilyBound,
    Interval,
    cluster_bootstrap,
    family_level_bound,
    ratio,
)

NOT_COMPUTED = (
    "M06_evasion_precision",
    "M07_evasion_recall",
    "M08_unsupported_flag_rate",
    "M09_questioning_quality",
    "M10_closure_support",
    "M11_investigator_scores",
    "M12_subject_fidelity",
    "M13_invalid_session_rate",
    "M14_deceptive_success",
    "M15_truthful_credit",
    "M16_coaching_latency",
    "M17_investigator_score_and_coverage",
    "M24_fairness_audit",
)


@dataclass(frozen=True, kw_only=True)
class CandidateInput:
    """One assistant candidate's own data for one tournament track (S3 5.3-5.6). `trials`: this candidate's
    own included trials (INCLUDED or INCLUDED_AS_INSUFFICIENT). `excluded_truthful_by_family` and
    `excluded_deceptive_by_family`: this candidate's own excluded trials, by family and role (F14
    attrition's own worst/best-case sensitivity treats an excluded deceptive trial as a trial that could
    have gone either way, never as a trial that never happened; the M02/M21 "complete family" test -- a
    family with any exclusion, truthful or deceptive, is never complete). `reasons`: (role, reason) for
    every one of this candidate's own planned rows, `reason` being the manifest's own field (M23 overall
    and per-role). `own_cost_rows`: (settled cost, included) per this candidate's own model call (M22);
    `own_planned`: this candidate's own planned-trial count."""

    candidate_id: str
    display_name: str
    trials: Sequence[TrialOutcome]
    excluded_truthful_by_family: Mapping[str, int]
    excluded_deceptive_by_family: Mapping[str, int]
    reasons: Sequence[tuple[str, str]]
    own_cost_rows: Sequence[tuple[Decimal, bool]]
    own_planned: int


@dataclass(frozen=True, kw_only=True)
class Binding:
    """S3 5.6's last bullet: every field a leaderboard row binds itself to."""

    manifest_sha256: str
    manifest_version: int
    scorer_git_sha: str
    rubric_sha256: str
    r1_prompt_sha256: str
    r2_prompt_sha256: str
    label_set_sha256: str
    bootstrap_b: int


def _family_counts(trials: Sequence[TrialOutcome]) -> dict[str, FamilyCounts]:
    by_fam: dict[str, list[TrialOutcome]] = {}
    for t in trials:
        by_fam.setdefault(t.family_id, []).append(t)
    out: dict[str, FamilyCounts] = {}
    for fam, rows in by_fam.items():
        deceptive = [t for t in rows if t.role == "deceptive"]
        det = sum(1 for t in deceptive if output_of(t) == "deceptive")
        out[fam] = FamilyCounts(det=det, inc_d=len(deceptive), qq_sum=Fraction(0), qq_n=0)
    return out


def _candidate_stats(c: CandidateInput) -> CandidateStats:
    matrix = count_matrix(c.trials)
    fp = matrix.counts[("truthful", "deceptive")]
    inc_t = sum(matrix.counts[("truthful", o)] for o in OUTPUTS)
    inc_d = sum(matrix.counts[("deceptive", o)] for o in OUTPUTS)
    det = matrix.counts[("deceptive", "deceptive")]
    exc_t = sum(c.excluded_truthful_by_family.values())
    exc_d = sum(c.excluded_deceptive_by_family.values())
    return CandidateStats(
        id=c.candidate_id,
        fp=fp,
        inc_t=inc_t,
        exc_t=exc_t,
        det=det,
        inc_d=inc_d,
        exc_d=exc_d,
        qq=None,
        qq_coverage=Fraction(0),
    )


def _frac(f: Fraction | None) -> dict[str, Any] | None:
    return None if f is None else {"num": f.numerator, "den": f.denominator, "value": float(f)}


def _interval(i: Interval) -> dict[str, Any]:
    return {"lo": i.lo, "hi": i.hi, "status": i.status, "pool": i.pool}


def _bound(b: FamilyBound) -> dict[str, Any]:
    return {"bound": b.bound, "kind": b.kind, "families": b.n, "failed": b.failed}


def _recall_lower_bound(b: FamilyBound) -> dict[str, Any] | None:
    """M01's own required family lower bound (S3 5.1: "the same function... gives the symmetric lower
    bound for an all-detected recall" -- and, by the same Clopper-Pearson upper/lower duality, for the
    general x > 0 case too): the complement of M21's own bound on the miss rate over the same complete
    families, never published when M21 itself is undefined (no complete families)."""
    if b.bound is None:
        return None
    return {"bound": 1 - b.bound, "kind": f"lower bound on recall (complement of: {b.kind})", "families": b.n}


def _eligibility(e: Eligibility) -> dict[str, Any]:
    a = e.attrition
    return {
        "eligible": e.eligible,
        "status": e.status,
        "point": _frac(a.point),
        "worst": _frac(a.worst),
        "best": _frac(a.best),
        "provisional": a.provisional,
    }


def _money(f: Fraction | None) -> str | None:
    """A cost `Fraction` as a decimal string (the settled costs it sums are already `Decimal`-precision, so
    this never loses anything a reader would notice), never the bare rational `str(Fraction)` gives."""
    return None if f is None else str(Decimal(f.numerator) / Decimal(f.denominator))


def _cost(c: CostSummary) -> dict[str, Any]:
    return {
        "total": _money(c.total),
        "mean_per_included": _money(c.mean_per_included),
        "mean_per_planned": _money(c.mean_per_planned),
    }


def _execution_rates(reasons: Iterable[str]) -> dict[str, dict[str, Any]]:
    return {k: {"count": n, "share": float(share)} for k, (n, share) in execution_rates(reasons).items()}


def _execution_rates_by_role(reasons: Sequence[tuple[str, str]]) -> dict[str, Any]:
    """M23 (S3 5.2): overall, plus one breakdown per role -- a candidate's execution/exclusion mix on its
    truthful rows can differ sharply from its deceptive rows (e.g. subject-side invalidation skews toward
    one role), and the overall-only rate used to hide that."""
    return {
        "overall": _execution_rates(reason for _role, reason in reasons),
        "by_role": {role: _execution_rates(reason for r, reason in reasons if r == role) for role in ROLES},
    }


def _rank_interval(ri: RankInterval | None) -> dict[str, Any] | None:
    if ri is None:
        return None
    return {
        "lo": ri.lo,
        "hi": ri.hi,
        "share_first": {"num": ri.share_first.numerator, "den": ri.share_first.denominator},
        "no_deceptive_resamples": ri.no_deceptive_resamples,
    }


def _row_body(row: Row, c: CandidateInput, binding: Binding, intervals: Mapping[str, RankInterval]) -> dict[str, Any]:
    def seed_metric(metric: str) -> int:
        return seed_for(binding.manifest_sha256, metric, c.candidate_id, "I")

    def boot(cls: Sequence[Cluster], metric: str) -> Interval:
        return cluster_bootstrap(cls, seed_metric(metric), binding.bootstrap_b)

    clusters = role_clusters(c.trials)
    fp_by_family = {cl.family_id: cl.num for cl in clusters["fpr"]}
    det_by_family = {cl.family_id: (cl.num, cl.den) for cl in clusters["recall"]}
    complete_for_fpr = [
        (fam, fp_by_family.get(fam, 0) > 0)
        for fam in {t.family_id for t in c.trials if t.role == "truthful"}
        if c.excluded_truthful_by_family.get(fam, 0) == 0
    ]
    complete_for_recall = [
        (fam, det_by_family[fam][0] < det_by_family[fam][1])  # failed: any miss (M21's symmetric bound)
        for fam in {t.family_id for t in c.trials if t.role == "deceptive"}  # a positive deceptive denominator
        if c.excluded_deceptive_by_family.get(fam, 0) == 0  # any exclusion in the family: never complete
    ]
    recall_bound = family_level_bound(complete_for_recall)  # shared: M21 publishes it, M01 its complement
    matrix = count_matrix(c.trials)
    return {
        "candidate_id": c.candidate_id,
        "display_name": c.display_name,
        "rank": row.rank,
        "reason": row.reason,
        "eligibility": _eligibility(row.eligibility) if row.eligibility is not None else None,
        "rank_interval": _rank_interval(intervals.get(c.candidate_id)),
        "metrics": {
            "M01_deceptive_recall": {
                "point": _frac(row.candidate.recall),
                "interval": _interval(boot(clusters["recall"], "M01")),
                "family_lower_bound": _recall_lower_bound(recall_bound),
            },
            "M02_false_positive_rate": {
                "point": _frac(Fraction(row.candidate.fp, row.candidate.inc_t) if row.candidate.inc_t else None),
                "interval": _interval(boot(clusters["fpr"], "M02")),
                "complete_family_bound": _bound(family_level_bound(complete_for_fpr)),
            },
            "M03_ppv": {
                "point": _frac(ratio(clusters["ppv"])),
                "interval": _interval(boot(clusters["ppv"], "M03")),
            },
            "M04_unresolved_rate": {
                "truthful": {
                    "point": _frac(ratio(clusters["unresolved_T"])),
                    "interval": _interval(boot(clusters["unresolved_T"], "M04T")),
                    "synthetic_insufficient": matrix.synthetic_insufficient["truthful"],
                },
                "deceptive": {
                    "point": _frac(ratio(clusters["unresolved_D"])),
                    "interval": _interval(boot(clusters["unresolved_D"], "M04D")),
                    "synthetic_insufficient": matrix.synthetic_insufficient["deceptive"],
                },
            },
            "M05_count_matrix": {r: {o: matrix.counts[(r, o)] for o in OUTPUTS} for r in ROLES}
            | {
                "by_subject": {
                    subject: {r: {o: counts[(r, o)] for o in OUTPUTS} for r in ROLES}
                    for subject, counts in matrix.by_subject.items()
                    if subject  # "" is a trial with no subject_id on record, never a real subject's own bucket
                }
            },
            "M21_zero_event_bound": _bound(recall_bound),
            "M22_cost": _cost(cost_summary(c.own_cost_rows, c.own_planned)),
            "M23_execution_rates": _execution_rates_by_role(c.reasons),
            "M25_role_prevalence": _frac(prevalence(c.trials)),
        },
        "fairness_violations": [],  # FA-3: none detected without the fairness audit's inputs (not_computed)
    }


def build_assistant_leaderboard(
    *, candidates: Sequence[CandidateInput], isolation: IsolationResult, qq_calibrated: bool, binding: Binding
) -> dict[str, Any]:
    """S3 5.5-5.6: `rank()` on the candidates' own stats, then every row's metrics, rank interval and the
    binding fields. `isolation.passed is False` (FX-I01) yields the spec's own "not ranked" leaderboard with
    no per-row metrics -- there is nothing to publish about a candidate the gate never reached."""
    by_id = {c.candidate_id: c for c in candidates}
    board: Leaderboard = rank([_candidate_stats(c) for c in candidates], isolation, qq_calibrated)
    body: dict[str, Any] = {
        "board": "assistant",
        "status": board.status,
        "isolation_evidence_hash": board.evidence,
        "not_computed": list(NOT_COMPUTED),
        "binding": {
            "manifest_sha256": binding.manifest_sha256,
            "manifest_version": binding.manifest_version,
            "scorer_git_sha": binding.scorer_git_sha,
            "rubric_sha256": binding.rubric_sha256,
            "r1_prompt_sha256": binding.r1_prompt_sha256,
            "r2_prompt_sha256": binding.r2_prompt_sha256,
            "label_set_sha256": binding.label_set_sha256,
            "bootstrap_b": binding.bootstrap_b,
        },
    }
    if not board.rows:
        body["rows"] = []
        return body
    # `rank_intervals`'s own contract (S3 5.5): its family pool is "every family with any included trial
    # for any ELIGIBLE candidate", and it never re-decides eligibility itself -- an ineligible candidate
    # (rank is None) passed in here would widen that pool with families no eligible candidate's interval
    # should be resampled against.
    ranked_ids = {row.candidate.id for row in board.rows if row.rank is not None}
    intervals = rank_intervals(
        {c.candidate_id: _family_counts(c.trials) for c in candidates if c.candidate_id in ranked_ids},
        seed=seed_for(binding.manifest_sha256, "rank_interval", "all", "I"),
        b=binding.bootstrap_b,
    )
    body["rows"] = [_row_body(row, by_id[row.candidate.id], binding, intervals) for row in board.rows]
    return body
