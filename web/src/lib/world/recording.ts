/**
 * Recorded runs and their playback (D-021). A recording is the trial's opening snapshot, its wire frames in the
 * order the server emitted them with the time each arrived (`at_ms` from the start of the session), the case's
 * public metadata, and, when the session was scored, its published debrief. Playback feeds the frames through the
 * same `trialReducer` the live room uses, so the world cannot tell a replay from a live session: the live seam is
 * the reducer input (snapshot, then frames), and only the source differs (SSE versus this file).
 *
 * Every payload is checked against the wire contracts before use (S6 5.2): a recording that fails any check is
 * refused whole, never partly played.
 */

import type { Content, Debrief, TrialFrame, TrialSnapshot } from "../contracts/generated/types";
import { initialTrialState, trialReducer, type TrialState } from "../trial/trialReducer";

export const RECORDING_FORMAT = "arena.recording.v1";

export interface RecordedEvent {
  readonly at_ms: number;
  readonly frame: TrialFrame;
}

/** An initial document of the public packet (S1; shown on the evidence wall from the start). */
export interface CaseDocument {
  readonly doc_id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: Content;
}

/** Public case metadata only: never role, style, family id or any private or evaluator field. */
export interface RecordingCase {
  readonly case_id: string;
  readonly title: string;
  readonly objective: string;
  readonly domain: string;
  readonly difficulty_level: number;
  readonly subject: { readonly display_name: string; readonly position: string };
  readonly setting: string;
  readonly initial_documents: readonly CaseDocument[];
}

export interface Recording {
  readonly format: typeof RECORDING_FORMAT;
  readonly trial_id: string;
  readonly case: RecordingCase;
  readonly snapshot: TrialSnapshot;
  readonly events: readonly RecordedEvent[];
  readonly debrief: Debrief | null;
  /** The time of the last event. */
  readonly durationMs: number;
}

/**
 * The key of a frame's arrival, by what it is about: the world times its moments (a figure speaking, a record
 * pinning itself, a card handed over) from these. One key per turn, record or trial event; a later frame of the
 * same key does not move the first arrival.
 */
export function arrivalKey(frame: TrialFrame): string {
  switch (frame.type) {
    case "evidence.released":
      return `evidence.released:${frame.data.record_id}`;
    case "question.accepted":
    case "subject.thinking":
    case "subject.answer":
    case "coach.working":
    case "coach.card":
    case "coach.update":
    case "coach.failed":
      return `${frame.type}:${String(frame.data.turn_no)}`;
    default:
      return frame.type;
  }
}

/** The key the opening snapshot arrives under. */
export const SNAPSHOT_ARRIVAL = "snapshot";

/** Record `frame`'s arrival at `atMs`, keeping an earlier arrival of the same key. */
export function noteArrival(arrivals: ReadonlyMap<string, number>, frame: TrialFrame, atMs: number): ReadonlyMap<string, number> {
  const key = arrivalKey(frame);
  if (arrivals.has(key)) return arrivals;
  return new Map(arrivals).set(key, atMs);
}

/** Where playback stands: the time, the next event to apply, the reducer state and the arrivals so far. */
export interface PlaybackCursor {
  readonly t: number;
  readonly next: number;
  readonly state: TrialState;
  readonly arrivals: ReadonlyMap<string, number>;
}

/** The cursor at time 0: the snapshot folded, no event applied. */
export function startCursor(recording: Recording): PlaybackCursor {
  const state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: recording.snapshot });
  return { t: 0, next: 0, state, arrivals: new Map([[SNAPSHOT_ARRIVAL, 0]]) };
}

/**
 * The cursor at time `t` (clamped to the recording). Moving forward applies the events up to and including `t`
 * in order; moving back replays from the start, so a scrub lands on exactly the state an uninterrupted run had.
 */
export function seek(recording: Recording, cursor: PlaybackCursor, t: number): PlaybackCursor {
  const target = Math.min(recording.durationMs, Math.max(0, t));
  let { next, state, arrivals } = target < cursor.t ? startCursor(recording) : cursor;
  for (let event = recording.events[next]; event !== undefined && event.at_ms <= target; event = recording.events[next]) {
    state = trialReducer(state, { type: "frame", frame: event.frame });
    arrivals = noteArrival(arrivals, event.frame, event.at_ms);
    next += 1;
  }
  return { t: target, next, state, arrivals };
}

/** The playback speeds offered (D-021). */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
