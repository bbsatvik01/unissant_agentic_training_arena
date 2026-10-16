/** UI-local v2 provenance. A file's claim is untrusted; this is never a server signature. */
import type { RecordedEvent } from "./recording";
import { isWorldTime, type WorldEvent } from "./worldEvents";

export const MAX_CLIENT_FRAMES = 20_000;
export const MAX_CLIENT_FRAME_BYTES = 8_000_000;
export const MAX_CLIENT_DOCUMENT_BYTES = 2_000_000;
export const CLIENT_CAPTURE_REASONS = ["not-fresh", "unsupported-channel", "audio-enabled", "scope-replaced", "resync", "disposition", "sequence-gap", "rest-before-ready", "terminal-mismatch", "clock-reset", "bounds", "invalid-data", "observer-failed", "stopped", "start-failed", "scene-changed"] as const;
export type ClientCaptureReason = typeof CLIENT_CAPTURE_REASONS[number];
export interface ClientCaptureMetadata {
  readonly version: 1;
  readonly origin: "client-experienced";
  readonly scope: "accepted-text-and-world-samples";
  readonly capture_id: string;
  readonly session_id: string;
  readonly original_audio: "absent";
  readonly status: "complete" | "incomplete";
  readonly reason: ClientCaptureReason | null;
}
export function isClientCaptureMetadata(raw: unknown): raw is ClientCaptureMetadata {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const v = raw as Readonly<Record<string, unknown>>;
  const keys = ["version", "origin", "scope", "capture_id", "session_id", "original_audio", "status", "reason"];
  const id = (x: unknown) => typeof x === "string" && x.trim().length > 0 && x.length <= 160;
  return Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key))
    && v["version"] === 1 && v["origin"] === "client-experienced" && v["scope"] === "accepted-text-and-world-samples"
    && id(v["capture_id"]) && id(v["session_id"]) && v["original_audio"] === "absent"
    && ((v["status"] === "complete" && v["reason"] === null)
      || (v["status"] === "incomplete" && CLIENT_CAPTURE_REASONS.some((reason) => reason === v["reason"])));
}
export type ClientOrder = readonly ("trial" | "world")[];
/** An accepted-frame count anchors only local reducer actions. It is not a server sequence. */
export function clientEventOrder(events: readonly RecordedEvent[], world: readonly WorldEvent[]): ClientOrder | null {
  const order: ("trial" | "world")[] = [];
  let frameIndex = 0;
  let worldIndex = 0;
  while (frameIndex < events.length || worldIndex < world.length) {
    const frame = events[frameIndex];
    const sample = world[worldIndex];
    if (sample === undefined) { order.push("trial"); frameIndex += 1; continue; }
    if (frame === undefined || sample.t_ms < frame.at_ms) { order.push("world"); worldIndex += 1; continue; }
    if (frame.at_ms < sample.t_ms) { order.push("trial"); frameIndex += 1; continue; }
    // Work through this equal-time group once. Preserve each stream's order, and each finding's
    // exact position relative to accepted frames. Other ties keep the original frame-first rule.
    const at = sample.t_ms;
    let end = worldIndex;
    while (world[end]?.t_ms === at) end += 1;
    for (let i = worldIndex; i < end; i += 1) {
      const marker = world[i];
      if (marker?.kind !== "input" || marker.data.action !== "finding") continue;
      while (frameIndex < marker.data.after_frames) { order.push("trial"); frameIndex += 1; }
      while (worldIndex <= i) { order.push("world"); worldIndex += 1; }
    }
    while (events[frameIndex]?.at_ms === at) { order.push("trial"); frameIndex += 1; }
    while (worldIndex < end) { order.push("world"); worldIndex += 1; }
  }
  let seen = 0;
  let sampleIndex = 0;
  for (const source of order) {
    if (source === "trial") { seen += 1; continue; }
    const sample = world[sampleIndex++];
    if (sample?.kind !== "input" || sample.data.action !== "finding") continue;
    if (sample.data.after_frames !== seen || seen > events.length
      || (events[seen - 1]?.at_ms ?? 0) > sample.t_ms || (events[seen]?.at_ms ?? Infinity) < sample.t_ms) return null;
  }
  return order;
}
export function publicationErrors(publishedAt: unknown, debrief: unknown, events: readonly RecordedEvent[]): readonly string[] {
  if (publishedAt === undefined) return [];
  if (!isWorldTime(publishedAt) || debrief === null || debrief === undefined) return ["published_at_ms: requires a bounded time and published debrief"];
  const readiness = events.filter((event) => event.frame.type === "debrief.ready");
  const terminal = events.filter((event) => event.frame.type === "trial.status" && event.frame.data.status !== "running");
  if (readiness.length === 0 || terminal.length === 0 || [...readiness, ...terminal].some((event) => event.at_ms > publishedAt)) return ["published_at_ms: precedes actual readiness or terminal arrival"];
  return [];
}
