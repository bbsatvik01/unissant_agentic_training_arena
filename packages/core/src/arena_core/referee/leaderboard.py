"""Assistant leaderboard body assembly (S3 5.5-5.6; D-020 the leaderboard is a demo centerpiece): turns
WP-15's pure ranking and metric functions into the exact JSON `arena.leaderboards.body` the referee inserts,
bound to its manifest and the scorer's own hashes. Everything here is pure; `arena_referee.leaderboard`
fetches the rows this needs from the database and writes the result.

Each row publishes S3 5.6's assistant metrics: M01-M05, M21-M23 and M25 from the planned trials, execution
records, adjudications and costs; M06-M10 from each included trial's `TrialScore` (the stored R1/R2 judgments
through WP-15's scorer functions, computed by `arena_referee.leaderboard`); M16 from the candidate's harness
latency samples; eligibility, rank (recall, then real QQ) and rank interval, and the binding fields. The
subject metrics (M12-M15) are the separate subject board (`build_subject_leaderboard`). The fairness audit
(M24) is not built yet; rather than publish a fabricated zero, the body's `not_computed` list names it.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from typing import Any

from arena_core.contracts.adapter import SubjectLabel
from arena_core.scoring.exact import seed_for
from arena_core.scoring.flags import REASONS, EvasionCounts, SupportCounts
from arena_core.scoring.inclusion import AsstInc, Exec, SubjInc
from arena_core.scoring.kpi import Kpi4, LatencyRow, harness_latency
from arena_core.scoring.metrics import (
    OUTPUTS,
    ROLES,
    CostSummary,
    QQSummary,
    SubjectTrial,
    SubjectTurn,
    TrialOutcome,
    clusters_by_family,
    cost_summary,
    count_matrix,
    deceptive_success,
    execution_rates,
    fidelity_clusters,
    invalid_session_clusters,
    output_of,
    prevalence,
    qq_summary,
    role_clusters,
    truthful_credit,
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

NOT_COMPUTED = ("M24_fairness_audit",)


@dataclass(frozen=True, kw_only=True)
class TrialScore:
    """One included trial's scorer outputs (S3 2.9, 5.3). `qq`: (D1+D2+D3+D4)/16, None when the proposal
    sequence is unscorable or the trial was never scored (both count against QQ coverage); `closure`: D5 when
    a finding was committed (M10); the flag counts are None when the trial has no stored R2 judgment, so an
    unscored trial never reads as a zero."""

    family_id: str
    qq: Fraction | None = None
    closure: int | None = None
    strict: EvasionCounts | None = None
    broad: EvasionCounts | None = None
    support: SupportCounts | None = None


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
    scored: Sequence[TrialScore] = ()  # one per included trial (M06-M10)
    latency: Sequence[LatencyRow] = ()  # this candidate's own latency samples (M16 reads the harness rows)


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


def _family_counts(trials: Sequence[TrialOutcome], scored: Sequence[TrialScore] = ()) -> dict[str, FamilyCounts]:
    by_fam: dict[str, list[TrialOutcome]] = {}
    for t in trials:
        by_fam.setdefault(t.family_id, []).append(t)
    qq = {cl.family_id: cl for cl in _qq(scored).clusters}
    out: dict[str, FamilyCounts] = {}
    for fam, rows in by_fam.items():
        deceptive = [t for t in rows if t.role == "deceptive"]
        det = sum(1 for t in deceptive if output_of(t) == "deceptive")
        q = qq.get(fam)
        out[fam] = FamilyCounts(
            det=det, inc_d=len(deceptive), qq_sum=Fraction(q.num) if q else Fraction(0), qq_n=q.den if q else 0
        )
    return out


def _qq(scored: Sequence[TrialScore]) -> QQSummary:
    return qq_summary((s.family_id, s.qq) for s in scored)


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
        qq=_qq(c.scored).point,
        qq_coverage=_qq(c.scored).coverage or Fraction(0),
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


def _point_interval(
    clusters: Sequence[Cluster], boot: Callable[[Sequence[Cluster], str], Interval], metric: str
) -> dict[str, Any]:
    return {"point": _frac(ratio(clusters)), "interval": _interval(boot(clusters, metric))}


def _evasion(scored: Sequence[TrialScore], kind: str, recall: bool) -> list[Cluster]:
    counts = [(s.family_id, getattr(s, kind)) for s in scored if getattr(s, kind) is not None]
    return clusters_by_family((f, e.tp, e.events if recall else e.flags) for f, e in counts)


def _seconds(x: Fraction | float | None) -> float | str | None:
    """Latency in seconds; a miss is infinitely late (S3 6.4) and published as "miss", since strict JSON (and
    JSONB) has no infinity."""
    if x is None:
        return None
    return float(x) if math.isfinite(x) else "miss"


def _latency(k: Kpi4) -> dict[str, Any]:
    return {
        "share_within_3s": _frac(k.share_within_3s),
        "p95_s": _seconds(k.p95_s),
        "interval_share": list(k.ci_share) if k.ci_share else None,
        "interval_p95": [_seconds(x) for x in k.ci_p95] if k.ci_p95 else None,
        "measured": k.measured,
        "unmeasured": k.unmeasured,
        "in_flight": k.in_flight,
        "provisional": k.provisional,
    }


def _scored_metrics(
    c: CandidateInput,
    qq_calibrated: bool,
    boot: Callable[[Sequence[Cluster], str], Interval],
    seed_metric: Callable[[str], int],
    b: int,
) -> dict[str, Any]:
    """M06-M10 from the included trials' `TrialScore`s and M16 from the harness latency samples (S3 5.2-5.3)."""
    qq = _qq(c.scored)
    support = [(s.family_id, s.support) for s in c.scored if s.support is not None]
    reasons = {r: sum(sup.unsupported.get(r, 0) for _, sup in support) for r in REASONS}
    return {
        "M06_evasion_precision": {
            kind: _point_interval(_evasion(c.scored, kind, recall=False), boot, f"M06{kind}")
            for kind in ("strict", "broad")
        },
        "M07_evasion_recall": {
            kind: _point_interval(_evasion(c.scored, kind, recall=True), boot, f"M07{kind}")
            for kind in ("strict", "broad")
        },
        "M08_unsupported_flag_rate": {
            **_point_interval(
                clusters_by_family((f, sup.unsupported_total, sup.unique) for f, sup in support), boot, "M08"
            ),
            "reasons": reasons,
        },
        "M09_questioning_quality": {
            "point": _frac(qq.point),
            "interval": _interval(boot(qq.clusters, "M09")),
            "coverage": _frac(qq.coverage),
            "provisional": qq.provisional,
            "calibrated": qq_calibrated,
        },
        "M10_closure_support": _point_interval(
            clusters_by_family((s.family_id, s.closure, 1) for s in c.scored if s.closure is not None), boot, "M10"
        ),
        "M16_coaching_latency": _latency(harness_latency(c.latency, seed_metric("M16"), b)),
    }


