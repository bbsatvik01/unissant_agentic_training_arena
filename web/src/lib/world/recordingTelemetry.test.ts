import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { recordingJson } from "./recordingFiles";
import { END_TAIL_MS, RECORDING_FORMAT, RECORDING_FORMAT_V1, RECORDING_FORMAT_V2, RECORDING_FORMATS, seek, startCursor } from "./recording";
import { boundedJson, MAX_ANNOTATIONS, MAX_GENERIC_JSON_DEPTH, MAX_GENERIC_JSON_NODES, parseAnnotations, parseRecordingTelemetry, UI_WORLD_PROFILE, WORLD_TRANSPORT_MAX_TIME_MS } from "./recordingTelemetry";
import { initialWorldReplayState, MAX_WORLD_EVENTS } from "./worldEvents";
const ui = { t_ms: 12.5, kind: "ui", data: { action: "panel", panel_id: "notebook", open: true } } as const;
const opaque = [{ t_ms: 0, kind: "camera", data: { mode: "orbit" } }, { t_ms: 10_000_000, kind: "pose", data: { actor: "subject" } }];
const file = (world_events: unknown, extra: Readonly<Record<string, unknown>> = {}) => ({ ...structuredClone(raw), format: RECORDING_FORMAT_V2, world_events, ...extra });
function load(value: unknown) { const checked = parseRecording(value); if (!checked.ok) throw new Error(checked.errors.join(";")); return checked.recording; }

describe("upstream v2 transport and strict local profile reconciliation", () => {
  it("keeps explicit format aliases and trusted normalized v1 reparsing without accepting raw v1 telemetry", () => {
    expect(RECORDING_FORMAT).toBe(RECORDING_FORMAT_V1); expect(RECORDING_FORMATS).toEqual([RECORDING_FORMAT_V1, RECORDING_FORMAT_V2]);
    const legacy = load(raw); expect(parseRecording(legacy)).toEqual({ ok: true, recording: legacy });
    expect(parseRecording({ ...raw, world_events: [] }).ok).toBe(false); expect(parseRecording({ ...raw, annotations: [] }).ok).toBe(false);
    expect(recordingJson(legacy)).not.toContain('"world_events"'); expect(recordingJson(legacy)).not.toContain('"annotations"');
  });
  it("preserves upstream generic data exactly through export but never applies it as a pose, camera or judgment", () => {
    const samples = [...opaque, { t_ms: 10_000_001, kind: "ui", data: { mood: "untrustworthy", score: 99, nested: [null, true, { value: "kept" }] } }];
    const rec = load(file(samples)); expect(rec.world_events).toEqual(samples); expect(rec.unsupportedWorldEvents).toBe(3);
    expect(rec.world_profile).toBeUndefined(); expect(seek(rec, startCursor(rec), rec.durationMs).world).toEqual(initialWorldReplayState());
    const roundTrip = load(JSON.parse(recordingJson(rec))); expect(roundTrip.world_events).toEqual(samples);
    expect(roundTrip.unsupportedWorldEvents).toBe(3); expect(roundTrip.scene_context).toBeUndefined();
    expect(recordingJson(rec)).not.toContain("unsupportedWorldEvents");
  });
  it("adapts only validated samples in a mixed stream and rewinds without applying opaque input", () => {
    const samples = [opaque[0], { ...ui, t_ms: 10 }, { t_ms: 20, kind: "input", data: { behavior: "send-a-question" } }];
    const rec = load(file(samples)); const end = seek(rec, startCursor(rec), 20);
    expect(rec.unsupportedWorldEvents).toBe(2); expect(end.world.openPanels.has("notebook")).toBe(true);
    expect(end.world.textDrafts.size).toBe(0); expect(seek(rec, end, 0).world.openPanels.size).toBe(0);
  });
  it("retains old fully typed fractional-clock and stable-sort captures, and writes a strict explicit profile", () => {
    const rec = load(file([{ ...ui, t_ms: 20.5 }, ui], { events: [], debrief: null }));
    expect(rec.world_events.map((sample) => sample.t_ms)).toEqual([12.5, 20.5]); expect(rec.world_profile).toBe(UI_WORLD_PROFILE);
    expect(rec.events).toEqual([]); expect(load(JSON.parse(recordingJson(rec)))).toEqual(rec);
  });
  it("refuses unknown profiles and malformed declared local samples rather than laundering them as opaque", () => {
    expect(parseRecording(file(opaque, { world_profile: UI_WORLD_PROFILE })).ok).toBe(false);
    expect(parseRecording(file([], { world_profile: "unknown" })).ok).toBe(false);
    for (const data of [{ action: "panel", panel_id: "file", open: true, private_fact: "never applied" }, { action: "notebook", text: "missing operation" }]) {
      expect(parseRecording(file([{ t_ms: 0, kind: data.action === "panel" ? "ui" : "input", data }])).ok).toBe(false);
    }
    expect(parseRecording(file([{ t_ms: 0, kind: "ui", data: { mood: "untrustworthy" } }], { world_profile: UI_WORLD_PROFILE })).ok).toBe(false);
  });
  it.each([-1, 0.5, Infinity, WORLD_TRANSPORT_MAX_TIME_MS + 1])("refuses generic wire timestamp %s", (t_ms) => {
    expect(parseRecording(file([{ ...opaque[0], t_ms }])).ok).toBe(false);
  });
  it("accepts exact wire day boundary, rejects descending generic time and retains equal-time order", () => {
    const samples = [{ ...opaque[0], t_ms: WORLD_TRANSPORT_MAX_TIME_MS }, { ...opaque[1], t_ms: WORLD_TRANSPORT_MAX_TIME_MS }];
    expect(load(file(samples)).world_events).toEqual(samples);
    expect(parseRecording(file([...opaque].reverse())).ok).toBe(false);
  });
  it("does not coerce opaque discriminator values or execute their conversion hooks", () => {
    const object = { toString: "not callable", valueOf: "not callable" };
    expect(parseRecording(file([{ t_ms: 0, kind: object, data: {} }])).ok).toBe(false);
    const samples = [{ t_ms: 0, kind: "camera", data: { mode: object } }, { t_ms: 1, kind: "input", data: { action: object } }];
    const rec = load(file(samples)); expect(rec.unsupportedWorldEvents).toBe(2); expect(rec.world_events).toEqual(samples);
  });
  it("rejects sparse, oversized, recursive and prototype-bearing generic data without invoking accessors", () => {
    expect(parseRecordingTelemetry(Array<unknown>(MAX_WORLD_EVENTS + 1), false).ok).toBe(false);
    expect(parseRecordingTelemetry(Array<unknown>(1), false).ok).toBe(false);
    expect(parseRecordingTelemetry([{ t_ms: 0, kind: "ui", data: { value: "x".repeat(65_536) } }], false).ok).toBe(false);
    const getter = vi.fn(() => "secret"); const data = {}; Object.defineProperty(data, "value", { enumerable: true, get: getter });
    expect(parseRecordingTelemetry([{ t_ms: 0, kind: "ui", data }], false).ok).toBe(false); expect(getter).not.toHaveBeenCalled();
    const recursive: { loop?: unknown } = {}; recursive.loop = recursive;
    for (const value of [recursive, new Date(), { n: NaN }, { n: undefined }, { n: () => 1 }, Object.create({ inherited: true }) as unknown,
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown, { constructor: {} }, { prototype: {} }, Array<unknown>(3)]) expect(boundedJson(value)).toBe(false);
    let nested: unknown = null; for (let i = 0; i <= MAX_GENERIC_JSON_DEPTH; i += 1) nested = { child: nested };
    expect(boundedJson(nested)).toBe(false); expect(boundedJson(Array<unknown>(MAX_GENERIC_JSON_NODES + 1).fill(0))).toBe(false);
    expect(boundedJson({ finite: [null, true, "value", 123] })).toBe(true);
  });
});

