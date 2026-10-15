/** A new, explicitly local world-only run. It never borrows a historical trial's identity or results. */
import type { TextTrialSnapshot } from "../contracts/generated/types";
import { recordingCaseErrors, type RecordingResult } from "./parseRecording";
import { RECORDING_FORMAT_V2, type Recording, type RecordingCase } from "./recording";
import { createWorldCapture, type RecordingBase, type WorldCapture } from "./worldCapture";
import { isWorldTime, notebookSourceKey } from "./worldEvents";
import type { SceneContextReader } from "./sceneContext";

export const LOCAL_WORLD_PREFIX = "local-world:";
export const LOCAL_WORLD_REASON = "local_world_capture";

function emptyLocalSnapshot(): TextTrialSnapshot {
  // These are format-compatibility defaults for a zero-turn local display, never a server session,
  // assessment result, exchange entitlement, finding, transcript, or inherited model outcome.
  return { status: "running", reason_code: LOCAL_WORLD_REASON, mode: "practice", split: "dev", channel: "text",
    exchanges_used: 0, exchanges_cap: 12, released: [], requestable: [], finding: null, commitment_hash: null,
    last_seq: 0, turns: [], voice_exchanges: [], cards: [], updates: [], coach_failures: [] };
}

/** Describes only the empty local-world shape. An arbitrary prefix never hides real trial content. */
export function isLocalWorldRecording(recording: Recording): boolean {
  const snapshot = recording.snapshot;
  return recording.format === RECORDING_FORMAT_V2 && recording.trial_id.startsWith(LOCAL_WORLD_PREFIX)
    && recording.trial_id.length > LOCAL_WORLD_PREFIX.length && recording.events.length === 0
    && recording.debrief === null && recording.final_snapshot === null && snapshot.channel === "text"
    && snapshot.status === "running" && snapshot.reason_code === LOCAL_WORLD_REASON && snapshot.mode === "practice" && snapshot.split === "dev"
    && snapshot.exchanges_used === 0 && snapshot.last_seq === 0 && snapshot.finding === null && snapshot.commitment_hash === null
    && snapshot.turns.length + snapshot.voice_exchanges.length + snapshot.released.length + snapshot.requestable.length
      + snapshot.cards.length + snapshot.updates.length + snapshot.coach_failures.length === 0;
}
export interface LocalWorldOptions {
  /** Already public packet only. No snapshot, recording, score, finding or release list is accepted. */
  readonly packet: RecordingCase;
  /** Parent grants ownership only in the new local-world mode, never live/historical playback. */
  readonly isActive: () => boolean;
  readonly readScene?: SceneContextReader;
  readonly readUncapturedAudio?: () => boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function createLocalWorldCapture(options: LocalWorldOptions) {
  if (recordingCaseErrors(options.packet).length > 0) throw new TypeError("Local world capture requires a validated public case packet");
  const now = options.now ?? (() => performance.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const packet = structuredClone(options.packet);
  const clock = { current: 0 };
  let base: RecordingBase | null = null;
  let epoch = 0;
  let elapsed = 0;
  let running = false;
  const capture = createWorldCapture({ localOnly: true, now, ...(options.readScene === undefined ? {} : { readScene: options.readScene }),
    ...(options.readUncapturedAudio === undefined ? {} : { readUncapturedAudio: options.readUncapturedAudio }), context: () => base === null ? null : ({
    sessionKey: base.trial_id, trialId: base.trial_id, clockMs: clock.current, writable: options.isActive(),
    publicEvidenceIds: new Set(packet.initial_documents.map((doc) => doc.doc_id)), publicTextFields: new Set<string>(),
    publicNotebookSources: new Set(packet.initial_documents.map((doc) => notebookSourceKey({ kind: "document", id: doc.doc_id }))),
  }) });
  const advanceClock = () => {
    if (running && options.isActive()) {
      if (!capture.validateScene() || !capture.validateUncapturedAudio() || capture.getSnapshot().status !== "recording") { running = false; return clock.current; }
      const next = elapsed + now() - epoch;
      // A monotonic local display never rewinds on an injected/changed wall clock. No backend time is inferred.
      if (isWorldTime(next)) clock.current = Math.max(clock.current, next);
    }
    return clock.current;
  };
  const start = (): boolean => {
    if (!options.isActive()) return false;
    if (capture.getSnapshot().status === "recording") return true;
    const startAt = now();
    if (!Number.isFinite(startAt) || startAt < 0) return false;
    if (base === null) {
      const id = newId(); if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return false;
      base = { trial_id: `${LOCAL_WORLD_PREFIX}${id}`, case: packet, snapshot: emptyLocalSnapshot(), events: [], debrief: null, final_snapshot: null };
      clock.current = 0;
    }
    epoch = startAt; elapsed = clock.current;
    running = capture.start();
    return running;
  };
  const stop = () => { advanceClock(); running = false; capture.stop(); };
  const clear = (): boolean => {
    if (!capture.clear()) return false;
    base = null; clock.current = 0; epoch = 0; elapsed = 0; running = false;
    return true;
  };
  const exportRecording = (): RecordingResult => base === null
    ? { ok: false, errors: ["local capture: start and capture actual world samples before exporting"] }
    : capture.exportRecording(base);
  const controller: WorldCapture = { ...capture, start, stop, clear };
  return { controller, clock, advanceClock, exportRecording };
}
export type LocalWorldCapture = ReturnType<typeof createLocalWorldCapture>;
