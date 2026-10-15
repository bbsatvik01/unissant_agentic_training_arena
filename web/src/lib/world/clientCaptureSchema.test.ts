import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { fixture } from "../../test/wire-fixtures";
import { LogBuilder, SESSION_ID, TRIAL_ID, snapshot } from "../../test/trial-log";
import { clientEventOrder, isClientCaptureMetadata, publicationErrors } from "./clientCaptureSchema";
import { parseRecording } from "./parseRecording";
import { END_TAIL_MS, mergeRecordingEvents, seek, startCursor } from "./recording";
import { MAX_WORLD_TIME_MS, type WorldEvent } from "./worldEvents";

const metadata = { version: 1, origin: "client-experienced", scope: "accepted-text-and-world-samples", capture_id: "client-id", session_id: SESSION_ID, original_audio: "absent", status: "complete", reason: null } as const;
const frames = new LogBuilder().ask({ coach: "failed" }).commit().debriefReady().frames;
const recording = () => ({ format: "arena.recording.v2", trial_id: TRIAL_ID, case: raw.case, snapshot: snapshot(), events: frames.map((frame, index) => ({ at_ms: 10 + index, frame })), world_events: [], debrief: fixture("debrief:scored"), final_snapshot: null, client_capture: metadata, published_at_ms: 100 });

describe("strict UI-local capture schema", () => {
  it("permits only bounded declared client provenance", () => {
    expect(isClientCaptureMetadata(metadata)).toBe(true);
    for (const value of [null, [], {}, { ...metadata, version: 2 }, { ...metadata, token: "secret" }, { ...metadata, capture_id: "" }, { ...metadata, session_id: "x".repeat(161) }, { ...metadata, original_audio: "invented" }, { ...metadata, status: "incomplete" }, { ...metadata, status: "complete", reason: "resync" }, { ...metadata, status: "incomplete", reason: "unknown" }]) expect(isClientCaptureMetadata(value)).toBe(false);
    expect(isClientCaptureMetadata({ ...metadata, status: "incomplete", reason: "resync" })).toBe(true);
  });
  it("round-trips a fresh publication and includes document arrival in duration", () => {
    const checked = parseRecording(recording());
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    expect(checked.recording.durationMs).toBe(100 + END_TAIL_MS);
    expect(checked.recording.published_at_ms).toBe(100);
    expect(parseRecording(checked.recording)).toEqual(checked);
  });
  it.each([null, -1, NaN, Infinity, MAX_WORLD_TIME_MS + 1, "100", 0])("refuses invalid or early publication %s", (published_at_ms) => {
    expect(parseRecording({ ...recording(), published_at_ms }).ok).toBe(false);
  });
  it("requires own actual readiness, terminal arrival and document for timed publication", () => {
    const base = recording();
    expect(parseRecording({ ...base, debrief: null }).ok).toBe(false);
    expect(parseRecording({ ...base, events: base.events.filter((entry) => entry.frame.type !== "debrief.ready") }).ok).toBe(false);
    expect(parseRecording({ ...base, events: base.events.filter((entry) => entry.frame.type !== "trial.status") }).ok).toBe(false);
    expect(parseRecording({ ...base, client_capture: { ...metadata, session_id: "other" } }).ok).toBe(false);
    expect(parseRecording({ ...base, published_at_ms: undefined }).ok).toBe(false);
    expect(parseRecording({ ...base, final_snapshot: snapshot({ status: "completed" }) }).ok).toBe(false);
    expect(publicationErrors(undefined, null, [])).toEqual([]);
  });
  it("preserves old v1 and v2 duration, reducer and frame-first ties", () => {
    const legacy = parseRecording(raw);
    const modern = parseRecording({ ...raw, format: "arena.recording.v2", world_events: [] });
    if (!legacy.ok || !modern.ok) throw new Error("legacy fixture refused");
    expect(legacy.recording.published_at_ms).toBeUndefined();
    expect(legacy.recording.durationMs).toBe(modern.recording.durationMs);
    expect(seek(legacy.recording, startCursor(legacy.recording), Infinity).state).toEqual(seek(modern.recording, startCursor(modern.recording), Infinity).state);
    expect(parseRecording({ ...raw, published_at_ms: 100 }).ok).toBe(false);
    expect(parseRecording({ ...raw, client_capture: metadata }).ok).toBe(false);
  });
  it("refuses local finding actions without their versioned capture schema", () => {
    expect(parseRecording({ ...raw, format: "arena.recording.v2", world_events: [{ t_ms: 0, kind: "input", data: { action: "finding", operation: "submitted", after_frames: 0 } }] }).ok).toBe(false);
  });
  it("validates frame anchors and preserves world order around equal-time findings", () => {
    const events = recording().events.map((event) => ({ ...event, at_ms: 100 }));
    const marker = (after_frames: number): WorldEvent => ({ t_ms: 100, kind: "input", data: { action: "finding", operation: "submitted", after_frames } });
    const ui: WorldEvent = { t_ms: 100, kind: "ui", data: { action: "panel", panel_id: "interview", open: true } };
    expect(clientEventOrder(events, [ui, marker(0), marker(2)])?.slice(0, 5)).toEqual(["world", "world", "trial", "trial", "world"]);
    expect(clientEventOrder(events, [marker(events.length + 1)])).toBeNull();
    expect(clientEventOrder(events, [marker(2), marker(1)])).toBeNull();
    expect(clientEventOrder(events, [{ ...marker(1), t_ms: 99 }])).toBeNull();
    expect(clientEventOrder(events, [{ ...marker(0), t_ms: 101 }])).toBeNull();
    const checked = parseRecording({ ...recording(), events, published_at_ms: 110, world_events: [ui, marker(0), marker(2)] });
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    expect(mergeRecordingEvents(checked.recording).map((event) => event.source)).toEqual(checked.recording.client_order);
    expect(parseRecording({ ...recording(), world_events: [marker(20_001)] }).ok).toBe(false);
    expect(parseRecording({ ...recording(), world_events: [marker(-1)] }).ok).toBe(false);
  });
});
