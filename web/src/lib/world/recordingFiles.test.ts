import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { MAX_RECORDING_FILE_BYTES, readRecordingFile, recordingJson } from "./recordingFiles";
import { MAX_WORLD_EVENTS, MAX_WORLD_EVENTS_BYTES, parseWorldEvents, type WorldEvent } from "./worldEvents";
const sample: WorldEvent = { t_ms: 0, kind: "ui", data: { action: "panel", panel_id: "file", open: true } };

describe("bounded recording files", () => {
  it.each(["arena.recording.v1", "arena.recording.v2"])("imports and serializes %s preserving legacy shape", async (format) => {
    const text = JSON.stringify({ ...raw, format, ...(format.endsWith("v2") ? { world_events: [sample] } : {}) });
    const result = await readRecordingFile({ size: text.length, text: () => Promise.resolve(text) });
    if (!result.ok) throw new Error(result.errors.join(";"));
    const serialized = recordingJson(result.recording); const decoded: unknown = JSON.parse(serialized);
    expect(parseRecording(decoded)).toEqual(result);
    expect(serialized).not.toContain("durationMs");
    expect(serialized.includes('"world_events"')).toBe(format.endsWith("v2"));
  });
  it.each([-1, NaN, 1.5, MAX_RECORDING_FILE_BYTES + 1])("refuses bad file size before any read (%s)", async (size) => {
    const text = vi.fn(() => Promise.resolve("{}")); expect((await readRecordingFile({ size, text })).ok).toBe(false); expect(text).not.toHaveBeenCalled();
  });
  it("checks actual decoded size when metadata lies, including non-ASCII bytes", async () => {
    for (const text of ["x".repeat(MAX_RECORDING_FILE_BYTES + 1), "界".repeat(Math.floor(MAX_RECORDING_FILE_BYTES / 3) + 1)]) {
      expect(await readRecordingFile({ size: 1, text: () => Promise.resolve(text) })).toEqual({ ok: false, errors: ["recording: file exceeds the 32 MB import limit"] });
    }
  });
  it("refuses a failed read, malformed JSON, bad schemas and injected private case facts whole", async () => {
    expect((await readRecordingFile({ size: 1, text: () => Promise.reject(new Error("sensitive path")) })).ok).toBe(false);
    for (const text of ["{broken", "null", JSON.stringify({ ...raw, case: { ...raw.case, role: "private" } }), JSON.stringify({ ...raw, format: "arena.recording.v2", world_events: [{ ...sample, data: { mood: "untrustworthy" } }] })]) {
      const result = await readRecordingFile({ size: text.length, text: () => Promise.resolve(text) }); expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("untrustworthy"); expect(JSON.stringify(result)).not.toContain("sensitive path");
    }
  });
  it("refuses serialization of a malformed normalized recording", () => {
    const result = parseRecording(raw); if (!result.ok) throw new Error("fixture");
    expect(() => recordingJson({ ...result.recording, trial_id: "" })).toThrow(TypeError);
    expect(() => recordingJson({ ...result.recording, case: { ...result.recording.case, title: "x".repeat(MAX_RECORDING_FILE_BYTES) } })).toThrow(RangeError);
  });
  it("bounds sample count before iteration and bytes before retaining the full list", () => {
    expect(parseWorldEvents(Array<unknown>(MAX_WORLD_EVENTS + 1))).toEqual({ ok: false, errors: ["world_events: too many samples"] });
    const note: WorldEvent = { t_ms: 0, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "x".repeat(16_000) } };
    const count = Math.ceil(MAX_WORLD_EVENTS_BYTES / 16_000);
    expect(parseWorldEvents(Array.from({ length: count }, () => note))).toEqual({ ok: false, errors: ["world_events: sample data exceeds the memory limit"] });
  });
});
