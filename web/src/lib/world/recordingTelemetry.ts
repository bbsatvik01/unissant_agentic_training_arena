/** Bounded recording-v2 wire data. Unknown JSON stays inert; only checked UI samples reach the reducer. */
import { isWorldEvent, MAX_WORLD_EVENTS, parseWorldEvents, type WorldEvent as UiWorldEvent } from "./worldEvents";

export const UI_WORLD_PROFILE = "arena.ui-world.v1";
export const WORLD_TRANSPORT_MAX_TIME_MS = 86_400_000;
export const WORLD_TRANSPORT_MAX_BATCH_EVENTS = 2_000;
export const MAX_TRANSPORT_WORLD_BYTES = 16_777_216;
export const MAX_ANNOTATIONS = 10_000;
export const MAX_ANNOTATION_BYTES = 4_000_000;
export const MAX_GENERIC_JSON_DEPTH = 32;
export const MAX_GENERIC_JSON_NODES = 100_000;
export interface WorldEvent { readonly t_ms: number; readonly kind: "pose" | "camera" | "input" | "ui"; readonly data: Readonly<Record<string, unknown>> }
export interface Annotation { readonly t_ms: number; readonly text: string; readonly created_at: string }
export function transportWorldTime(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= WORLD_TRANSPORT_MAX_TIME_MS; }
function plain(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
/** Iterative, bounded JSON-only check: no getters, prototypes, cycles, sparse arrays or executable values. */
export function boundedJson(value: unknown): boolean {
  const stack = [{ value, depth: 0 }]; const seen = new Set<object>(); let nodes = 0;
  while (stack.length > 0) {
    const next = stack.pop(); if (next === undefined) break;
    if (++nodes > MAX_GENERIC_JSON_NODES || next.depth > MAX_GENERIC_JSON_DEPTH) return false;
    const item = next.value;
    if (item === null || typeof item === "boolean" || typeof item === "string") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== "object" || (!Array.isArray(item) && !plain(item)) || seen.has(item)) return false;
    seen.add(item);
    const names = Object.keys(item);
    if (Reflect.ownKeys(item).length !== names.length + (Array.isArray(item) ? 1 : 0)
      || (Array.isArray(item) && Object.getPrototypeOf(item) !== Array.prototype)) return false;
    if (names.length > MAX_GENERIC_JSON_NODES - nodes || (Array.isArray(item) && names.length !== item.length)) return false;
    for (const name of names) {
      if (["__proto__", "constructor", "prototype"].includes(name)) return false;
      if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(name)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      stack.push({ value: descriptor.value as unknown, depth: next.depth + 1 });
    }
  }
  return true;
}
function member(value: unknown, allowed: readonly string[]): boolean { return typeof value === "string" && allowed.includes(value); }
function declaresUiSample(value: unknown): boolean {
  if (!plain(value) || !plain(value["data"])) return false;
  const data = value["data"];
  if (value["kind"] === "pose") return Object.hasOwn(data, "actor_id") || Object.hasOwn(data, "animation");
  if (value["kind"] === "camera") return member(data["mode"], ["first", "third", "free"]);
  return (value["kind"] === "input" && member(data["action"], ["key", "click", "text", "finding", "notebook", "evidence"]))
    || (value["kind"] === "ui" && member(data["action"], ["panel", "file_page"]));
}
export function uiWorldSample(value: unknown): UiWorldEvent | null { return isWorldEvent(value) ? value : null; }
export function uiWorldSamples(values: readonly unknown[]): readonly UiWorldEvent[] { return values.filter(isWorldEvent); }
interface Telemetry { readonly events: readonly WorldEvent[]; readonly samples: readonly UiWorldEvent[]; readonly unsupported: number; readonly profile?: typeof UI_WORLD_PROFILE }
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };
export function parseRecordingTelemetry(raw: unknown, local: boolean): Result<Telemetry> {
  if (!Array.isArray(raw)) return { ok: false, errors: ["world_events: must be a list"] };
  if (raw.length > MAX_WORLD_EVENTS) return { ok: false, errors: ["world_events: too many samples"] };
  if (!Array.from(raw).every((event: unknown) => boundedJson(event))) return { ok: false, errors: ["world_events: non-JSON or over-complex data"] };
  if (Array.from(raw).some((event: unknown) => declaresUiSample(event) && !isWorldEvent(event)))
    return { ok: false, errors: ["world_events: malformed declared UI sample"] };
  // Old fully typed UI captures retain their fractional clock and stable ordering. Generic wire streams use
  // the server's integer/day/order envelope. A declared local profile NEVER falls back after a failed check.
  const typed = local || (raw.length > 0 && Array.from(raw).every(isWorldEvent));
  if (typed) {
    const checked = parseWorldEvents(raw);
    if (!checked.ok) return checked;
    const events = checked.events.map((event) => ({ ...event, data: { ...event.data } }));
    return { ok: true, value: { events, samples: checked.events, unsupported: 0, profile: UI_WORLD_PROFILE } };
  }
  const events: WorldEvent[] = []; const samples: UiWorldEvent[] = []; let previous = 0; let bytes = 2;
  for (const event of raw as readonly unknown[]) {
    if (!plain(event) || !keys(event, ["t_ms", "kind", "data"]) || !boundedJson(event)
      || !transportWorldTime(event["t_ms"]) || event["t_ms"] < previous
      || !member(event["kind"], ["pose", "camera", "input", "ui"]) || !plain(event["data"])) {
      return { ok: false, errors: ["world_events: needs exactly t_ms, kind and data in a bounded transport envelope, with valid kind/data and t_ms order"] };
    }
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (size + 13 > 65_536 || (bytes += size + (events.length > 0 ? 1 : 0)) > MAX_TRANSPORT_WORLD_BYTES)
      return { ok: false, errors: ["world_events: transport sample or journal byte limit exceeded"] };
    const copy = structuredClone(event) as unknown as WorldEvent;
    previous = copy.t_ms; events.push(copy);
    const sample = uiWorldSample(copy); if (sample !== null) samples.push(sample);
  }
  return { ok: true, value: { events, samples, unsupported: events.length - samples.length } };
}
export function parseAnnotations(raw: unknown): Result<readonly Annotation[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ANNOTATIONS) return { ok: false, errors: ["annotations: must be a list within the count limit"] };
  const notes: Annotation[] = []; let previous = 0; let bytes = 2;
  for (const note of raw as readonly unknown[]) {
    if (!plain(note) || !keys(note, ["t_ms", "text", "created_at"]) || !boundedJson(note)
      || !transportWorldTime(note["t_ms"]) || note["t_ms"] < previous || typeof note["text"] !== "string"
      || note["text"].length === 0 || note["text"].length > 4_000 || Array.from(note["text"]).length > 2_000
      || typeof note["created_at"] !== "string" || note["created_at"].length === 0 || note["created_at"].length > 64
      || !Number.isFinite(Date.parse(note["created_at"]))) return { ok: false, errors: ["annotations: needs bounded t_ms, text and created_at in time order"] };
    bytes += new TextEncoder().encode(JSON.stringify(note)).byteLength + (notes.length > 0 ? 1 : 0);
    if (bytes > MAX_ANNOTATION_BYTES) return { ok: false, errors: ["annotations: byte limit exceeded"] };
    previous = note["t_ms"]; notes.push({ t_ms: previous, text: note["text"], created_at: note["created_at"] });
  }
  return { ok: true, value: notes };
}
