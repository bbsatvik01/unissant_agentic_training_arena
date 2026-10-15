/**
 * How a live run's views stay in step with the run itself. Pure rules, each the root of a defect class:
 *
 * - a failed read of the run is retried on its own, with backoff, and never left for a person to notice;
 * - the view's run state follows bh-api's run status on EVERY transition (resumed, parked, decided, ended), not only
 *   a return to active;
 * - a clock keeps ticking while anything on screen measures elapsed time: a running stage or a gate that waits;
 * - a recorded human action locks its form: one submission in flight, none after success.
 */
import { ACTIVE_RUN_STATES, type StreamStatus } from "./state";

/** Delay before the next try after `failures` failed reads of the run's snapshot: 2 s, 4 s, 8 s ... capped at 30 s. */
export function seedRetryDelay(failures: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, failures - 1), 30_000);
}

/** The run state a view's store implies: active while it streams, else the state its last phase ended in. */
export function impliedRunState(status: StreamStatus, finalState: string | null): "active" | string | null {
  if (status === "running") return "active";
  if (status === "error") return "failed";
  if (status === "finished") return finalState;
  return null;
}

/**
 * True when bh-api's run status says something other than the view: the view must re-read the run's snapshot
 * (which carries the run's own status). A view that has not started (idle) waits for its first read instead.
 */
export function runStateMismatch(runStatus: string | null, status: StreamStatus, finalState: string | null): boolean {
  if (runStatus === null || status === "idle") return false;
  const implied = impliedRunState(status, finalState);
  if (ACTIVE_RUN_STATES.has(runStatus)) return implied !== "active";
  return implied !== runStatus;
}

/** Statuses at which a person is being waited on (a gate) or the run is between events but still timed. */
const WAITING: ReadonlySet<string> = new Set(["awaiting_plan_approval", "awaiting_decision", "awaiting_review"]);

/** How often the Pipeline's clock ticks: every second while a stage runs or a gate waits, never once the run ended. */
export function clockInterval(runStatus: string | null): number | null {
  if (runStatus === null || ACTIVE_RUN_STATES.has(runStatus) || WAITING.has(runStatus)) return 1_000;
  return null;
}

export type SubmitState = "idle" | "busy" | "done" | "error";
export type SubmitEvent = "submit" | "ok" | "fail";

/** A human action's form: submit only from idle or after an error; success is final (the form stays locked). */
export function submitNext(state: SubmitState, event: SubmitEvent): SubmitState {
  if (event === "submit") return state === "idle" || state === "error" ? "busy" : state;
  if (state !== "busy") return state;
  return event === "ok" ? "done" : "error";
}

export function canSubmit(state: SubmitState): boolean {
  return state === "idle" || state === "error";
}
