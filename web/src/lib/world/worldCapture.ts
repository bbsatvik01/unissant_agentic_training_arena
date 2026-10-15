/** Explicit, bounded, local-first capture. No DOM listeners, storage, microphone or implicit transport. */
import { uncapturedAudioActive } from "./captureAudioBoundary";
import type { Recording, RecordingCase } from "./recording";
import { RECORDING_FORMAT_V2 } from "./recording";
import { UI_WORLD_PROFILE, type WorldEvent as RecordedWorldEvent } from "./recordingTelemetry";
import { parseRecording, type RecordingResult } from "./parseRecording";
import { createCaptureSceneBinding, type SceneContextReader } from "./sceneContext";
import {
  isWorldEvent, isWorldTime, notebookSourceKey, MAX_WORLD_BATCH_BYTES, splitWorldEventBatches, worldEventBatchBytes,
  WORLD_EVENT_BATCH_INTERVAL_MS, MAX_WORLD_EVENTS, MAX_WORLD_EVENTS_BYTES, type CameraData, type InputData, type PoseData, type UiData,
  type WorldEvent, type WorldEventBatch,
} from "./worldEvents";

export const MAX_CAPTURE_EVENTS = MAX_WORLD_EVENTS;
export const MAX_CAPTURE_BYTES = MAX_WORLD_EVENTS_BYTES;
const CONTROL_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyF", "KeyM", "KeyV", "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "Space", "Escape"]);
export interface CaptureContext {
  readonly sessionKey: string;
  readonly trialId: string;
  /** The SAME session-relative clock used by the existing trial/arrival controller. */
  readonly clockMs: number;
  /** False during replay, loading, or when the parent cannot establish this clock's origin. */
  readonly writable: boolean;
  readonly publicEvidenceIds: ReadonlySet<string>;
  readonly publicTextFields: ReadonlySet<string>;
  /** Namespaced notebookSourceKey values: opening documents and already released records only. */
  readonly publicNotebookSources?: ReadonlySet<string>;
}
export type WorldEventSender = (trialId: string, batch: WorldEventBatch) => Promise<void>;
export type CaptureIssue = "unavailable" | "scope-changed" | "clock-reset" | "invalid-event" | "private-input" | "memory-limit" | "scene-changed" | "audio-enabled" | null;
export interface CaptureSnapshot {
  readonly status: "empty" | "recording" | "stopped" | "blocked";
  readonly issue: CaptureIssue;
  readonly sessionKey: string | null;
  readonly trialId: string | null;
  readonly count: number;
  readonly bytes: number;
  readonly pending: number;
  readonly transport: "off" | "ready" | "sending" | "uncertain";
}
export interface CaptureOptions {
  readonly context: () => CaptureContext | null;
  /** Actual mounted scene; legacy API callers may omit it, but new route capture always supplies it. */
  readonly readScene?: SceneContextReader;
  readonly readUncapturedAudio?: () => boolean;
  /** Monotonic scheduling clock only; never used as an event timestamp. */
  readonly now?: () => number;
  /** Hard offline capability boundary for a new local-world run. */
  readonly localOnly?: boolean;
  /** UI-local finding transitions can never be sent through the backend world-event seam. */
  readonly localFindingActions?: boolean;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}
export type RecordingBase = Pick<Recording, "trial_id" | "snapshot" | "events" | "debrief" | "final_snapshot"> & {
  readonly case: RecordingCase;
  readonly world_events?: readonly (WorldEvent | RecordedWorldEvent)[];
};
export type FlushResult = "empty" | "disabled" | "sent" | "uncertain";

