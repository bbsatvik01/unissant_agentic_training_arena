/** Explicit route adapter: preserve canonical start guards before offering preparation notes. */
import type { PrecinctSession } from "../../routes/precinct/usePrecinctSession";

export type InterviewStartKind = Parameters<PrecinctSession["startInterview"]>[0];
export type InterviewStartSession = Pick<PrecinctSession, "canStart" | "modes" | "source" | "startInterview"> & {
  readonly live: Pick<PrecinctSession["live"], "phase" | "resumable">;
};
export interface InterviewPreparation {
  readonly prepareForNewRun: () => boolean;
  readonly discardPreparation: () => void;
}

export function canStartInterview(session: InterviewStartSession, kind: InterviewStartKind): boolean {
  if (!session.canStart) return false;
  if (session.source === "live" && (session.live.phase === "starting" || session.live.phase === "running")) return false;
  if (kind === "resume") return session.live.resumable !== null && session.modes.includes(session.live.resumable.mode);
  return session.modes.includes(kind === "voice" ? "practice" : kind);
}

/** Call in the click handler with the current controller; it neither starts nor stores anything on creation. */
export function startPreparedInterview(session: InterviewStartSession, preparation: InterviewPreparation, kind: InterviewStartKind): boolean {
  if (!canStartInterview(session, kind)) return false;
  if (kind === "resume" || session.source === "recording") preparation.discardPreparation();
  else if (session.source === "idle") preparation.prepareForNewRun();
  // A failed pending new start may retry from live/error. Keep its existing offer; do not arm the empty run.
  session.startInterview(kind);
  return true;
}
