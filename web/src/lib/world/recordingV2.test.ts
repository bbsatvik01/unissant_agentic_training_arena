import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { parseRecording } from "./parseRecording";
import { END_TAIL_MS, mergeRecordingEvents, RECORDING_FORMAT, RECORDING_FORMAT_V2, seek, startCursor, type Recording } from "./recording";
import { initialWorldReplayState, MAX_WORLD_TIME_MS, reduceWorldEvent, type WorldEvent } from "./worldEvents";

const pose = (t_ms: number, x: number): WorldEvent => ({ t_ms, kind: "pose", data: {
  actor_id: "trainee", position: [x, 0, 0], rotation: [0, 0, 0, 1], animation: { clip: "walk", time: t_ms / 1000 },
} });
const worldEvents: readonly WorldEvent[] = [
  pose(0, 0), pose(100, 1),
  { t_ms: 100, kind: "ui", data: { action: "panel", panel_id: "notebook", open: true } },
  { t_ms: 150, kind: "input", data: { action: "text", field_id: "question", value: "東京 pasted draft" } },
  { t_ms: 300, kind: "input", data: { action: "text", field_id: "question", value: "" } },
  { t_ms: 200, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "Check source." } },
  { t_ms: 400, kind: "input", data: { action: "notebook", operation: "delete", note_id: "n" } },
  { t_ms: 500, kind: "ui", data: { action: "panel", panel_id: "notebook", open: false } },
];
function load(extra: Readonly<Record<string, unknown>> = {}): Recording {
  const result = parseRecording({ ...structuredClone(raw), format: RECORDING_FORMAT_V2, world_events: worldEvents, ...extra });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.recording;
}
function broken(extra: Readonly<Record<string, unknown>>): boolean {
  return parseRecording({ ...structuredClone(raw), format: RECORDING_FORMAT_V2, world_events: worldEvents, ...extra }).ok;
}

