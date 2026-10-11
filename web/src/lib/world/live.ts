/**
 * The live seam (D-021, stage 2): a real session feeds the same world as a recording. The session controller folds
 * SSE frames into the trial reducer; this module turns each new reducer state into the frames' arrival times on the
 * session clock, which is all the world needs besides the view (who started speaking when, which record just
 * pinned itself). Frames already in the opening snapshot, or replayed history at the start, never animate: they
 * have no arrival, exactly like history before a recording's first event.
 */
import type { TrialFrame } from "../contracts/generated/types";
import type { TrialState } from "../trial/trialReducer";
import { noteArrival, SNAPSHOT_ARRIVAL } from "./recording";

/** What has been seen so far: persisted seqs, hint keys, and the arrivals noted for them. */
export interface ArrivalTracker {
  readonly seenSeqs: ReadonlySet<number>;
  readonly seenHints: ReadonlySet<string>;
  readonly arrivals: ReadonlyMap<string, number>;
  /** True once the first snapshot was taken in; frames before it are history. */
  readonly started: boolean;
}

export const EMPTY_TRACKER: ArrivalTracker = { seenSeqs: new Set(), seenHints: new Set(), arrivals: new Map(), started: false };

/**
 * Note the frames this state holds that the tracker has not seen, at `nowMs`. The first state with a snapshot marks
 * everything it already holds as seen without an arrival (history), and the snapshot itself arrives at `nowMs`.
 * Persisted frames are taken in `seq` order; hints after them. Returns the same tracker when nothing is new.
 */
export function trackArrivals(tracker: ArrivalTracker, state: TrialState, nowMs: number): ArrivalTracker {
  if (state.snapshot === null) return tracker;
  const fresh: TrialFrame[] = [];
  const seqs = new Set(tracker.seenSeqs);
  const hints = new Set(tracker.seenHints);
  for (const [seq, frame] of [...state.log.entries()].sort(([a], [b]) => a - b)) {
    if (seqs.has(seq)) continue;
    seqs.add(seq);
    fresh.push(frame);
  }
  for (const [key, frame] of state.hints) {
    if (hints.has(key)) continue;
    hints.add(key);
    fresh.push(frame);
  }
  if (!tracker.started) {
    return { seenSeqs: seqs, seenHints: hints, arrivals: new Map([[SNAPSHOT_ARRIVAL, nowMs]]), started: true };
  }
  if (fresh.length === 0) return tracker;
  let arrivals = tracker.arrivals;
  for (const frame of fresh) arrivals = noteArrival(arrivals, frame, nowMs);
  return { seenSeqs: seqs, seenHints: hints, arrivals, started: true };
}

/** The composer's draft once a question was accepted: cleared only when it still holds the question sent, so a next
 * question typed (or taken from a card) while the earlier request was in flight is kept. */
export function draftAfterSend(current: string, sent: string): string {
  return current === sent ? "" : current;
}
