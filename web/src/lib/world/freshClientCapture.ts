/** Explicit fresh-run capture. Uses the existing controller's accepted observations and its presentation clock. */
import { uncapturedAudioActive } from "./captureAudioBoundary";
import type { StartedSession } from "../api/arena";
import type { Debrief, TrialSnapshot } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { samePublicContent, type SessionObservation, type SessionObserver } from "../trial/sessionObservation";
import { MAX_CLIENT_DOCUMENT_BYTES, MAX_CLIENT_FRAME_BYTES, MAX_CLIENT_FRAMES, type ClientCaptureReason } from "./clientCaptureSchema";
import { parseRecording, recordingCaseErrors, type RecordingResult } from "./parseRecording";
import { RECORDING_FORMAT_V2, type RecordedEvent, type RecordingCase } from "./recording";
import { createWorldCapture, type WorldCapture } from "./worldCapture";
import { isWorldTime, notebookSourceKey, type CameraData, type InputData, type PoseData, type UiData } from "./worldEvents";
import { createCaptureSceneBinding, readKnownScene, type SceneContextReader } from "./sceneContext";

export interface FreshCaptureState {
  readonly phase: "idle" | "armed" | "recording" | "complete" | "incomplete";
  readonly reason: ClientCaptureReason | null;
  readonly captureId: string | null;
  readonly sessionId: string | null;
  readonly trialId: string | null;
  readonly frames: number;
  readonly worldSamples: number;
}
export interface FreshCaptureBinding {
  readonly observer: SessionObserver;
  readonly pose: (data: PoseData) => boolean;
  readonly camera: (data: CameraData) => boolean;
  readonly input: (data: Exclude<InputData, { action: "finding" }>) => boolean;
  readonly inputs: (data: readonly Exclude<InputData, { action: "finding" }>[]) => boolean;
  readonly ui: (data: UiData) => boolean;
}
export function isFreshTextOpening(value: TrialSnapshot): boolean {
  return value.channel === "text" && value.mode !== "harness" && value.status === "running" && value.last_seq === 0
    && value.exchanges_used === 0 && value.turns.length === 0 && value.voice_exchanges.length === 0
    && value.released.length === 0 && value.cards.length === 0 && value.updates.length === 0
    && value.coach_failures.length === 0 && value.finding === null && value.commitment_hash === null;
}
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function createFreshClientCapture(readScene?: SceneContextReader, readUncapturedAudio?: () => boolean) {
  const scene = readScene === undefined ? null : createCaptureSceneBinding(readScene);
  let state: FreshCaptureState = { phase: "idle", reason: null, captureId: null, sessionId: null, trialId: null, frames: 0, worldSamples: 0 };
  const listeners = new Set<() => void>();
  let packet: RecordingCase | null = null;
  let snapshot: TrialSnapshot | null = null;
  let events: RecordedEvent[] = [];
  let frameBytes = 2;
  let world: WorldCapture | null = null;
  let token = 0;
  let lastTime = 0;
  let ready = false;
  let ended = false;
  let terminal = false;
  let debrief: Debrief | null = null;
  let publishedAt: number | undefined;
  const update = (patch: Partial<FreshCaptureState>) => {
    state = { ...state, ...patch };
    for (const notify of listeners) notify();
  };
  const fail = (reason: ClientCaptureReason) => {
    if (state.phase !== "armed" && state.phase !== "recording") return;
    // Retain the accepted prefix for an honestly labelled partial export. Never resume a failed journal.
    update({ phase: "incomplete", reason });
    world?.stop();
  };
  const validateScene = () => {
    if (scene === null || (state.phase !== "armed" && state.phase !== "recording")) return true;
    if (scene.matches()) return true;
    fail("scene-changed"); return false;
  };
  const validateUncapturedAudio = () => {
    if (state.phase !== "armed" && state.phase !== "recording") return true;
    if (!uncapturedAudioActive(readUncapturedAudio)) return true;
    fail("audio-enabled"); return false;
  };
  const clear = () => {
    if (state.phase === "recording") return false;
    scene?.clear();
    token += 1; packet = null; snapshot = null; events = []; frameBytes = 2; world = null;
    lastTime = 0; ready = false; ended = false; terminal = false; debrief = null; publishedAt = undefined;
    update({ phase: "idle", reason: null, captureId: null, sessionId: null, trialId: null, frames: 0, worldSamples: 0 });
    return true;
  };
  const arm = (publicCase: RecordingCase, captureId: string): boolean => {
    if (uncapturedAudioActive(readUncapturedAudio)) return false;
    if (state.phase === "recording" || state.phase === "armed") return false;
    if (readScene !== undefined && readKnownScene(readScene) === null) return false;
    if (recordingCaseErrors(publicCase).length > 0 || byteLength(publicCase) > MAX_CLIENT_DOCUMENT_BYTES
      || !captureId.trim() || captureId.length > 160) return false;
    clear();
    if (scene !== null && !scene.bind()) return false;
    packet = structuredClone(publicCase);
    update({ phase: "armed", captureId });
    return true;
  };
  const prepare = (publicCase: RecordingCase): boolean => {
    if (state.phase !== "armed" || state.sessionId !== null || packet?.case_id !== publicCase.case_id || !validateScene() || !validateUncapturedAudio()) return false;
    if (recordingCaseErrors(publicCase).length > 0) { fail("invalid-data"); return false; }
    if (byteLength(publicCase) > MAX_CLIENT_DOCUMENT_BYTES) { fail("bounds"); return false; }
    packet = structuredClone(publicCase); return true;
  };
  const begin = (started: StartedSession, readClock: () => number): FreshCaptureBinding | null => {
    if (state.phase !== "armed" || packet === null || !validateScene() || !validateUncapturedAudio()) return null;
    if (state.sessionId !== null) { fail("scope-replaced"); return null; }
    if (started.case_id !== packet.case_id || !started.session_id.trim() || started.session_id.length > 160
      || !started.trial_id.trim() || started.trial_id.length > 160) { fail("scope-replaced"); return null; }
    const scope = ++token;
    let at = 0;
    let lastSeq = 0;
    const publicEvidence = new Set(packet.initial_documents.map((doc) => doc.doc_id));
    const publicSources = new Set(packet.initial_documents.map((doc) => notebookSourceKey({ kind: "document", id: doc.doc_id })));
    const active = () => token === scope && (state.phase === "armed" || state.phase === "recording");
    const clock = () => {
      if (!active() || !validateScene() || !validateUncapturedAudio()) return false;
      let value: number;
      try { value = readClock(); } catch { fail("observer-failed"); return false; }
      if (!isWorldTime(value) || value < lastTime) { fail("clock-reset"); return false; }
      at = value; lastTime = value; return true;
    };
    update({ sessionId: started.session_id, trialId: started.trial_id });
    const captured = createWorldCapture({ localOnly: true, localFindingActions: true, ...(readScene === undefined ? {} : { readScene }),
      ...(readUncapturedAudio === undefined ? {} : { readUncapturedAudio }), context: () => ({ sessionKey: started.session_id,
      trialId: started.trial_id, clockMs: at, writable: token === scope && state.phase === "recording",
      publicEvidenceIds: publicEvidence, publicTextFields: new Set(["question-draft"]), publicNotebookSources: publicSources }) });
    world = captured;
    captured.subscribe(() => {
      if (token !== scope) return;
      const s = captured.getSnapshot();
      if (s.status === "blocked") fail(s.issue === "memory-limit" ? "bounds" : s.issue === "clock-reset" ? "clock-reset" : s.issue === "scene-changed" ? "scene-changed" : s.issue === "audio-enabled" ? "audio-enabled" : "invalid-data");
      if (s.count !== state.worldSamples) update({ worldSamples: s.count });
    });
    const finish = () => {
      if (active() && terminal && debrief !== null && publishedAt !== undefined) {
        update({ phase: "complete", reason: null }); captured.stop();
      }
    };
    const observe = (event: SessionObservation) => {
      if (!active()) return;
      if (event.type === "disposed") { fail("scope-replaced"); return; }
      if (event.type === "unsupported") { fail(event.reason); return; }
      if (!clock()) return;
      switch (event.type) {
        case "opening":
          if (snapshot !== null || !isWire("snapshot", event.snapshot) || !isFreshTextOpening(event.snapshot)
            || event.snapshot.mode !== started.mode || at !== 0) { fail("not-fresh"); return; }
          if (byteLength([packet, event.snapshot]) > MAX_CLIENT_DOCUMENT_BYTES) { fail("bounds"); return; }
          snapshot = structuredClone(event.snapshot);
          for (const record of snapshot.requestable) publicEvidence.add(record.record_id);
          update({ phase: "recording" }); captured.start();
          return;
        case "frame": {
          if (snapshot === null || !isWire("events", event.frame) || event.frame.scope_id !== started.trial_id) { fail("invalid-data"); return; }
          const frame = event.frame;
          if (frame.seq !== null && frame.seq !== lastSeq + 1) { fail("sequence-gap"); return; }
          if (frame.type === "debrief.ready" && (frame.data.session_id !== started.session_id || !ended)) { fail("invalid-data"); return; }
          const entry = { at_ms: at, frame };
          const size = byteLength(entry) + (events.length > 0 ? 1 : 0);
          if (events.length >= MAX_CLIENT_FRAMES || frameBytes + size > MAX_CLIENT_FRAME_BYTES) { fail("bounds"); return; }
          events.push(structuredClone(entry)); frameBytes += size;
          if (frame.seq !== null) lastSeq = frame.seq;
          if (frame.type === "evidence.released") {
            publicEvidence.add(frame.data.record_id); publicSources.add(notebookSourceKey({ kind: "record", id: frame.data.record_id }));
          }
          if (frame.type === "trial.status" && frame.data.status !== "running") ended = true;
          if (frame.type === "debrief.ready") ready = true;
          update({ frames: events.length }); return;
        }
        case "finding":
          if (snapshot === null) { fail("not-fresh"); return; }
          captured.input({ action: "finding", operation: event.operation, after_frames: events.length }); return;
        case "terminal":
          if (!event.equivalent || !ready || !ended) { fail("terminal-mismatch"); return; }
          terminal = true; finish(); return;
        case "debrief":
          if (!("schema_version" in event.debrief)) return;
          if (!ready || !ended) { fail("rest-before-ready"); return; }
          if (!isWire("debrief.v1", event.debrief) || event.debrief.session_id !== started.session_id) { fail("invalid-data"); return; }
          if (byteLength(event.debrief) > MAX_CLIENT_DOCUMENT_BYTES) { fail("bounds"); return; }
          if (debrief === null) { debrief = structuredClone(event.debrief); publishedAt = at; }
          else if (!samePublicContent(debrief, event.debrief)) { fail("invalid-data"); return; }
          finish(); return;
      }
    };
    const write = (action: () => boolean, explicit = false) => {
      if (active() && state.phase === "armed" && explicit) { fail("not-fresh"); return false; }
      if (!active() || state.phase !== "recording" || !clock()) return false;
      try { return action(); } catch { fail("observer-failed"); return false; }
    };
    return { observer: { observe, failed: () => { if (token === scope) fail("observer-failed"); } },
      pose: (data) => write(() => captured.pose(data)), camera: (data) => write(() => captured.camera(data)),
      input: (data) => write(() => captured.input(data), true), inputs: (data) => write(() => captured.inputs(data), true), ui: (data) => write(() => captured.ui(data), true) };
  };
  const exportRecording = (): RecordingResult => {
    if ((state.phase !== "complete" && state.phase !== "incomplete") || snapshot === null || packet === null || world === null
      || state.captureId === null || state.sessionId === null || state.trialId === null)
      return { ok: false, errors: ["capture: no stopped fresh-run recording is available"] };
    return parseRecording({ format: RECORDING_FORMAT_V2, trial_id: state.trialId, case: packet, snapshot, events,
      world_events: world.exportEvents().events, debrief, final_snapshot: null,
      ...(publishedAt === undefined ? {} : { published_at_ms: publishedAt }),
      ...(scene?.context() == null ? {} : { scene_context: scene.context() }),
      client_capture: { version: 1, origin: "client-experienced", scope: "accepted-text-and-world-samples", capture_id: state.captureId,
        session_id: state.sessionId, original_audio: "absent", status: state.phase, reason: state.reason } });
  };
  return { arm, prepare, begin, fail, clear, validateScene, validateUncapturedAudio, exportRecording, stop: () => { if (validateScene() && validateUncapturedAudio()) fail("stopped"); }, getSnapshot: () => state,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; } };
}
export type FreshClientCapture = ReturnType<typeof createFreshClientCapture>;