describe("bounded recorded instructor annotations", () => {
  const note = { t_ms: 15_000_000, text: "Actual recorded instructor suggestion", created_at: "2026-10-15T10:00:00Z" };
  it("preserves notes and extends duration through the last note without changing trial publication timing", () => {
    const rec = load(file([], { annotations: [note] })); expect(rec.annotations).toEqual([note]); expect(rec.durationMs).toBe(note.t_ms + END_TAIL_MS);
    expect(load(JSON.parse(recordingJson(rec))).annotations).toEqual([note]);
    expect(rec.published_at_ms).toBeUndefined(); expect(rec.client_capture).toBeUndefined();
  });
  it.each([null, {}, Array<unknown>(1), Array<unknown>(MAX_ANNOTATIONS + 1), [{ ...note, text: "" }], [{ ...note, text: "x".repeat(2001) }], [{ ...note, created_at: "invalid" }], [{ ...note, created_at: "x".repeat(65) }], [{ ...note, t_ms: 0.5 }], [{ ...note, private_fact: "x" }], [note, { ...note, t_ms: 1 }]])("refuses malformed or unbounded notes %#", (value) => {
    expect(parseAnnotations(value).ok).toBe(false);
  });
  it("counts Unicode characters honestly and enforces total bytes", () => {
    expect(parseAnnotations([{ ...note, text: "😀".repeat(2000) }]).ok).toBe(true);
    expect(parseAnnotations(Array.from({ length: 600 }, () => ({ ...note, text: "😀".repeat(2000) }))).ok).toBe(false);
  });
});
