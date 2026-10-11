/**
 * Progress (S6 4.8, KPI-1): the participant's own sessions in order with their debrief scores. The session list
 * is `GET /api/progress` (S5 5.5, `training.v_my_sessions` and `training.v_my_study`); each session's scores are
 * its published `debrief.v1` read through `GET /api/sessions/{id}/debrief`, shown as the server's own numbers
 * (FE-DEB-2: the client formats, never computes). KPI-1 figures appear only as the server publishes them; with
 * none, the page reads "KPI-1 not measured" (FE-PRG-1). No streaks, reminders or loss framing (FE-PRG-2).
 */
import type { Debrief } from "../contracts/generated/types";

export interface ProgressSession {
  readonly session_id: string;
  readonly trial_id: string;
  readonly phase: "practice" | "pre" | "post";
  readonly mode: "practice" | "assessment";
  readonly voice: boolean;
  readonly status: string;
  readonly created_at: string;
  readonly case_title: string | null;
}

/** KPI-1 as the server reports it for this participant (pre and post totals, absolute and relative change). */
export interface Kpi1 {
  readonly pre: number;
  readonly post: number;
  readonly absolute_change: number;
  /** Null when the baseline is 0 (relative change undefined). */
  readonly relative_change: number | null;
}

export interface Progress {
  readonly sessions: readonly ProgressSession[];
  readonly kpi1: Kpi1 | null;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseSession(v: unknown): ProgressSession | null {
  if (!isRecord(v)) return null;
  const { session_id: id, trial_id: trial, phase, mode, voice, status, created_at: at, case_title: title } = v;
  if (typeof id !== "string" || typeof trial !== "string" || typeof status !== "string" || typeof at !== "string") return null;
  if (phase !== "practice" && phase !== "pre" && phase !== "post") return null;
  if (mode !== "practice" && mode !== "assessment") return null;
  if (typeof voice !== "boolean") return null;
  return { session_id: id, trial_id: trial, phase, mode, voice, status, created_at: at, case_title: typeof title === "string" && title !== "" ? title : null };
}

function parseKpi1(v: unknown): Kpi1 | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return undefined;
  const pre = num(v["pre"]);
  const post = num(v["post"]);
  const abs = num(v["absolute_change"]);
  const rel = v["relative_change"] === null ? null : num(v["relative_change"]);
  if (pre === null || post === null || abs === null || (v["relative_change"] !== null && rel === null)) return undefined;
  return { pre, post, absolute_change: abs, relative_change: rel };
}

/** `GET /api/progress`, or null when the body is not one. Sessions keep the server's order. */
export function parseProgress(v: unknown): Progress | null {
  if (!isRecord(v) || !Array.isArray(v["sessions"])) return null;
  const sessions = (v["sessions"] as unknown[]).map(parseSession);
  const kpi1 = parseKpi1(v["kpi1"]);
  if (sessions.some((s) => s === null) || kpi1 === undefined) return null;
  return { sessions: sessions as ProgressSession[], kpi1 };
}

/** Each session's study step or free practice, in words: "Pre-test 1", "Practice 2", "Post-test 2". */
export function sessionLabels(sessions: readonly ProgressSession[]): readonly string[] {
  const seen = { pre: 0, practice: 0, post: 0 };
  return sessions.map((s) => {
    seen[s.phase] += 1;
    const name = s.phase === "pre" ? "Pre-test" : s.phase === "post" ? "Post-test" : "Practice";
    return `${name} ${String(seen[s.phase])}`;
  });
}

export interface SessionScore {
  readonly kind: "scored" | "unscored" | "unscorable";
  readonly total: number | null;
  readonly dimensions: readonly { readonly id: string; readonly score: number }[];
  readonly reason: string | null;
}

/** A published debrief's own figures for the progress row. */
export function scoreOf(debrief: Debrief): SessionScore {
  if (!debrief.scored) return { kind: "unscored", total: null, dimensions: [], reason: "Voice practice: not scored" };
  const { rubric } = debrief;
  if (!rubric.scorable || rubric.total === null) return { kind: "unscorable", total: null, dimensions: [], reason: rubric.unscorable_reason ?? "This session could not be scored." };
  return { kind: "scored", total: rubric.total, dimensions: rubric.dimensions.map((d) => ({ id: d.dim_id, score: d.score })), reason: null };
}

/** The KPI-1 cells in words (FE-PRG-1): relative change "undefined" at a zero baseline. */
export function kpi1Text(k: Kpi1 | null): { pre: string; post: string; absolute: string; relative: string } {
  if (k === null) return { pre: "KPI-1 not measured", post: "KPI-1 not measured", absolute: "KPI-1 not measured", relative: "KPI-1 not measured" };
  const signed = (x: number) => `${x > 0 ? "+" : ""}${String(x)}`;
  return {
    pre: String(k.pre),
    post: String(k.post),
    absolute: signed(k.absolute_change),
    relative: k.relative_change === null ? "undefined (baseline 0)" : `${signed(Math.round(k.relative_change * 100))}%`,
  };
}

/** A session's date in the reader's words (no time of day). */
export function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The progress page's load state: the list, the server without the route yet, or a failed read. */
export type ProgressLoad = { readonly state: "loading" } | { readonly state: "missing" } | { readonly state: "error" } | { readonly state: "ready"; readonly progress: Progress };

/** A session's score as it loads: the published figures, "scoring" while the referee works, or not available. */
export type ScoreState = SessionScore | "scoring" | "none";

/** Sessions whose run ended (finalized or terminated): they have a debrief and a recording. */
export function sessionEnded(s: ProgressSession): boolean {
  return s.status === "finalized" || s.status === "terminated";
}
