/**
 * The per-candidate detail the leaderboards show under each row (S6 4.10 item 5 and the subject board), read from
 * the published WP-16 metric bodies and formatted as labeled lines. Nothing is computed: points, intervals,
 * counts, costs and latencies are the server's; a metric published without a point reads "undefined", one with no
 * interval "interval unavailable", one absent "not computed".
 */
import { metricText, metricView } from "./leaderboard";

export type Json = Readonly<Record<string, unknown>>;

export interface DetailLine {
  readonly label: string;
  readonly value: string;
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function metric(v: unknown): string {
  return metricText(metricView(v) ?? undefined);
}

function words(id: string): string {
  return id.replaceAll("_", " ");
}

function counts(v: unknown, suffix = ""): string {
  if (!isRecord(v)) return "not computed";
  const parts = Object.entries(v).flatMap(([k, n]) => {
    if (typeof n === "number") return [`${words(k)} ${String(n)}${suffix}`];
    if (isRecord(n) && typeof n["count"] === "number") return [`${words(k)} ${String(n["count"])}`];
    return [];
  });
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** A metric on the rubric's 0-4 scale (M10 is the mean D5): "3.0 of 4, interval 2.0-4.0". */
function score(v: unknown): string {
  const m = metricView(v);
  if (m === null) return "not computed";
  if (m.point === null) return "undefined";
  const base = `${m.point.toFixed(1)} of 4`;
  return m.interval === null ? `${base}, interval unavailable` : `${base}, interval ${m.interval.lo.toFixed(1)}-${m.interval.hi.toFixed(1)}`;
}

/** A published `[lo, hi]` pair as an interval, or undefined. */
function pair(v: unknown): { lo: unknown; hi: unknown } | undefined {
  return Array.isArray(v) && v.length === 2 ? { lo: v[0] as unknown, hi: v[1] as unknown } : undefined;
}

function seconds(v: unknown): string {
  if (typeof v === "number") return `${v.toFixed(2)} s`;
  if (v === "miss") return "missed the window";
  return "undefined";
}

/** A published decimal-string amount in dollars, or "undefined". */
function money(v: unknown): string {
  return typeof v === "string" ? `$${v}` : "undefined";
}

/** The 2x3 count matrix (role by finding), raw counts as published (M05). */
export function countMatrix(metrics: Json): readonly { readonly role: string; readonly cells: readonly number[] }[] | null {
  const m = metrics["M05_count_matrix"];
  if (!isRecord(m)) return null;
  const rows = ["truthful", "deceptive"].map((role) => {
    const r = m[role];
    const cells = ["truthful", "deceptive", "insufficient_evidence"].map((o) => (isRecord(r) && typeof r[o] === "number" ? r[o] : null));
    return { role, cells };
  });
  if (rows.some((r) => r.cells.some((c) => c === null))) return null;
  return rows as { role: string; cells: number[] }[];
}

export function assistantDetails(metrics: Json): readonly DetailLine[] {
  const m = metrics;
  const sub = (key: string, part: string): unknown => (isRecord(m[key]) ? m[key][part] : undefined);
  const lines: DetailLine[] = [
    { label: "Precision when it says deceptive (M03)", value: metric(m["M03_ppv"]) },
    { label: "Unresolved, truthful role (M04)", value: metric(sub("M04_unresolved_rate", "truthful")) },
    { label: "Unresolved, deceptive role (M04)", value: metric(sub("M04_unresolved_rate", "deceptive")) },
    { label: "Evasion precision, strict and broad (M06)", value: `${metric(sub("M06_evasion_precision", "strict"))}; ${metric(sub("M06_evasion_precision", "broad"))}` },
    { label: "Evasion recall, strict and broad (M07)", value: `${metric(sub("M07_evasion_recall", "strict"))}; ${metric(sub("M07_evasion_recall", "broad"))}` },
    { label: "Unsupported flags (M08)", value: `${metric(m["M08_unsupported_flag_rate"])}; by reason: ${counts(sub("M08_unsupported_flag_rate", "reasons"))}` },
    { label: "Closure support, mean D5 of 4 (M10)", value: score(m["M10_closure_support"]) },
  ];
  const qq = m["M09_questioning_quality"];
  if (isRecord(qq)) lines.push({ label: "Questioning quality coverage (M09)", value: `${metric({ point: qq["coverage"] })}${qq["calibrated"] === false ? ", not calibrated" : ""}${qq["provisional"] === true ? ", provisional" : ""}` });
  const lat = m["M16_coaching_latency"];
  if (isRecord(lat)) {
    const p95 = pair(lat["interval_p95"]);
    const iv = p95 === undefined ? ", interval unavailable" : `, interval ${seconds(p95.lo)}-${seconds(p95.hi)}`;
    const share = metric({ point: lat["share_within_3s"], interval: pair(lat["interval_share"]) });
    lines.push({ label: "Coaching latency p95 (M16)", value: `${seconds(lat["p95_s"])}${iv}; within 3 s: ${share}; measured ${String(lat["measured"])}, unmeasured ${String(lat["unmeasured"])}` });
  }
  const cost = m["M22_cost"];
  if (isRecord(cost)) lines.push({ label: "Cost per trial (M22)", value: `${money(cost["mean_per_included"])} per included, ${money(cost["mean_per_planned"])} per planned; total ${money(cost["total"])}` });
  const exec = m["M23_execution_rates"];
  if (isRecord(exec) && isRecord(exec["by_role"])) {
    for (const [role, rates] of Object.entries(exec["by_role"])) lines.push({ label: `Execution states, ${role} role (M23)`, value: counts(rates) });
  }
  lines.push({ label: "Deceptive share of included trials (M25)", value: metric({ point: m["M25_role_prevalence"] }) });
  return lines;
}

export function subjectDetails(metrics: Json): readonly DetailLine[] {
  const m = metrics;
  const sub = (key: string, part: string): unknown => (isRecord(m[key]) ? m[key][part] : undefined);
  const success = m["M14_deceptive_success"];
  return [
    { label: "Fidelity, valid sessions (M12)", value: metric(sub("M12_subject_fidelity", "valid_session")) },
    { label: "Deceptive success outcomes (M14)", value: isRecord(success) ? counts(success["outcomes"]) : "not computed" },
    { label: "Truthful factual consistency (M15)", value: metric(sub("M15_truthful_credit", "factual_consistency")) },
    { label: "Truthful appropriate uncertainty (M15)", value: metric(sub("M15_truthful_credit", "appropriate_uncertainty")) },
    { label: "Correct recognition (M15)", value: metric(sub("M15_truthful_credit", "correct_recognition")) },
  ];
}
