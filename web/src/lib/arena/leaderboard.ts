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

export interface BoardRow {
  readonly candidate_id: string;
  readonly display_name: string;
  readonly rank: number | null;
  readonly eligible: boolean | null;
  readonly provisional: boolean;
  readonly reason: string | null;
  readonly rankInterval: { readonly lo: number; readonly hi: number } | null;
  readonly metrics: Readonly<Record<string, MetricView>>;
}

export interface Board {
  readonly board: "assistant" | "subject";
  readonly status: string;
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
  return {
    candidate_id: v["candidate_id"],
    display_name: v["display_name"],
    rank,
    eligible: elig === null || typeof elig["eligible"] !== "boolean" ? null : elig["eligible"],
    provisional: elig !== null && elig["provisional"] === true,
    reason: typeof v["reason"] === "string" ? v["reason"] : null,
    rankInterval: lo === null || hi === null ? null : { lo, hi },
    metrics,
  };
}

/** A published board, or null when it is not one. Rows keep the server's order. */
export function parseBoard(v: unknown): Board | null {
  if (!isRecord(v) || (v["board"] !== "assistant" && v["board"] !== "subject") || typeof v["status"] !== "string" || !Array.isArray(v["rows"])) return null;
  const rows = (v["rows"] as unknown[]).map(parseRow);
  if (rows.some((r) => r === null)) return null;
  return { board: v["board"], status: v["status"], rows: rows as BoardRow[] };
}

/** A metric's point as a percentage with its interval, as words: "89% (62-100%)", or "not computed". */
export function metricText(m: MetricView | undefined): string {
  if (m === undefined || m.point === null) return "not computed";
  const pct = (x: number) => `${String(Math.round(x * 100))}%`;
  const base = m.ratio === null ? pct(m.point) : `${pct(m.point)} (${String(m.ratio.num)}/${String(m.ratio.den)})`;
  return m.interval === null ? base : `${base}, interval ${pct(m.interval.lo)}-${pct(m.interval.hi)}`;
}

/** Where a rank interval sits on a scale of `n` ranks, as left offset and width fractions for its bar. */
export function rankBar(interval: { readonly lo: number; readonly hi: number }, n: number): { left: number; width: number } {
  const span = Math.max(1, n);
  return { left: (interval.lo - 1) / span, width: (interval.hi - interval.lo + 1) / span };
}