export function createWorldCapture(options: CaptureOptions) {
  const maxEvents = options.maxEvents ?? MAX_CAPTURE_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_CAPTURE_EVENTS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 13 || maxBytes > MAX_CAPTURE_BYTES) throw new RangeError("Invalid capture memory limit");
  const now = options.now ?? (() => performance.now());
  const scene = options.readScene === undefined ? null : createCaptureSceneBinding(options.readScene);
  const listeners = new Set<() => void>();
  let state: CaptureSnapshot = { status: "empty", issue: null, sessionKey: null, trialId: null, count: 0, bytes: 13, pending: 0, transport: "off" };
  let events: WorldEvent[] = [];
  let queuedAt: number[] = [];
  let acknowledged = 0;
  let pendingBytes = 13;
  let pendingSince: number | null = null;
  let lastTime = 0;
  let sender: WorldEventSender | null = null;
  let uncertain = false;
  let inFlight: Promise<FlushResult> | null = null;
  const update = (patch: Partial<CaptureSnapshot>) => { state = { ...state, ...patch }; for (const notify of listeners) notify(); };
  const block = (issue: CaptureIssue) => { update({ status: "blocked", issue }); return false; };
  const scopeMatches = (context: CaptureContext | null): context is CaptureContext => context !== null && context.writable
    && context.sessionKey === state.sessionKey && context.trialId === state.trialId;

  const validateScene = (): boolean => {
    if (scene === null) return true;
    if (state.status === "blocked" && state.issue === "scene-changed") return false;
    if (state.status !== "recording") return true;
    return scene.matches() || block("scene-changed");
  };
  const validateUncapturedAudio = (): boolean => {
    if (state.status === "blocked" && state.issue === "audio-enabled") return false;
    return state.status !== "recording" || !uncapturedAudioActive(options.readUncapturedAudio) || block("audio-enabled");
  };
  const validateEnvironment = () => validateScene() && validateUncapturedAudio();
  const start = (): boolean => {
    if (uncapturedAudioActive(options.readUncapturedAudio)) return block("audio-enabled");
    if (scene !== null && !scene.bind()) return block(scene.context() === null ? "unavailable" : "scene-changed");
    const context = options.context();
    if (context === null || !context.writable || !context.sessionKey.trim() || !context.trialId.trim()) return block("unavailable");
    if (state.sessionKey !== null && !scopeMatches(context)) return block("scope-changed");
    // A blocked clock/budget cannot be silently resumed. Export and explicitly clear first.
    if (state.status === "blocked") return false;
    if (!isWorldTime(context.clockMs) || (state.sessionKey !== null && context.clockMs < lastTime)) return block("clock-reset");
    lastTime = context.clockMs;
    update({ status: "recording", issue: null, sessionKey: context.sessionKey, trialId: context.trialId });
    return true;
  };
  const stop = () => { if (validateEnvironment() && state.status === "recording") update({ status: "stopped" }); };
  const disableSender = () => { sender = null; update({ transport: inFlight !== null ? "sending" : uncertain ? "uncertain" : "off" }); };
  const clear = (): boolean => {
    if (inFlight !== null || state.status === "recording") return false;
    scene?.clear();
    events = []; queuedAt = []; acknowledged = 0; pendingBytes = 13; pendingSince = null; lastTime = 0; sender = null; uncertain = false;
    update({ status: "empty", issue: null, sessionKey: null, trialId: null, count: 0, bytes: 13, pending: 0, transport: "off" });
    return true;
  };

  const flush = (): Promise<FlushResult> => {
    if (!validateEnvironment()) return Promise.resolve("disabled");
    if (inFlight !== null) return inFlight;
    if (uncertain) return Promise.resolve("uncertain");
    if (acknowledged === events.length) return Promise.resolve("empty");
    const activeSender = sender;
    const trialId = state.trialId;
    if (activeSender === null || trialId === null || !scopeMatches(options.context())) return Promise.resolve("disabled");
    // One bounded snapshot per flush; newly captured samples wait for the next tick.
    const batches = splitWorldEventBatches(events.slice(acknowledged));
    const run = async (): Promise<FlushResult> => {
      for (const batch of batches) {
        if (!validateEnvironment() || sender !== activeSender || !scopeMatches(options.context())) return "disabled";
        try { await activeSender(trialId, batch); }
        catch { uncertain = true; return "uncertain"; }
        acknowledged += batch.events.length;
        // Keep all local samples for export, including confirmed writes; never discard history on ack.
        pendingBytes = worldEventBatchBytes({ events: events.slice(acknowledged) });
        pendingSince = queuedAt[acknowledged] ?? null;
        update({ pending: events.length - acknowledged });
      }
      return "sent";
    };
    // Start after assigning inFlight, so synchronous throws/reentrant subscribers cannot duplicate writes.
    inFlight = Promise.resolve().then(run).finally(() => {
      inFlight = null;
      update({ transport: uncertain ? "uncertain" : sender === null ? "off" : "ready" });
    });
    update({ transport: "sending" });
    return inFlight;
  };
  const enableSender = (value: WorldEventSender): boolean => {
    if (!validateEnvironment() || options.localOnly === true || state.sessionKey === null || !scopeMatches(options.context())) return false;
    sender = value;
    update({ transport: inFlight !== null ? "sending" : uncertain ? "uncertain" : "ready" });
    return true;
  };
  const retryFlush = (acceptDuplicateRisk: boolean): Promise<FlushResult> => {
    // The seam has no event IDs/deduplication contract. Retry must be an explicit user action.
    if (!acceptDuplicateRisk || inFlight !== null) return inFlight ?? Promise.resolve("uncertain");
    if (sender === null || !scopeMatches(options.context())) return Promise.resolve("disabled");
    uncertain = false;
    return flush();
  };
  const tick = (): Promise<FlushResult> => {
    const at = now();
    if (pendingSince !== null && at < pendingSince) pendingSince = at;
    return pendingSince !== null && at - pendingSince >= WORLD_EVENT_BATCH_INTERVAL_MS ? flush() : Promise.resolve("empty");
  };
  type Sample = Omit<Extract<WorldEvent, { kind: "pose" }>, "t_ms"> | Omit<Extract<WorldEvent, { kind: "camera" }>, "t_ms">
    | Omit<Extract<WorldEvent, { kind: "input" }>, "t_ms"> | Omit<Extract<WorldEvent, { kind: "ui" }>, "t_ms">;
  const captureMany = (samples: readonly Sample[]): boolean => {
    if (state.status !== "recording" || !validateEnvironment()) return false;
    const context = options.context();
    if (!scopeMatches(context)) return block("scope-changed");
    if (!isWorldTime(context.clockMs) || context.clockMs < lastTime) return block("clock-reset");
    if (samples.length > maxEvents - events.length) return block("memory-limit");
    const copies: WorldEvent[] = [];
    let total = state.bytes;
    let queuedBytes = pendingBytes;
    for (const sample of samples) {
      const event: WorldEvent = { ...sample, t_ms: context.clockMs };
      if (!isWorldEvent(event)) return block("invalid-event");
      if (event.kind === "input") {
        const data = event.data;
        if ((data.action === "finding" && !(options.localOnly === true && options.localFindingActions === true))
          || (data.action === "key" && !CONTROL_KEYS.has(data.key))
          || (data.action === "text" && !context.publicTextFields.has(data.field_id))
          || (data.action === "evidence" && !context.publicEvidenceIds.has(data.record_id))) return block("private-input");
        if (data.action === "notebook") {
          const refs = data.operation === "upsert" ? data.metadata?.citations : data.operation === "draft" ? data.draft.citations : [];
          if (refs?.some((ref) => !context.publicNotebookSources?.has(notebookSourceKey(ref))) === true) return block("private-input");
        }
      }
      const copy = structuredClone(event);
      const bytes = worldEventBatchBytes({ events: [copy] }) - 13;
      if (bytes + 13 > MAX_WORLD_BATCH_BYTES) return block("invalid-event");
      total += bytes + (events.length + copies.length > 0 ? 1 : 0);
      if (total > maxBytes) return block("memory-limit");
      queuedBytes += bytes + (events.length + copies.length > acknowledged ? 1 : 0);
      copies.push(copy);
    }
    if (copies.length === 0) return true;
    lastTime = context.clockMs;
    const enqueued = now();
    if (acknowledged === events.length) pendingSince = enqueued;
    pendingBytes = queuedBytes;
    // Accept an explicit multi-note change whole before publishing/flushing. Equal-time order is stable.
    for (const copy of copies) { events.push(copy); queuedAt.push(enqueued); }
    update({ count: events.length, bytes: total, pending: events.length - acknowledged });
    if (pendingBytes >= MAX_WORLD_BATCH_BYTES) void flush();
    return true;
  };
  const capture = (sample: Sample): boolean => captureMany([sample]);
  const exportEvents = (): WorldEventBatch => ({ events: structuredClone(events) });
  const exportRecording = (base: RecordingBase): RecordingResult => {
    if (state.trialId === null || base.trial_id !== state.trialId) return { ok: false, errors: ["capture: trial does not match"] };
    if ((base.world_events?.length ?? 0) > 0) return { ok: false, errors: ["capture: base already has world samples; use its original v2 export to avoid duplicates"] };
    const sceneContext = scene?.context();
    return parseRecording({ ...base, format: RECORDING_FORMAT_V2, world_events: events, world_profile: UI_WORLD_PROFILE,
      ...(sceneContext == null ? {} : { scene_context: sceneContext }) });
  };
  return {
    getSnapshot: () => state,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    start, stop, clear, validateScene, validateUncapturedAudio, enableSender, disableSender, flush, retryFlush, tick, exportEvents, exportRecording,
    pose: (data: PoseData) => capture({ kind: "pose", data }),
    camera: (data: CameraData) => capture({ kind: "camera", data }),
    input: (data: InputData) => capture({ kind: "input", data }),
    /** One accepted user action may replace a notebook. No partial local capture on invalid data/budget. */
    inputs: (data: readonly InputData[]) => captureMany(data.map((item) => ({ kind: "input", data: item }))),
    ui: (data: UiData) => capture({ kind: "ui", data }),
  };
}
export type WorldCapture = ReturnType<typeof createWorldCapture>;