describe("v1/v2 recording compatibility and validation", () => {
  it("keeps the legacy format and trial results, with empty world state", () => {
    const legacy = load({ format: RECORDING_FORMAT, world_events: undefined });
    expect(legacy.format).toBe("arena.recording.v1");
    expect(legacy.world_events).toEqual([]);
    expect(seek(legacy, startCursor(legacy), Infinity).world).toEqual(initialWorldReplayState());
    expect(seek(legacy, startCursor(legacy), Infinity).state).toEqual(seek(load(), startCursor(load()), Infinity).state);
  });
  it("can reparse a normalized v1 recording without inventing world data", () => {
    const legacy = load({ format: RECORDING_FORMAT, world_events: undefined });
    const reparsed = parseRecording(legacy);
    expect(reparsed).toEqual({ ok: true, recording: legacy });
  });
  it("requires an explicit v2 world list and never silently ignores v2 data in v1", () => {
    expect(broken({ world_events: undefined })).toBe(false);
    expect(broken({ world_events: null })).toBe(false);
    expect(broken({ world_events: {} })).toBe(false);
    expect(broken({ world_events: [pose(0, 0), { t_ms: 3, kind: "mood", data: {} }] })).toBe(false);
    expect(broken({ format: RECORDING_FORMAT })).toBe(false);
    expect(load({ world_events: [] }).world_events).toEqual([]);
  });
  it("rejects sparse frame/document arrays and undeclared frame-wrapper metadata", () => {
    expect(broken({ events: Array<unknown>(1), debrief: null })).toBe(false);
    expect(broken({ events: [{ ...raw.events[0], private_label: "not allowed" }], debrief: null })).toBe(false);
    expect(broken({ case: { ...raw.case, initial_documents: Array<unknown>(1) } })).toBe(false);
    for (const table of [{ columns: Array<unknown>(1), rows: [["cell"]] }, { columns: ["column"], rows: Array<unknown>(1) }, { columns: ["column"], rows: [Array<unknown>(1)] }]) {
      expect(broken({ case: { ...raw.case, initial_documents: [{ ...raw.case.initial_documents[0], content: { body: "visible", table } }] } })).toBe(false);
    }
  });
  it("supports a world-only recording with a valid snapshot but refuses a completely empty run", () => {
    const rec = load({ events: [], debrief: null });
    expect(rec.durationMs).toBe(500 + END_TAIL_MS);
    expect(seek(rec, startCursor(rec), 100).world.actors.get("trainee")?.position).toEqual([1, 0, 0]);
    expect(broken({ events: [], world_events: [], debrief: null })).toBe(false);
    expect(broken({ events: [], debrief: raw.debrief })).toBe(false);
    expect(broken({ events: "bad", debrief: null })).toBe(false);
  });
  it("computes duration from both streams rather than truncating late UI events", () => {
    const late = raw.events.at(-1)?.at_ms ?? 0;
    const rec = load({ world_events: [pose(late + 90_000, 3)] });
    expect(rec.durationMs).toBe(late + 90_000 + END_TAIL_MS);
    expect(seek(rec, startCursor(rec), rec.durationMs).world.actors.get("trainee")?.position).toEqual([3, 0, 0]);
    expect(load().durationMs).toBe(late + END_TAIL_MS);
  });
  it.each([NaN, Infinity, -Infinity, -1, MAX_WORLD_TIME_MS + 1])("refuses invalid world and frame clock %s", (t) => {
    expect(broken({ world_events: [pose(t, 0)] })).toBe(false);
    const event = raw.events[0];
    expect(broken({ events: [{ ...event, at_ms: t }], debrief: null })).toBe(false);
  });
  it("stable-sorts world events but retains the legacy trial-order integrity check", () => {
    const first = pose(100, 1);
    const second = pose(100, 2);
    expect(load({ world_events: [second, pose(0, 0), first] }).world_events).toEqual([pose(0, 0), second, first]);
    expect(broken({ events: [...raw.events].reverse() })).toBe(false);
  });
  it("copies validated inputs and drops unrecognized top-level metadata", () => {
    const source = { ...structuredClone(raw), format: RECORDING_FORMAT_V2, world_events: [pose(0, 0)], private_metadata: "not forwarded" };
    const parsed = parseRecording(source);
    if (!parsed.ok) throw new Error("valid file rejected");
    expect(Object.hasOwn(parsed.recording, "private_metadata")).toBe(false);
    expect(Object.hasOwn(parsed.recording, "note")).toBe(false);
    source.case.subject.display_name = "Changed after parsing";
    source.events.length = 0;
    source.world_events.length = 0;
    expect(parsed.recording.case.subject.display_name).toBe(raw.case.subject.display_name);
    expect(parsed.recording.events.length).toBe(raw.events.length);
    expect(parsed.recording.world_events.length).toBe(1);
  });
  it.each([
    { ...raw.case, difficulty_level: Infinity },
    { ...raw.case, subject: { ...raw.case.subject, private_label: "not allowed" } },
    { ...raw.case, initial_documents: [{ ...raw.case.initial_documents[0], private_label: "not allowed" }] },
    { ...raw.case, initial_documents: [{ ...raw.case.initial_documents[0], content: { body: "visible", private_label: "not allowed" } }] },
    { ...raw.case, initial_documents: [{ ...raw.case.initial_documents[0], content: { body: "visible", table: { columns: [], rows: [], private_label: "not allowed" } } }] },
  ])("refuses undeclared nested case metadata (%#)", (caseInfo) => { expect(broken({ case: caseInfo })).toBe(false); });
});

