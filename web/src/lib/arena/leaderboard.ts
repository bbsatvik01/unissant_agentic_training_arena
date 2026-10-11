/**
 * Leaderboards as the view shows them (S6 4.10; stage 2), read narrowly from the bodies WP-16 publishes
 * (`arena_core.referee.leaderboard`: an assistant board ranked by S3 5.5-5.6 and an unranked subject board). The
 * client formats only: every rank, eligibility flag, point and interval is the server's (FE-LB-*); nothing here
 * re-ranks, re-orders by a metric or computes a score. Fields this view does not show are ignored, so a richer body
 * still reads.
 */

export interface MetricView {
  /** The point estimate as a value in 0..1, or null when not computed. */
  readonly point: number | null;
  /** num/den when the server published them. */
  readonly ratio: { readonly num: number; readonly den: number } | null;
  readonly interval: { readonly lo: number; readonly hi: number } | null;
}

/** A published family-level bound (`complete_family_bound`): the bound, its own label, and the family counts. */
export interface FamilyBoundView {
  readonly bound: number | null;
  readonly kind: string;
  readonly families: number;
  readonly failed: number;
}

export interface BoardRow {
  readonly candidate_id: string;
  readonly display_name: string;
  readonly rank: number | null;
  readonly eligible: boolean | null;
  /** The eligibility status as published (definitive, provisional, "insufficient: ..."). */
  readonly eligibilityStatus: string | null;
  readonly provisional: boolean;
  readonly reason: string | null;
  /** The FPR gate's figures: the candidate's own FPR point with M02's interval, and the complete-family bound. */
  readonly fpr: MetricView | null;
  readonly fprBound: FamilyBoundView | null;
  readonly rankInterval: { readonly lo: number; readonly hi: number } | null;
  readonly metrics: Readonly<Record<string, MetricView>>;
  /** The published metrics body, whole, for the row's detail. */
  readonly published: Readonly<Record<string, unknown>>;
  /** M09 published as provisional (its coverage or calibration conditions). */
  readonly qqProvisional: boolean;
}

/** A published paired comparison of two ranked candidates (S3 5.5): A minus B on their common planned cells. */
export interface PairView {
  readonly a: string;
  readonly b: string;
  readonly commonCells: number;
  readonly recall: MetricView | null;
  readonly qq: MetricView | null;
}

