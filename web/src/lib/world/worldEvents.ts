/**
 * Public UI telemetry only. These locally validated shapes implement the UI-v2 seam; they do not replace
 * generated server contracts. A pose is a captured transform/clip sample, never a judgment about a person.
 * Replay holds the latest captured sample. It does not invent motion, re-run input, or call an API.
 */
import type { CameraMode, Vec3 } from "../precinct/types";

export type Quaternion = readonly [number, number, number, number];
export interface PoseData {
  readonly actor_id: string;
  readonly position: Vec3;
  readonly rotation: Quaternion;
  /** Clip time in seconds, sampled together with the transform. */
  readonly animation: { readonly clip: string; readonly time: number };
}
export interface CameraData {
  readonly mode: CameraMode;
  readonly position: Vec3;
  readonly quaternion: Quaternion;
  /** Vertical field of view in degrees. */
  readonly fov: number;
}
/** Public source IDs are namespaced; a document and a released record may share an ID. */
export interface NotebookCitation { readonly kind: "document" | "record"; readonly id: string }
export type NotebookKind = "observation" | "question" | "timeline" | "contradiction";
export interface NotebookMetadata {
  readonly kind: NotebookKind;
  readonly citations: readonly NotebookCitation[];
  /** Original notebook timestamps, possibly wall time. Never substitute the replay clock. */
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface NotebookDraftData {
  readonly kind: NotebookKind;
  readonly text: string;
  readonly citations: readonly NotebookCitation[];
  readonly editingId: string | null;
}
export type NotebookInput =
  | { readonly action: "notebook"; readonly operation: "upsert"; readonly note_id: string; readonly text: string; readonly metadata?: NotebookMetadata }
  | { readonly action: "notebook"; readonly operation: "delete"; readonly note_id: string }
  | { readonly action: "notebook"; readonly operation: "clear" }
  | { readonly action: "notebook"; readonly operation: "draft"; readonly draft: NotebookDraftData };
export function notebookSourceKey(ref: NotebookCitation): string { return JSON.stringify([ref.kind, ref.id]); }
export type InputData =
  | { readonly action: "key"; readonly key: string; readonly pressed: boolean }
  | { readonly action: "click"; readonly target: string; readonly button: number }
  | { readonly action: "text"; readonly field_id: string; readonly value: string }
  | { readonly action: "finding"; readonly operation: "submitted" | "failed"; readonly after_frames: number }
  | NotebookInput
  | { readonly action: "evidence"; readonly operation: "inspect" | "pin" | "unpin" | "request"; readonly record_id: string };
export type UiData =
  | { readonly action: "panel"; readonly panel_id: string; readonly open: boolean }
  | { readonly action: "file_page"; readonly file_id: string; readonly page: number };
export type WorldEvent =
  | { readonly t_ms: number; readonly kind: "pose"; readonly data: PoseData }
  | { readonly t_ms: number; readonly kind: "camera"; readonly data: CameraData }
  | { readonly t_ms: number; readonly kind: "input"; readonly data: InputData }
  | { readonly t_ms: number; readonly kind: "ui"; readonly data: UiData };

/** Decimal KB is deliberately conservative: this also fits a 64 KiB server cap. */
export const MAX_WORLD_BATCH_BYTES = 64_000;
/** Bound parsing and local capture memory before copying untrusted samples. */
export const MAX_WORLD_EVENTS = 100_000;
export const MAX_WORLD_EVENTS_BYTES = 16_000_000;
export const WORLD_EVENT_BATCH_INTERVAL_MS = 350;
export const MAX_NOTE_CHARACTERS = 16_000;
export const MAX_INPUT_TEXT_CHARACTERS = 16_000;
/** Metres from the local scene origin, far beyond the precinct while remaining safe for rendering. */
export const MAX_WORLD_COORDINATE = 1_000_000;
/** Leave space for a recording's end tail without overflowing the exact timestamp range. */
export const MAX_WORLD_TIME_MS = Number.MAX_SAFE_INTEGER - 3_000;

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function vector(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && Array.from(value).every(finite);
}
function position(value: unknown): boolean {
  return vector(value, 3) && (value as number[]).every((coordinate) => Math.abs(coordinate) <= MAX_WORLD_COORDINATE);
}
function quaternion(value: unknown): boolean {
  // Do not normalize or silently fix a recording. Renderer quaternions must already be unit length.
  return vector(value, 4) && Math.abs(Math.hypot(...value as number[]) - 1) <= 0.001;
}
export function isWorldTime(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= MAX_WORLD_TIME_MS;
}
function pose(value: Readonly<Record<string, unknown>>): boolean {
  const animation = value["animation"];
  return fields(value, ["actor_id", "position", "rotation", "animation"])
    && identifier(value["actor_id"]) && position(value["position"]) && quaternion(value["rotation"])
    && object(animation) && fields(animation, ["clip", "time"])
    && identifier(animation["clip"]) && finite(animation["time"]) && animation["time"] >= 0 && animation["time"] <= MAX_WORLD_TIME_MS / 1_000;
}
function camera(value: Readonly<Record<string, unknown>>): boolean {
  return fields(value, ["mode", "position", "quaternion", "fov"])
    && (value["mode"] === "first" || value["mode"] === "third" || value["mode"] === "free")
    && position(value["position"]) && quaternion(value["quaternion"])
    && finite(value["fov"]) && value["fov"] > 0 && value["fov"] < 180;
}
function notebookId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180;
}
function notebookKind(value: unknown): boolean {
  return value === "observation" || value === "question" || value === "timeline" || value === "contradiction";
}
function citations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  const seen = new Set<string>();
  for (const ref of value as unknown[]) {
    if (!object(ref) || !fields(ref, ["kind", "id"]) || (ref["kind"] !== "document" && ref["kind"] !== "record") || !notebookId(ref["id"])) return false;
    const key = notebookSourceKey({ kind: ref["kind"], id: ref["id"] });
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
function notebookMetadata(value: unknown): boolean {
  return object(value) && fields(value, ["kind", "citations", "createdAtMs", "updatedAtMs"])
    && notebookKind(value["kind"]) && citations(value["citations"])
    && finite(value["createdAtMs"]) && value["createdAtMs"] >= 0 && value["createdAtMs"] <= Number.MAX_SAFE_INTEGER
    && finite(value["updatedAtMs"]) && value["updatedAtMs"] >= value["createdAtMs"] && value["updatedAtMs"] <= Number.MAX_SAFE_INTEGER;
}
function notebook(value: Readonly<Record<string, unknown>>): boolean {
  switch (value["operation"]) {
    case "clear": return fields(value, ["action", "operation"]);
    case "delete": return fields(value, ["action", "operation", "note_id"]) && notebookId(value["note_id"]);
    case "upsert": {
      const rich = Object.hasOwn(value, "metadata");
      return fields(value, rich ? ["action", "operation", "note_id", "text", "metadata"] : ["action", "operation", "note_id", "text"])
        && notebookId(value["note_id"]) && typeof value["text"] === "string" && value["text"].length <= (rich ? 2_000 : MAX_NOTE_CHARACTERS)
        && (!rich || (value["text"].trim().length > 0 && notebookMetadata(value["metadata"])));
    }
    case "draft": {
      const draft = value["draft"];
      return fields(value, ["action", "operation", "draft"]) && object(draft) && fields(draft, ["kind", "text", "citations", "editingId"])
        && notebookKind(draft["kind"]) && typeof draft["text"] === "string" && draft["text"].length <= 2_000
        && citations(draft["citations"]) && (draft["editingId"] === null || notebookId(draft["editingId"]));
    }
    default: return false;
  }
}

function input(value: Readonly<Record<string, unknown>>): boolean {
  switch (value["action"]) {
    case "key":
      return fields(value, ["action", "key", "pressed"]) && identifier(value["key"]) && typeof value["pressed"] === "boolean";
    case "click":
      return fields(value, ["action", "target", "button"]) && identifier(value["target"])
        && finite(value["button"]) && Number.isInteger(value["button"]) && value["button"] >= 0 && value["button"] <= 4;
    case "text":
      return fields(value, ["action", "field_id", "value"]) && identifier(value["field_id"])
        && typeof value["value"] === "string" && value["value"].length <= MAX_INPUT_TEXT_CHARACTERS;
    case "finding":
      return fields(value, ["action", "operation", "after_frames"])
        && (value["operation"] === "submitted" || value["operation"] === "failed")
        && typeof value["after_frames"] === "number" && Number.isSafeInteger(value["after_frames"])
        && value["after_frames"] >= 0 && value["after_frames"] <= 20_000;
    case "notebook": return notebook(value);
    case "evidence":
      return fields(value, ["action", "operation", "record_id"]) && identifier(value["record_id"])
        && (value["operation"] === "inspect" || value["operation"] === "pin" || value["operation"] === "unpin" || value["operation"] === "request");
    default:
      return false;
  }
}
function ui(value: Readonly<Record<string, unknown>>): boolean {
  switch (value["action"]) {
    case "panel":
      return fields(value, ["action", "panel_id", "open"]) && identifier(value["panel_id"]) && typeof value["open"] === "boolean";
    case "file_page":
      return fields(value, ["action", "file_id", "page"]) && identifier(value["file_id"])
        && finite(value["page"]) && Number.isSafeInteger(value["page"]) && value["page"] >= 1;
    default:
      return false;
  }
}

/** Fail closed on unknown fields, including nested payloads, rather than carrying private metadata through. */
export function isWorldEvent(value: unknown): value is WorldEvent {
  if (!object(value) || !fields(value, ["t_ms", "kind", "data"]) || !isWorldTime(value["t_ms"]) || !object(value["data"])) return false;
  switch (value["kind"]) {
    case "pose": return pose(value["data"]);
    case "camera": return camera(value["data"]);
    case "input": return input(value["data"]);
    case "ui": return ui(value["data"]);
    default: return false;
  }
}

export type WorldEventsResult = { readonly ok: true; readonly events: readonly WorldEvent[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Stable ties retain capture/export array order; no inferred or fabricated sequence number. */
export function parseWorldEvents(raw: unknown): WorldEventsResult {
  if (!Array.isArray(raw)) return { ok: false, errors: ["world_events: must be a list"] };
  if (raw.length > MAX_WORLD_EVENTS) return { ok: false, errors: ["world_events: too many samples"] };
  const events: WorldEvent[] = [];
  const errors: string[] = [];
  let bytes = 13;
  for (let i = 0; i < raw.length; i += 1) {
    const value: unknown = raw[i];
    if (isWorldEvent(value) && worldEventBatchBytes({ events: [value] }) <= MAX_WORLD_BATCH_BYTES) {
      bytes += worldEventBatchBytes({ events: [value] }) - 13 + (i > 0 ? 1 : 0);
      if (bytes > MAX_WORLD_EVENTS_BYTES) return { ok: false, errors: ["world_events: sample data exceeds the memory limit"] };
      events.push(structuredClone(value));
    } else errors.push(`world_events[${String(i)}]: invalid public UI event`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, events: events.sort((a, b) => a.t_ms - b.t_ms) };
}

export interface NotebookEntry {
  readonly id: string; readonly text: string;
  /** Capture time for legacy consumers; original note timestamps live only in metadata. */
  readonly updatedAtMs: number;
  readonly metadata?: NotebookMetadata;
}
export interface WorldReplayState {
  readonly actors: ReadonlyMap<string, PoseData>;
  readonly camera: CameraData | null;
  readonly pressedKeys: ReadonlySet<string>;
  readonly lastInput: InputData | null;
  /** Explicitly captured public form drafts; never synthesized keyboard input or automatic submissions. */
  readonly textDrafts: ReadonlyMap<string, string>;
  readonly notes: ReadonlyMap<string, NotebookEntry>;
  readonly notebookDraft: NotebookDraftData | null;
  readonly openPanels: ReadonlySet<string>;
  readonly filePages: ReadonlyMap<string, number>;
  readonly pinnedEvidence: ReadonlySet<string>;
  readonly inspectedEvidence: string | null;
  readonly requestedEvidence: ReadonlySet<string>;
}
export function initialWorldReplayState(): WorldReplayState {
  return { actors: new Map(), camera: null, pressedKeys: new Set(), lastInput: null, textDrafts: new Map(), notes: new Map(), notebookDraft: null,
    openPanels: new Set(), filePages: new Map(), pinnedEvidence: new Set(), inspectedEvidence: null, requestedEvidence: new Set() };
}
function membership<T>(original: ReadonlySet<T>, item: T, present: boolean): ReadonlySet<T> {
  const changed = new Set(original);
  if (present) changed.add(item);
  else changed.delete(item);
  return changed;
}

/** Applies recorded UI facts only. A replayed evidence request is a display marker, never a network request. */
export function reduceWorldEvent(state: WorldReplayState, event: WorldEvent): WorldReplayState {
  switch (event.kind) {
    case "pose": return { ...state, actors: new Map(state.actors).set(event.data.actor_id, structuredClone(event.data)) };
    case "camera": return { ...state, camera: structuredClone(event.data) };
    case "ui": {
      const data = event.data;
      return data.action === "panel" ? { ...state, openPanels: membership(state.openPanels, data.panel_id, data.open) }
        : { ...state, filePages: new Map(state.filePages).set(data.file_id, data.page) };
    }
    case "input": {
      const data = event.data;
      const next = { ...state, lastInput: structuredClone(data) };
      switch (data.action) {
        case "key": return { ...next, pressedKeys: membership(state.pressedKeys, data.key, data.pressed) };
        case "click":
        case "finding": return next;
        case "text": return { ...next, textDrafts: new Map(state.textDrafts).set(data.field_id, data.value) };
        case "notebook": {
          if (data.operation === "draft") return { ...next, notebookDraft: structuredClone(data.draft) };
          if (data.operation === "clear") return { ...next, notes: new Map() };
          const notes = new Map(state.notes);
          if (data.operation === "delete") notes.delete(data.note_id);
          else notes.set(data.note_id, { id: data.note_id, text: data.text, updatedAtMs: event.t_ms,
            ...(data.metadata === undefined ? {} : { metadata: structuredClone(data.metadata) }) });
          return { ...next, notes };
        }
        case "evidence":
          switch (data.operation) {
            case "inspect": return { ...next, inspectedEvidence: data.record_id };
            case "request": return { ...next, requestedEvidence: membership(state.requestedEvidence, data.record_id, true) };
            case "pin": return { ...next, pinnedEvidence: membership(state.pinnedEvidence, data.record_id, true) };
            case "unpin": return { ...next, pinnedEvidence: membership(state.pinnedEvidence, data.record_id, false) };
          }
      }
    }
  }
}

export interface WorldEventBatch { readonly events: readonly WorldEvent[] }
export function worldEventBatchBytes(batch: WorldEventBatch): number {
  return new TextEncoder().encode(JSON.stringify(batch)).byteLength;
}

/**
 * Split the actual UTF-8 JSON POST bodies, including envelope, escaping and commas. Never silently truncate
 * an event. Input order is retained. A rejected/oversized event fails the whole split before any I/O occurs.
 */
export function splitWorldEventBatches(events: readonly WorldEvent[], maxBytes = MAX_WORLD_BATCH_BYTES): readonly WorldEventBatch[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 13 || maxBytes > MAX_WORLD_BATCH_BYTES) throw new RangeError("Invalid world-event byte limit");
  const batches: WorldEventBatch[] = [];
  let batch: WorldEvent[] = [];
  let size = 13; // UTF-8 byte length of {"events":[]}.
  for (const [i, event] of events.entries()) {
    if (!isWorldEvent(event)) throw new TypeError(`Invalid world event at index ${String(i)}`);
    const copy = structuredClone(event);
    const eventBytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength;
    if (13 + eventBytes > maxBytes) throw new RangeError(`World event at index ${String(i)} exceeds the batch limit`);
    const extra = eventBytes + (batch.length > 0 ? 1 : 0);
    if (size + extra > maxBytes) {
      batches.push({ events: batch });
      batch = [];
      size = 13;
    }
    size += eventBytes + (batch.length > 0 ? 1 : 0);
    batch.push(copy);
  }
  if (batch.length > 0) batches.push({ events: batch });
  return batches;
}

/** Caller flushes on this deadline, the byte cap, and lifecycle boundaries; no timers or transport here. */
export function worldEventBatchDue(firstQueuedAtMs: number | null, nowMs: number, intervalMs = WORLD_EVENT_BATCH_INTERVAL_MS): boolean {
  if (!finite(intervalMs) || intervalMs < 250 || intervalMs > 500) throw new RangeError("World-event interval must be 250–500 ms");
  return firstQueuedAtMs !== null && isWorldTime(firstQueuedAtMs) && isWorldTime(nowMs) && nowMs - firstQueuedAtMs >= intervalMs;
}