describe("deterministic merged timeline and seek", () => {
  it("orders trial-before-world at ties and preserves each stream's equal-time array order", () => {
    const first = raw.events[0];
    if (first === undefined) throw new Error("missing fixture event");
    const rec = load({ events: [{ ...first, at_ms: 100 }, { ...first, at_ms: 100 }], debrief: null,
      world_events: [pose(101, 3), pose(100, 1), pose(100, 2), pose(0, 0)] });
    expect(mergeRecordingEvents(rec).map((event) => [event.t_ms, event.source, event.index])).toEqual([
      [0, "world", 0], [100, "trial", 0], [100, "trial", 1], [100, "world", 1], [100, "world", 2], [101, "world", 3],
    ]);
    const cursor = seek(rec, startCursor(rec), 100);
    expect(cursor.next).toBe(2);
    expect(cursor.nextWorld).toBe(3);
    expect(cursor.world.actors.get("trainee")?.position[0]).toBe(2);
    expect(mergeRecordingEvents(load({ world_events: [] })).every((event) => event.source === "trial")).toBe(true);
    expect(mergeRecordingEvents(load({ events: [], debrief: null })).every((event) => event.source === "world")).toBe(true);
  });
  it("has no world values before the first capture and holds only captured samples", () => {
    const rec = load({ world_events: [pose(100, 1), pose(200, 2)] });
    const before = seek(rec, startCursor(rec), 99);
    expect(before.world.actors.size).toBe(0);
    const middle = seek(rec, before, 150);
    expect(middle.world.actors.get("trainee")?.position[0]).toBe(1);
    expect(middle.world.actors.get("trainee")?.animation.time).toBe(0.1);
  });
  it("matches jump, repeated seek, forward ticks and backward scrubs including notebook edits/deletions", () => {
    const rec = load();
    let stepped = startCursor(rec);
    for (const t of [0, 99, 100, 199, 200, 399, 400, 499, 500, rec.durationMs]) {
      stepped = seek(rec, stepped, t);
      const jumped = seek(rec, startCursor(rec), t);
      const back = seek(rec, seek(rec, startCursor(rec), rec.durationMs), t);
      expect(stepped).toEqual(jumped);
      expect(back).toEqual(jumped);
      expect(seek(rec, jumped, t)).toEqual(jumped);
    }
    const beforeDeletion = seek(rec, stepped, 399);
    expect(seek(rec, stepped, 299).world.textDrafts.get("question")).toBe("東京 pasted draft");
    expect(beforeDeletion.world.textDrafts.get("question")).toBe("");
    expect(beforeDeletion.world.notes.get("n")?.text).toBe("Check source.");
    expect(beforeDeletion.world.openPanels.has("notebook")).toBe(true);
    expect(seek(rec, beforeDeletion, 500).world.notes.size).toBe(0);
    expect(startCursor(rec).world).toEqual(initialWorldReplayState());
  });
  it("matches an independent linear fold over a dense mixed timeline", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => pose(Math.floor(i / 3) * 100, i / 10));
    const rec = load({ world_events: [...samples].reverse() });
    const timeline = mergeRecordingEvents(rec);
    for (const t of [0, 100, 2050, 9900, 33_200, rec.durationMs]) {
      let trial = trialReducer(initialTrialState(), { type: "snapshot", snapshot: rec.snapshot });
      let world = initialWorldReplayState();
      for (const entry of timeline) {
        if (entry.t_ms > t) break;
        if (entry.source === "trial") trial = trialReducer(trial, { type: "frame", frame: entry.frame });
        else world = reduceWorldEvent(world, entry.event);
      }
      const cursor = seek(rec, startCursor(rec), t);
      expect(cursor.state).toEqual(trial);
      expect(cursor.world).toEqual(world);
    }
  });
  it("waits for late world captures before the final snapshot and removes it on backward seek", () => {
    const last = raw.events.at(-1)?.at_ms ?? 0;
    const final = { ...structuredClone(raw.snapshot), status: "completed", last_seq: 10000 };
    const rec = load({ final_snapshot: final, world_events: [pose(last + 100, 2)] });
    const before = seek(rec, startCursor(rec), last);
    expect(before.state.snapshot?.last_seq).not.toBe(10000);
    const end = seek(rec, before, rec.durationMs);
    expect(end.state.snapshot?.last_seq).toBe(10000);
    expect(seek(rec, end, last)).toEqual(before);
  });
  it("clamps infinities, leaves NaN at the current time, and retains state at repeated end seeks", () => {
    const rec = load();
    const middle = seek(rec, startCursor(rec), 150);
    expect(seek(rec, middle, NaN)).toEqual(middle);
    expect(seek(rec, middle, -Infinity).t).toBe(0);
    const end = seek(rec, middle, Infinity);
    expect(end.t).toBe(rec.durationMs);
    expect(seek(rec, end, Infinity)).toEqual(end);
  });
});