def _row_body(
    row: Row, c: CandidateInput, binding: Binding, intervals: Mapping[str, RankInterval], qq_calibrated: bool
) -> dict[str, Any]:
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
            **_scored_metrics(c, qq_calibrated, boot, seed_metric, binding.bootstrap_b),
            "M21_zero_event_bound": _bound(recall_bound),
            "M22_cost": _cost(cost_summary(c.own_cost_rows, c.own_planned)),
            "M23_execution_rates": _execution_rates_by_role(c.reasons),
            "M25_role_prevalence": _frac(prevalence(c.trials)),
        },
        "fairness_violations": [],  # FA-3: none detected without the fairness audit's inputs (not_computed)
    }


def _binding(binding: Binding) -> dict[str, Any]:
    return {
        "manifest_sha256": binding.manifest_sha256,
        "manifest_version": binding.manifest_version,
        "scorer_git_sha": binding.scorer_git_sha,
        "rubric_sha256": binding.rubric_sha256,
        "r1_prompt_sha256": binding.r1_prompt_sha256,
        "r2_prompt_sha256": binding.r2_prompt_sha256,
        "label_set_sha256": binding.label_set_sha256,
        "bootstrap_b": binding.bootstrap_b,
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
        "binding": _binding(binding),
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
        {c.candidate_id: _family_counts(c.trials, c.scored) for c in candidates if c.candidate_id in ranked_ids},
        seed=seed_for(binding.manifest_sha256, "rank_interval", "all", "I"),
        b=binding.bootstrap_b,
    )
    body["rows"] = [_row_body(row, by_id[row.candidate.id], binding, intervals, qq_calibrated) for row in board.rows]
    return body


# ---------------------------------------------------------------- subject board (S3 5.6: M12-M15)


@dataclass(frozen=True, kw_only=True)
class SubjectTrialInput:
    """One planned trial a subject candidate played (S3 5.3): its inclusion, the assistant's output (`output_of`,
    None when the assistant is excluded) and R1's adapted per-turn labels (None: no stored R1 report, so the
    trial adds no evaluated turn; a quarantined trial adds its one quarantined artifact as a non-compliant
    turn, S3 5.3)."""

    family_id: str
    role: str
    track: str
    assistant_id: str | None
    exec_state: Exec
    subj_inc: SubjInc
    verdict: str | None
    output: str | None
    labels: Mapping[int, SubjectLabel] | None


