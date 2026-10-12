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
  /** The track the row is for: "interactive", "replay", or "" when not published. */
  readonly track: string;
  readonly style: string;
  /** The rate with its interval, or with the published family-level bound when the stratum is small. */
  readonly fpr: string;
  readonly families: number | null;
}

export interface FlagRate {
  readonly candidate: string;
  /** The track the row is for: "interactive", "replay", or "" when not published. */
  readonly track: string;
  readonly style: string;
  readonly role: string;
  /** The rate with its interval, or with the published family-level bound when the stratum is small. */
  readonly rate: string;
  readonly families: number | null;
}

export interface DemeanorCount {
  readonly candidate: string;
  /** The track the row is for: "interactive", "replay", or "" when not published. */
  readonly track: string;
  readonly flags: number;
  readonly findings: number;
}

export interface PermutationTest {
  readonly candidate: string;
  /** The track the row is for: "interactive", "replay", or "" when not published. */
  readonly track: string;
  readonly test: string;
  /** Null when the test is undefined (nothing varies): published as such. */
  readonly pValue: number | null;
  readonly significant: boolean;
  /** The sample size: observations, and the units whose labels are permuted. */
  readonly n: number | null;
  readonly units: number | null;
}

export interface Fairness {
  readonly styleRates: readonly StyleRate[];
  readonly flagRates: readonly FlagRate[];
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

const TRACKS: Readonly<Record<string, string>> = { I: "interactive", R: "replay" };

/** Every audit row is per coach and track (S3 8); the same coach appears once per track. */
const track = (r: Json): string => (typeof r["track"] === "string" ? (TRACKS[r["track"]] ?? r["track"]) : "");

/**
 * A stratum's rate as published: its interval, or, for a small stratum or a degenerate bootstrap, the exact
 * family-level bound with its own counts instead (AC-S3-8.4). `event` names what the bound counts per family.
 */
function rateText(r: Json, event: string): string {
  const m = metricView({ point: r["point"], interval: r["interval"] });
  const b = isRecord(r["bound"]) ? r["bound"] : null;
  const bound = b === null ? null : num(b["bound"]);
  if (m === null || m.interval !== null || m.point === null || b === null || bound === null) return metricText(m ?? undefined);
  return `${String(Math.round(m.point * 100))}%; ${String(num(b["failed"]) ?? 0)} of ${String(num(b["families"]) ?? num(r["families"]) ?? 0)} families ${event}; one-sided 95% bound ${(bound * 100).toFixed(1)}%`;
}

/** `GET /api/trust/fairness`; null when not one. */
export function parseFairness(v: unknown): Fairness | null {
  if (!isRecord(v)) return null;
  const styleRates = list(v["style_fpr"]).flatMap((r) =>
    typeof r["candidate"] === "string" && typeof r["style"] === "string" ? [{ candidate: r["candidate"], track: track(r), style: r["style"], fpr: rateText(r, "failed"), families: num(r["families"]) }] : [],
  );
  const flagRates = list(v["flag_rates"]).flatMap((r) =>
    typeof r["candidate"] === "string" && typeof r["style"] === "string" && typeof r["role"] === "string" ? [{ candidate: r["candidate"], track: track(r), style: r["style"], role: r["role"], rate: rateText(r, "with a flag"), families: num(r["families"]) }] : [],
  );
  const demeanor = list(v["demeanor"]).flatMap((r) => {
    const flags = num(r["flags"]);
    const findings = num(r["findings"]);
    return typeof r["candidate"] === "string" && flags !== null && findings !== null ? [{ candidate: r["candidate"], track: track(r), flags, findings }] : [];
  });
  // An undefined test (nothing varies) is published as such, never dropped (S3 1.4); every row names its sample size.
  const tests = list(v["tests"]).flatMap((r) =>
    typeof r["candidate"] === "string" && typeof r["test"] === "string" && (r["p_value"] === null || num(r["p_value"]) !== null) ? [{ candidate: r["candidate"], track: track(r), test: r["test"], pValue: num(r["p_value"]), significant: r["significant_after_holm"] === true, n: num(r["n"]), units: num(r["units"]) }] : [],
  );
  const nc = isRecord(v["negative_controls"]) ? v["negative_controls"]["caught"] : undefined;
  return { styleRates, flagRates, demeanor, tests, negativeControlsCaught: typeof nc === "boolean" ? nc : null };
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
