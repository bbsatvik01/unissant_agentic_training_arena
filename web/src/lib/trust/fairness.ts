/**
 * The fairness audit and the calibration results as the trust center shows them (S6 4.11; S3 7.4 and 8), read from
 * `GET /api/trust/fairness` and `GET /api/trust/methodology`. Every figure is the server's: style-stratified
 * false-positive rates with intervals (FA-1), demeanor-based outputs per coach (FA-3, any count above zero is a
 * violation), permutation tests (FA-5, Holm-corrected), the negative controls (FA-6), and each calibration
 * statistic against its threshold, with an uninformative sample recorded as such, never as agreement.
 */
import { metricText, metricView } from "../arena/leaderboard";

export interface StyleRate {
  readonly candidate: string;
  readonly style: string;
  readonly fpr: string;
}

export interface DemeanorCount {
  readonly candidate: string;
  readonly flags: number;
  readonly findings: number;
}

export interface PermutationTest {
  readonly candidate: string;
  readonly test: string;
  readonly pValue: number;
  readonly significant: boolean;
}

export interface Fairness {
  readonly styleRates: readonly StyleRate[];
  readonly demeanor: readonly DemeanorCount[];
  readonly tests: readonly PermutationTest[];
  /** FA-6: whether the audit caught the demeanor-driven negative controls; null when not reported. */
  readonly negativeControlsCaught: boolean | null;
}

export interface CalibrationRow {
  readonly instrument: string;
  readonly statistic: string;
  /** Null for an uninformative sample (no spread): "not met", never agreement. */
  readonly value: number | null;
  readonly threshold: number;
  readonly met: boolean;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function list(v: unknown): readonly Json[] {
  return Array.isArray(v) ? (v as unknown[]).filter(isRecord) : [];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `GET /api/trust/fairness`; null when not one. */
export function parseFairness(v: unknown): Fairness | null {
  if (!isRecord(v)) return null;
  const styleRates = list(v["style_fpr"]).flatMap((r) => (typeof r["candidate"] === "string" && typeof r["style"] === "string" ? [{ candidate: r["candidate"], style: r["style"], fpr: metricText(metricView({ point: r["point"], interval: r["interval"] }) ?? undefined) }] : []));
  const demeanor = list(v["demeanor"]).flatMap((r) => {
    const flags = num(r["flags"]);
    const findings = num(r["findings"]);
    return typeof r["candidate"] === "string" && flags !== null && findings !== null ? [{ candidate: r["candidate"], flags, findings }] : [];
  });
  const tests = list(v["tests"]).flatMap((r) => {
    const p = num(r["p_value"]);
    return typeof r["candidate"] === "string" && typeof r["test"] === "string" && p !== null ? [{ candidate: r["candidate"], test: r["test"], pValue: p, significant: r["significant_after_holm"] === true }] : [];
  });
  const nc = isRecord(v["negative_controls"]) ? v["negative_controls"]["caught"] : undefined;
  return { styleRates, demeanor, tests, negativeControlsCaught: typeof nc === "boolean" ? nc : null };
}

/** The calibration rows in `GET /api/trust/methodology` (`calibration: [...]`); null when none are published. */
export function parseCalibration(v: unknown): readonly CalibrationRow[] | null {
  if (!isRecord(v) || !Array.isArray(v["calibration"])) return null;
  const rows = list(v["calibration"]).flatMap((r) => {
    const threshold = num(r["threshold"]);
    if (typeof r["instrument"] !== "string" || typeof r["statistic"] !== "string" || threshold === null) return [];
    const value = num(r["value"]);
    // Met only when computed and at or above the threshold; an uninformative sample is not met.
    return [{ instrument: r["instrument"], statistic: r["statistic"], value, threshold, met: value !== null && value >= threshold }];
  });
  return rows;
}

/** A p-value in words: "p = 0.031" or "p < 0.001". */
export function pText(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}
