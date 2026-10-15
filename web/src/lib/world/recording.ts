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
import { initialWorldReplayState, reduceWorldEvent, type WorldEvent, type WorldReplayState } from "./worldEvents";

import type { ClientCaptureMetadata, ClientOrder } from "./clientCaptureSchema";
import type { RecordingSceneContext } from "./sceneContext";

export const RECORDING_FORMAT = "arena.recording.v1";
export const RECORDING_FORMAT_V2 = "arena.recording.v2";

/** Playback runs this long past the last event, so a moment it starts (a seal, a pinned record) completes. */
export const END_TAIL_MS = 3_000;

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
  readonly format: typeof RECORDING_FORMAT | typeof RECORDING_FORMAT_V2;
  readonly trial_id: string;
  readonly case: RecordingCase;
  readonly snapshot: TrialSnapshot;
  readonly events: readonly RecordedEvent[];
  /** V1 normalizes to []; v2 has validated UI samples, stable-sorted by session-relative t_ms. */
  readonly world_events: readonly WorldEvent[];
  readonly debrief: Debrief | null;
  /** The trial's end-of-trial snapshot (null while it ran): in assessment mode, the withheld coaching (FE-DEB-4). */
  readonly final_snapshot: TrialSnapshot | null;
  /** The time of the last event plus a short tail, so the last signature moment plays out (`END_TAIL_MS`). */
  readonly durationMs: number;
  /** Actual client document arrival, after matching readiness. Absent for legacy recordings. */
  readonly published_at_ms?: number;
  readonly client_capture?: ClientCaptureMetadata;
  /** Validated bundled compatibility tuple; absent legacy files replay in the original Office. */
  readonly scene_context?: RecordingSceneContext;
  /** Validated, derived merge order; not serialized or accepted from a file. */
  readonly client_order?: ClientOrder;
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
  readonly nextWorld: number;
  readonly world: WorldReplayState;
  readonly state: TrialState;
  readonly arrivals: ReadonlyMap<string, number>;
}

/** The cursor at time 0: the snapshot folded, no event applied. */
export function startCursor(recording: Recording): PlaybackCursor {
  const state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: recording.snapshot });
  return { t: 0, next: 0, nextWorld: 0, world: initialWorldReplayState(), state, arrivals: new Map([[SNAPSHOT_ARRIVAL, 0]]) };
}

/**
 * The cursor at time `t` (clamped to the recording). Moving forward applies the events up to and including `t`
 * in order; moving back replays from the start, so a scrub lands on exactly the state an uninterrupted run had.
 */
export function seek(recording: Recording, cursor: PlaybackCursor, t: number): PlaybackCursor {
  const target = Math.min(recording.durationMs, Math.max(0, Number.isNaN(t) ? cursor.t : t));
  let { next, nextWorld, state, world, arrivals } = target < cursor.t ? startCursor(recording) : cursor;
  // Both streams are sorted by the parser. On equal timestamps trial frames precede UI samples; ties
  // within a stream keep array order. This same rule is exposed by mergeRecordingEvents for timelines.
  while (next < recording.events.length || nextWorld < recording.world_events.length) {
    const frame = recording.events[next];
    const sample = recording.world_events[nextWorld];
    if (frame !== undefined && frame.at_ms <= target && (sample === undefined || (recording.client_order?.[next + nextWorld] ?? (frame.at_ms <= sample.t_ms ? "trial" : "world")) === "trial")) {
      state = trialReducer(state, { type: "frame", frame: frame.frame });
      arrivals = noteArrival(arrivals, frame.frame, frame.at_ms);
      next += 1;
    } else if (sample !== undefined && sample.t_ms <= target) {
      world = reduceWorldEvent(world, sample);
      if (recording.client_capture !== undefined && sample.kind === "input" && sample.data.action === "finding") {
        state = trialReducer(state, { type: sample.data.operation === "submitted" ? "finding_submitted" : "finding_failed" });
      }
      nextWorld += 1;
    } else break;
  }
  // Reveal the final snapshot only after both streams finish. Rewinding rebuilds from the opening
  // snapshot so final assessment coaching cannot survive a backward scrub into the active session.
  if (next >= recording.events.length && nextWorld >= recording.world_events.length && recording.final_snapshot !== null && target >= (recording.published_at_ms ?? 0)) {
    state = trialReducer(state, { type: "snapshot", snapshot: recording.final_snapshot });
  }
  return { t: target, next, nextWorld, state, world, arrivals };
}

export type ReplayEvent =
  | { readonly t_ms: number; readonly source: "trial"; readonly index: number; readonly frame: TrialFrame }
  | { readonly t_ms: number; readonly source: "world"; readonly index: number; readonly event: WorldEvent };

/** One deterministic timeline: frames first on cross-stream ties, original order within each stream. */
export function mergeRecordingEvents(recording: Recording): readonly ReplayEvent[] {
  const merged: ReplayEvent[] = [];
  let trial = 0;
  let world = 0;
  while (trial < recording.events.length || world < recording.world_events.length) {
    const frame = recording.events[trial];
    const sample = recording.world_events[world];
    if (frame !== undefined && (sample === undefined || (recording.client_order?.[trial + world] ?? (frame.at_ms <= sample.t_ms ? "trial" : "world")) === "trial")) {
      merged.push({ t_ms: frame.at_ms, source: "trial", index: trial, frame: frame.frame });
      trial += 1;
    } else if (sample !== undefined) {
      merged.push({ t_ms: sample.t_ms, source: "world", index: world, event: sample });
      world += 1;
    }
  }
  return merged;
}

/** The playback speeds offered (D-021). */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
