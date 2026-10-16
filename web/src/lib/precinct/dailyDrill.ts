/** Local unscored warm-up. Elapsed time never commits a finding, score, completion or server session. */
export const DRILL_DURATION_MS = 180_000;
export type DrillStage = "read" | "question" | "closure";
export interface DrillState {
  readonly status: "ready" | "running" | "paused" | "complete";
  readonly elapsedMs: number;
  readonly startedAtMs: number | null;
  readonly question: string;
  readonly corroboration: string;
}
export type DrillAction =
  | { readonly type: "start" | "pause" | "tick"; readonly nowMs: number }
  | { readonly type: "write"; readonly field: "question" | "corroboration"; readonly text: string }
  | { readonly type: "reset" };
export const INITIAL_DRILL: DrillState = { status: "ready", elapsedMs: 0, startedAtMs: null, question: "", corroboration: "" };

export function drillElapsed(state: DrillState, nowMs: number): number {
  const delta = state.status === "running" && state.startedAtMs !== null && Number.isFinite(nowMs) ? Math.max(0, nowMs - state.startedAtMs) : 0;
  return Math.min(DRILL_DURATION_MS, state.elapsedMs + delta);
}
export function drillStage(elapsedMs: number): DrillStage {
  return elapsedMs < 60_000 ? "read" : elapsedMs < 120_000 ? "question" : "closure";
}
export function drillClock(elapsedMs: number): string {
  const remaining = Math.ceil(Math.max(0, DRILL_DURATION_MS - elapsedMs) / 1000);
  return `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, "0")}`;
}
export function dailyDrillReducer(state: DrillState, action: DrillAction): DrillState {
  if (action.type === "reset") return { ...INITIAL_DRILL };
  if (action.type === "write") return { ...state, [action.field]: action.text.slice(0, 2000) };
  if (!Number.isFinite(action.nowMs)) return state;
  if (action.type === "start") {
    if (state.status !== "ready" && state.status !== "paused") return state;
    return { ...state, status: "running", startedAtMs: action.nowMs };
  }
  if (state.status !== "running") return state;
  const elapsedMs = drillElapsed(state, action.nowMs);
  if (elapsedMs >= DRILL_DURATION_MS) return { ...state, status: "complete", elapsedMs, startedAtMs: null };
  if (action.type === "pause") return { ...state, status: "paused", elapsedMs, startedAtMs: null };
  return state;
}
