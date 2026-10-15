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

/** The format this player writes about: v2 is v1 plus the world's own telemetry (UI v2); a v1 file still plays. */
export const RECORDING_FORMAT = "arena.recording.v2";
export const RECORDING_FORMATS = ["arena.recording.v1", RECORDING_FORMAT] as const;
export type RecordingFormat = (typeof RECORDING_FORMATS)[number];

/** Playback runs this long past the last event, so a moment it starts (a seal, a pinned record) completes. */
export const END_TAIL_MS = 3_000;

export interface RecordedEvent {
  readonly at_ms: number;
  readonly frame: TrialFrame;
}

/** One moment of the 3D world (recording v2): `t_ms` is on the same clock as an event's `at_ms`. */
export interface WorldEvent {
  readonly t_ms: number;
  readonly kind: "pose" | "camera" | "input" | "ui";
  readonly data: Readonly<Record<string, unknown>>;
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
  readonly format: RecordingFormat;
  readonly trial_id: string;
  readonly case: RecordingCase;
  readonly snapshot: TrialSnapshot;
  readonly events: readonly RecordedEvent[];
  readonly debrief: Debrief | null;
  /** The trial's end-of-trial snapshot (null while it ran): in assessment mode, the withheld coaching (FE-DEB-4). */
  readonly final_snapshot: TrialSnapshot | null;
  /** The world's telemetry in time order (recording v2; empty for a v1 file). */
  readonly world_events: readonly WorldEvent[];
  /** The time of the last event plus a short tail, so the last signature moment plays out (`END_TAIL_MS`). */
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
  // At the end, the end-of-trial snapshot: in assessment mode it brings the coaching the session withheld
  // (FE-DEB-4); the reducer keeps whichever snapshot is newer, so a practice run ends as it played.
  if (next >= recording.events.length && recording.final_snapshot !== null) {
    state = trialReducer(state, { type: "snapshot", snapshot: recording.final_snapshot });
  }
  return { t: target, next, state, arrivals };
}

/** The playback speeds offered (D-021). */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
