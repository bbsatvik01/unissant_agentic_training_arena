/**
 * The metric catalog as the methodology page shows it (S6 4.11): every metric's estimand, cluster unit, interval
 * method, tracks and edge cases, copied verbatim from docs/spec/S3-scoring-rubrics-metrics.md section 5.2
 * (metrics.test.ts compares this file with the spec). Track letters: I interactive, R replay, T training.
 */

export interface MetricEntry {
  readonly id: string;
  readonly metric: string;
  readonly req: string;
  readonly estimand: string;
  readonly unit: string;
  readonly interval: string;
  readonly tracks: string;
  readonly edge: string;
}

export const METRICS: readonly MetricEntry[] = [
  {
    "id": "M01",
    "metric": "Deceptive-role recall",
    "req": "EVL-9, KPI-2",
    "estimand": "count(D -> deceptive) / |D| over the candidate's included deceptive trials",
    "unit": "Family",
    "interval": "Cluster bootstrap; family lower bound when all detected",
    "tracks": "I, R",
    "edge": "|D| = 0: undefined, candidate unranked; insufficient counts as a miss"
  },
  {
    "id": "M02",
    "metric": "False-positive rate",
    "req": "EVL-9, EVL-10, KPI-2",
    "estimand": "count(T -> deceptive) / |T| over own included truthful trials",
    "unit": "Family",
    "interval": "Cluster bootstrap; complete-family bound (5.1)",
    "tracks": "I, R",
    "edge": "|T| = 0: eligibility \"insufficient\"; insufficient stays in |T|"
  },
  {
    "id": "M03",
    "metric": "PPV",
    "req": "EVL-9",
    "estimand": "count(D -> dec) / (count(D -> dec) + count(T -> dec))",
    "unit": "Family",
    "interval": "Cluster bootstrap (pool: families with any deceptive output)",
    "tracks": "I, R",
    "edge": "No deceptive outputs: undefined; published with role prevalence (M25)"
  },
  {
    "id": "M04",
    "metric": "Unresolved rate by role",
    "req": "EVL-9, EVL-5",
    "estimand": "count(X -> insufficient) / |X|, X in {T, D}; sub-count of synthetic insufficient from `assistant_failed`",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I, R",
    "edge": "|X| = 0: undefined"
  },
  {
    "id": "M05",
    "metric": "2x3 count matrix",
    "req": "EVL-9",
    "estimand": "Raw counts (truthful, deceptive) x (truthful, deceptive, insufficient), plus a per-subject breakdown",
    "unit": "None",
    "interval": "Counts only",
    "tracks": "I, R",
    "edge": "Always published, including zeros"
  },
  {
    "id": "M06",
    "metric": "Evasion-event precision",
    "req": "EVL-3, EVL-8",
    "estimand": "TP / all evasion flags (5.3)",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I, R",
    "edge": "No evasion flags: undefined; strict primary, broad secondary"
  },
  {
    "id": "M07",
    "metric": "Evasion-event recall",
    "req": "EVL-3, EVL-8",
    "estimand": "TP / EVA events in the candidate's included trials",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I, R",
    "edge": "No events: undefined. R is the cross-candidate comparison (identical events); I events depend on each assistant's path"
  },
  {
    "id": "M08",
    "metric": "Unsupported flag rate",
    "req": "EVL-5, AST-7",
    "estimand": "Unsupported flags / all unique flags",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I, R",
    "edge": "No flags: undefined; reasons split: citation, demeanor, claim"
  },
  {
    "id": "M09",
    "metric": "Questioning quality",
    "req": "EVL-6, EVL-10",
    "estimand": "Mean over scorable included trials of (D1+D2+D3+D4)/16",
    "unit": "Family",
    "interval": "Cluster bootstrap of the mean (num = sum of trial QQ, den = trial count)",
    "tracks": "I, R",
    "edge": "Coverage = scorable / included; coverage < 90% marks QQ provisional"
  },
  {
    "id": "M10",
    "metric": "Closure support (extension)",
    "req": "AST-3, EX-3",
    "estimand": "Mean D5 over included trials with a committed finding",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I, R",
    "edge": "Not a ranking key"
  },
  {
    "id": "M11",
    "metric": "Investigator dimension scores",
    "req": "EVL-7",
    "estimand": "Per session D1..D5",
    "unit": "Session",
    "interval": "None (per session)",
    "tracks": "T",
    "edge": "Unscorable when fewer than 3 questions"
  },
  {
    "id": "M12",
    "metric": "Subject fidelity (primary)",
    "req": "EVL-11, KPI-3",
    "estimand": "Compliant turns / all evaluated subject turns, including quarantined artifacts and invalid sessions",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I + corpus",
    "edge": "Secondary: valid-session fidelity; by role; by track"
  },
  {
    "id": "M13",
    "metric": "Invalid-session rate",
    "req": "EVL-11, BKO-9",
    "estimand": "(quarantined + subject_invalid) / (completed + assistant_failed + quarantined) per subject",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I + corpus",
    "edge": ""
  },
  {
    "id": "M14",
    "metric": "Deceptive success split",
    "req": "EVL-11, SUB-8",
    "estimand": "Over the subject's deceptive trials with subject inclusion counted or against: success = valid, scenario-compliant (every subject turn has S2 7.2's stored `compliant` true: F1-F6 pass and the turn is not in `inconsistent_turn_ids`, as the adjudication in force left it; SG2-32) and output truthful (misleading clearance) or insufficient (unresolved), reported separately; invalid = non-success; a valid trial with any non-compliant turn and an undetected outcome is reported as `noncompliant_undetected`, a non-success (EVL-11, SUB-8: evasion that breaks the profile is a fidelity failure, never success; SG2-28). Validity alone still decides assistant inclusion (4.3), so subject mistakes do not remove assistant outcomes",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I",
    "edge": "Per assistant pairing and pooled"
  },
  {
    "id": "M15",
    "metric": "Truthful credit",
    "req": "EVL-11",
    "estimand": "Factual consistency = F1-compliant share of truthful turns; appropriate uncertainty = among truthful turns with `asked_fact_status` in {unknown, limited}, share with `uncertainty_expressed` and F1, F3 pass; correct recognition = share of included truthful trials with output truthful (interaction outcome, per assistant)",
    "unit": "Family",
    "interval": "Cluster bootstrap",
    "tracks": "I",
    "edge": "No eligible turns: undefined"
  },
  {
    "id": "M16",
    "metric": "Coaching latency",
    "req": "KPI-4, EVL-5",
    "estimand": "Share of turns with latency <= 3.000 s (misses count as over); nearest-rank p95",
    "unit": "Session",
    "interval": "Session-cluster bootstrap",
    "tracks": "T (practice), I (harness, per candidate)",
    "edge": "Section 6.4"
  },
  {
    "id": "M17",
    "metric": "Investigator score and evidence coverage",
    "req": "EVL-2, EVL-7",
    "estimand": "5 x sum of D1..D5; coverage = key facts some question asked for (`r3_subject` `requested_fact_ids`) / `key_fact_ids` (the key questions' target facts; 6.1)",
    "unit": "Session",
    "interval": "None per session",
    "tracks": "T",
    "edge": "Development cases only; text sessions only (D7)"
  },
  {
    "id": "M18",
    "metric": "Investigator improvement",
    "req": "KPI-1",
    "estimand": "Per participant (post - pre) / pre and post - pre",
    "unit": "Participant",
    "interval": "Participant bootstrap",
    "tracks": "T",
    "edge": "pre = 0: relative undefined, absolute reported"
  },
  {
    "id": "M19",
    "metric": "Eligibility",
    "req": "EVL-10, KPI-5",
    "estimand": "FPR point <= 5% on own included trials AND isolation pass",
    "unit": "Candidate",
    "interval": "Attrition sensitivity (5.4)",
    "tracks": "I, R",
    "edge": "Provisional and insufficient states"
  },
  {
    "id": "M20",
    "metric": "Rank and rank interval",
    "req": "EVL-10",
    "estimand": "Order by M01 then M09; bootstrap rank distribution",
    "unit": "Family",
    "interval": "Bootstrap ranks",
    "tracks": "I, R",
    "edge": "Ties share a rank"
  },
  {
    "id": "M21",
    "metric": "Zero-event family bound",
    "req": "BKO-10",
    "estimand": "Section 5.1",
    "unit": "Family",
    "interval": "Exact",
    "tracks": "I, R",
    "edge": "Undefined without complete families"
  },
  {
    "id": "M22",
    "metric": "Cost",
    "req": "EVL-5, BKO-9",
    "estimand": "Sum and mean settled cost per included trial and per planned trial, by candidate and track",
    "unit": "Trial",
    "interval": "Descriptive (no interval)",
    "tracks": "I, R",
    "edge": "Includes the candidate's own calls only; referee and subject costs reported separately"
  },
  {
    "id": "M23",
    "metric": "Execution and exclusion rates",
    "req": "BKO-9, EVL-10",
    "estimand": "Count and share of each execution state and exclusion reason per candidate and role; own coverage of truthful and deceptive trials",
    "unit": "None",
    "interval": "Counts",
    "tracks": "I, R",
    "edge": ""
  },
  {
    "id": "M24",
    "metric": "Fairness metrics",
    "req": "PRB-4, SCN-3",
    "estimand": "Section 8",
    "unit": "Family",
    "interval": "Section 8",
    "tracks": "I, R",
    "edge": ""
  },
  {
    "id": "M25",
    "metric": "Role prevalence",
    "req": "BKO-10",
    "estimand": "|D| / (|D| + |T|) over included trials, per candidate",
    "unit": "None",
    "interval": "Counts",
    "tracks": "I, R",
    "edge": ""
  }
];