@dataclass(frozen=True, kw_only=True)
class SubjectCandidateInput:
    candidate_id: str
    display_name: str
    trials: Sequence[SubjectTrialInput]


def _fidelity_turns(trials: Iterable[SubjectTrialInput]) -> list[SubjectTurn]:
    turns: list[SubjectTurn] = []
    for t in trials:
        if t.subj_inc is SubjInc.EXCLUDED:
            continue
        if t.exec_state is Exec.SUBJECT_QUARANTINED:
            turns.append(SubjectTurn(t.family_id, compliant=False))
        turns += [SubjectTurn(t.family_id, lab.compliant) for lab in (t.labels or {}).values()]
    return turns


def _subject_trial(t: SubjectTrialInput) -> SubjectTrial:
    labels = (t.labels or {}).values()
    return SubjectTrial(
        t.family_id, t.role, t.exec_state, t.subj_inc, t.verdict, all(lab.compliant for lab in labels), t.output
    )


def _subject_row(c: SubjectCandidateInput, binding: Binding) -> dict[str, Any]:
    def boot(cls: Sequence[Cluster], metric: str) -> dict[str, Any]:
        seed = seed_for(binding.manifest_sha256, metric, c.candidate_id, "I")
        return {"point": _frac(ratio(cls)), "interval": _interval(cluster_bootstrap(cls, seed, binding.bootstrap_b))}

    trials = list(c.trials)
    # M14 and M15 are interaction outcomes (S3 5.2, track I); corpus trials count only toward M12 and M13.
    interactive = [t for t in trials if t.track == "interactive"]
    outcomes, success = deceptive_success(_subject_trial(t) for t in interactive)
    by_assistant = {
        a: dict(deceptive_success(_subject_trial(t) for t in interactive if t.assistant_id == a)[0])
        for a in sorted({t.assistant_id for t in interactive if t.assistant_id is not None})
    }
    truthful_counted = [t for t in interactive if t.role == "truthful" and t.subj_inc is not SubjInc.EXCLUDED]
    included_truthful = [
        TrialOutcome(t.family_id, t.role, AsstInc.INCLUDED, t.output, "")
        for t in interactive
        if t.role == "truthful" and t.output is not None
    ]
    credit = truthful_credit(
        [(t.family_id, lab) for t in truthful_counted for lab in (t.labels or {}).values()], included_truthful
    )
    primary = fidelity_clusters(_fidelity_turns(trials))
    return {
        "candidate_id": c.candidate_id,
        "display_name": c.display_name,
        "rank": None,  # S3 5.6: the subject board is unranked by default
        "metrics": {
            "M12_subject_fidelity": {
                "primary": boot(primary, "M12"),
                "valid_session": boot(
                    fidelity_clusters(_fidelity_turns(t for t in trials if t.subj_inc is SubjInc.COUNTED)), "M12V"
                ),
                "by_role": {
                    r: boot(fidelity_clusters(_fidelity_turns(t for t in trials if t.role == r)), f"M12{r}")
                    for r in ROLES
                },
                "by_track": {
                    k: boot(fidelity_clusters(_fidelity_turns(t for t in trials if t.track == k)), f"M12{k}")
                    for k in sorted({t.track for t in trials})
                },
            },
            "M13_invalid_session_rate": boot(invalid_session_clusters(_subject_trial(t) for t in trials), "M13"),
            "M14_deceptive_success": {
                **boot(success, "M14"),
                "outcomes": dict(outcomes),
                "by_assistant": by_assistant,
            },
            "M15_truthful_credit": {
                "factual_consistency": boot(credit.factual_consistency, "M15F"),
                "appropriate_uncertainty": boot(credit.appropriate_uncertainty, "M15U"),
                "correct_recognition": boot(credit.correct_recognition, "M15R"),
            },
        },
    }


def build_subject_leaderboard(
    *, candidates: Sequence[SubjectCandidateInput], isolation: IsolationResult, binding: Binding
) -> dict[str, Any]:
    """S3 5.6's separate subject board: M12-M15 per subject candidate, unranked, rows ordered by the M12 point
    estimate (highest first; undefined last), bound to the same manifest and hashes as the assistant board."""
    rows = [_subject_row(c, binding) for c in candidates]

    def order(row: dict[str, Any]) -> tuple[bool, Fraction]:
        point = row["metrics"]["M12_subject_fidelity"]["primary"]["point"]
        return (point is not None, Fraction(point["num"], point["den"]) if point else Fraction(0))

    return {
        "board": "subject",
        "status": "unranked",
        "isolation_evidence_hash": isolation.evidence_hash,
        "binding": _binding(binding),
        "rows": sorted(rows, key=order, reverse=True),
    }