export interface Board {
  readonly board: "assistant" | "subject";
  /** The board's paired differences (assistant board), as published. */
  readonly pairwise: readonly PairView[];
  readonly status: string;
  /** The server's "not ranked: isolation gate failed": no ranks and no rows. */
  readonly notRanked: boolean;
  /** The inclusion manifest the board is bound to (`binding.manifest_sha256`), in full. */
  readonly manifestHash: string | null;
  readonly manifestVersion: number | null;
  readonly isolationHash: string | null;
  readonly rows: readonly BoardRow[];
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A published metric `{point: {num, den, value}, interval: {lo, hi}}`, or a bare fraction. */
export function metricView(v: unknown): MetricView | null {
  if (!isRecord(v)) return null;
  const pointObj = isRecord(v["point"]) ? v["point"] : "num" in v ? v : null;
  const point = pointObj === null ? null : num(pointObj["value"]);
  const ratio = pointObj !== null && num(pointObj["num"]) !== null && num(pointObj["den"]) !== null ? { num: pointObj["num"] as number, den: pointObj["den"] as number } : null;
  const iv = isRecord(v["interval"]) ? v["interval"] : null;
  const lo = iv === null ? null : num(iv["lo"]);
  const hi = iv === null ? null : num(iv["hi"]);
  return { point, ratio, interval: lo === null || hi === null ? null : { lo, hi } };
}

/** The metrics a board view shows, by published key; M12's point sits under `primary`. */
const NESTED: ReadonlySet<string> = new Set(["M12_subject_fidelity"]);
const SHOWN: readonly string[] = ["M01_deceptive_recall", "M02_false_positive_rate", "M03_ppv", "M09_questioning_quality", "M12_subject_fidelity", "M13_invalid_session_rate", "M14_deceptive_success"];

function familyBound(v: unknown): FamilyBoundView | null {
  if (!isRecord(v) || typeof v["kind"] !== "string") return null;
  const families = num(v["families"]);
  const failed = num(v["failed"]);
  if (families === null || failed === null) return null;
  return { bound: num(v["bound"]), kind: v["kind"], families, failed };
}

function parseRow(v: unknown): BoardRow | null {
  if (!isRecord(v) || typeof v["candidate_id"] !== "string" || typeof v["display_name"] !== "string") return null;
  const rank = v["rank"] === null ? null : num(v["rank"]);
  if (v["rank"] !== null && rank === null) return null;
  const elig = isRecord(v["eligibility"]) ? v["eligibility"] : null;
  const ri = isRecord(v["rank_interval"]) ? v["rank_interval"] : null;
  const metricsIn = isRecord(v["metrics"]) ? v["metrics"] : {};
  const metrics: Record<string, MetricView> = {};
  for (const key of SHOWN) {
    const raw = metricsIn[key];
    // M12 carries its headline figure under `primary`.
    const m = metricView(NESTED.has(key) && isRecord(raw) ? raw["primary"] : raw);
    if (m !== null) metrics[key] = m;
  }
  const lo = ri === null ? null : num(ri["lo"]);
  const hi = ri === null ? null : num(ri["hi"]);
  const m02 = isRecord(metricsIn["M02_false_positive_rate"]) ? metricsIn["M02_false_positive_rate"] : null;
  const fpr = elig === null ? null : metricView({ point: elig["point"], interval: m02?.["interval"] });
  return {
    candidate_id: v["candidate_id"],
    display_name: v["display_name"],
    rank,
    eligible: elig === null || typeof elig["eligible"] !== "boolean" ? null : elig["eligible"],
    eligibilityStatus: elig !== null && typeof elig["status"] === "string" ? elig["status"] : null,
    fpr,
    fprBound: familyBound(m02?.["complete_family_bound"]),
    provisional: elig !== null && elig["provisional"] === true,
    reason: typeof v["reason"] === "string" ? v["reason"] : null,
    rankInterval: lo === null || hi === null ? null : { lo, hi },
    metrics,
    published: metricsIn,
    qqProvisional: isRecord(metricsIn["M09_questioning_quality"]) && metricsIn["M09_questioning_quality"]["provisional"] === true,
  };
}

/** A published board, or null when it is not one. Rows keep the server's order. */
export function parseBoard(v: unknown): Board | null {
  if (!isRecord(v) || (v["board"] !== "assistant" && v["board"] !== "subject") || typeof v["status"] !== "string" || !Array.isArray(v["rows"])) return null;
  const rows = (v["rows"] as unknown[]).map(parseRow);
  if (rows.some((r) => r === null)) return null;
  const binding = isRecord(v["binding"]) ? v["binding"] : null;
  const pairs = Array.isArray(v["pairwise"]) ? (v["pairwise"] as unknown[]) : [];
  return {
    board: v["board"],
    pairwise: pairs.flatMap((p) => {
      if (!isRecord(p) || typeof p["a"] !== "string" || typeof p["b"] !== "string") return [];
      return [{ a: p["a"], b: p["b"], commonCells: num(p["common_cells"]) ?? 0, recall: metricView(p["recall_difference"]), qq: metricView(p["qq_difference"]) }];
    }),
    status: v["status"],
    notRanked: v["status"].startsWith("not ranked"),
    manifestHash: binding !== null && typeof binding["manifest_sha256"] === "string" ? binding["manifest_sha256"] : null,
    manifestVersion: binding === null ? null : num(binding["manifest_version"]),
    isolationHash: typeof v["isolation_evidence_hash"] === "string" ? v["isolation_evidence_hash"] : null,
    rows: rows as BoardRow[],
  };
}

function pct(x: number): string {
  return `${String(Math.round(x * 100))}%`;
}

/** A published metric as words (FE-LB-2): "89%, interval 62%-100%"; "interval unavailable" when the server
 * published no interval; "undefined" when it published the metric without a point (a zero denominator); "not
 * computed" when the metric is absent. The published fractions are reduced, so they are not shown as counts. */
export function metricText(m: MetricView | undefined): string {
  if (m === undefined) return "not computed";
  if (m.point === null) return "undefined";
  return m.interval === null ? `${pct(m.point)}, interval unavailable` : `${pct(m.point)}, interval ${pct(m.interval.lo)}-${pct(m.interval.hi)}`;
}

/** The FPR gate for one candidate (S6 4.10 item 2; EVL-6): the sponsor gate's result as the server decided it,
 * the FPR with its interval, and for zero false positives the complete-family bound as published. */
export function fprGate(row: BoardRow): { result: string; fpr: string; bound: string | null } {
  const insufficient = row.eligibilityStatus?.startsWith("insufficient") === true;
  const result = insufficient ? "insufficient (no included truthful trials)" : row.eligible === true ? "passed" : "failed";
  const b = row.fprBound;
  const bound = row.fpr?.point === 0 && b !== null && b.bound !== null ? `0 of ${String(b.families)} truthful families; ${b.kind} ${(b.bound * 100).toFixed(1)}%` : null;
  return { result, fpr: insufficient ? "undefined" : metricText(row.fpr ?? undefined), bound };
}

/** Where a rank interval sits on a scale of `n` ranks, as left offset and width fractions for its bar. */
export function rankBar(interval: { readonly lo: number; readonly hi: number }, n: number): { left: number; width: number } {
  const span = Math.max(1, n);
  return { left: (interval.lo - 1) / span, width: (interval.hi - interval.lo + 1) / span };
}

/** A ranked row's status as published (S6 4.10 item 3): the ranking is provisional when the board says so (WP-16
 * decides it from attrition, eligibility and questioning-quality conditions), with the row's own published reasons. */
export function rankStatus(board: Board, row: BoardRow): string {
  const reasons = [row.provisional ? "false-positive attrition sensitivity" : null, row.qqProvisional ? "questioning quality coverage" : null].filter((r) => r !== null);
  if (board.status !== "provisional" && reasons.length === 0) return "definitive";
  return reasons.length === 0 ? "provisional ranking" : `provisional ranking (${reasons.join("; ")})`;
}

/** A published difference (A minus B, on a 0-1 scale) in signed percentage points: "+10 points, interval -30 to
 * +10 points"; "undefined" without a point (no common cells), "not computed" when absent. */
export function differenceText(m: MetricView | null): string {
  if (m === null) return "not computed";
  if (m.point === null) return "undefined";
  const pts = (x: number) => {
    const n = Math.round(x * 100);
    return `${n > 0 ? "+" : ""}${String(n)}`;
  };
  return m.interval === null ? `${pts(m.point)} points, interval unavailable` : `${pts(m.point)} points, interval ${pts(m.interval.lo)} to ${pts(m.interval.hi)} points`;
}
