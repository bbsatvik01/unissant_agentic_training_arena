import { describe, expect, it } from "vitest";
import {
  initialWorldReplayState, isWorldEvent, isWorldTime, MAX_NOTE_CHARACTERS, MAX_INPUT_TEXT_CHARACTERS, MAX_WORLD_BATCH_BYTES,
  MAX_WORLD_COORDINATE, MAX_WORLD_TIME_MS, parseWorldEvents, reduceWorldEvent, splitWorldEventBatches,
  worldEventBatchBytes, worldEventBatchDue, WORLD_EVENT_BATCH_INTERVAL_MS, type WorldEvent,
} from "./worldEvents";

const pose: WorldEvent = { t_ms: 10, kind: "pose", data: { actor_id: "trainee", position: [1, 0, 2], rotation: [0, 0, 0, 1], animation: { clip: "walk", time: 0.5 } } };
const camera: WorldEvent = { t_ms: 20, kind: "camera", data: { mode: "first", position: [1, 1.65, 2], quaternion: [0, 0, 0, 1], fov: 65 } };
const key: WorldEvent = { t_ms: 25, kind: "input", data: { action: "key", key: "KeyW", pressed: true } };
const click: WorldEvent = { t_ms: 30, kind: "input", data: { action: "click", target: "dossier", button: 0 } };
const text: WorldEvent = { t_ms: 32, kind: "input", data: { action: "text", field_id: "question-draft", value: "When was this submitted?" } };
const note: WorldEvent = { t_ms: 35, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n1", text: "Check the timestamp." } };
const removeNote: WorldEvent = { t_ms: 40, kind: "input", data: { action: "notebook", operation: "delete", note_id: "n1" } };
const panel: WorldEvent = { t_ms: 45, kind: "ui", data: { action: "panel", panel_id: "dossier", open: true } };
const page: WorldEvent = { t_ms: 50, kind: "ui", data: { action: "file_page", file_id: "doc1", page: 2 } };
const evidence = (operation: "inspect" | "request" | "pin" | "unpin", recordId = "r1"): WorldEvent => ({
  t_ms: 55, kind: "input", data: { action: "evidence", operation, record_id: recordId },
});
const valid: readonly WorldEvent[] = [pose, camera, key, click, text, note, removeNote, panel, page,
  evidence("inspect"), evidence("request"), evidence("pin"), evidence("unpin")];

function editData(event: WorldEvent, change: Readonly<Record<string, unknown>>): unknown {
  return { ...structuredClone(event), data: { ...structuredClone(event.data), ...change } };
}

describe("public world event validation", () => {
  it.each(valid)("accepts the declared $kind payload", (event) => { expect(isWorldEvent(event)).toBe(true); });
  it.each(["first", "third", "free"])("accepts %s camera mode", (mode) => { expect(isWorldEvent(editData(camera, { mode }))).toBe(true); });
  it("accepts fractional monotonic times and a normalized non-identity quaternion without changing either", () => {
    const value = { ...pose, t_ms: 0.125, data: { ...pose.data, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } };
    const parsed = parseWorldEvents([value]);
    expect(parsed).toEqual({ ok: true, events: [value] });
  });
  it.each([undefined, null, false, "pose", 1, [], {}, { ...pose, t_ms: -1 }, { ...pose, t_ms: NaN },
    { ...pose, t_ms: Infinity }, { ...pose, t_ms: MAX_WORLD_TIME_MS + 1 }, { ...pose, kind: "mood" },
    { ...pose, data: [] }, { ...pose, data: null }, { ...pose, extra: "private" }, { ...pose, data: { ...pose.data, role: "private" } },
    editData(pose, { actor_id: "" }), editData(pose, { actor_id: " " }), editData(pose, { actor_id: "x".repeat(161) }),
    editData(pose, { position: [0, 1] }), editData(pose, { position: [0, 1, Infinity] }), editData(pose, { position: [0, 1, "2"] }),
    editData(pose, { position: [0, 0, MAX_WORLD_COORDINATE + 1] }), editData(pose, { position: Array<number>(3) }),
    editData(pose, { rotation: [0, 0, 0, 0] }), editData(pose, { rotation: [0, 0, 0, 2] }), editData(pose, { rotation: [0, 0, 0, Infinity] }),
    editData(pose, { animation: null }), editData(pose, { animation: { clip: "", time: 0 } }), editData(pose, { animation: { clip: "walk", time: -1 } }),
    editData(pose, { animation: { clip: "walk", time: Infinity } }), editData(pose, { animation: { clip: "walk", time: MAX_WORLD_TIME_MS } }),
    editData(pose, { animation: { clip: "walk", time: 0, label: "private" } }), editData(camera, { mode: "unknown" }),
    editData(camera, { mode: ["first"] }), editData(camera, { fov: 0 }), editData(camera, { fov: 180 }), editData(camera, { fov: NaN }),
    editData(camera, { quaternion: [0, 0, 1] }), editData(camera, { position: [0, NaN, 0] }),
    editData(key, { pressed: 1 }), editData(key, { key: "" }), editData(key, { action: "typed-text" }),
    editData(click, { button: -1 }), editData(click, { button: 5 }), editData(click, { button: 0.5 }), editData(click, { target: "" }),
    editData(text, { value: null }), editData(text, { field_id: "" }), editData(text, { value: "x".repeat(MAX_INPUT_TEXT_CHARACTERS + 1) }), editData(text, { secret: "not accepted" }),
    editData(note, { text: null }), editData(note, { text: "x".repeat(MAX_NOTE_CHARACTERS + 1) }), editData(note, { note_id: "" }),
    editData(note, { operation: "append" }), editData(removeNote, { text: "private" }),
    editData(evidence("pin"), { operation: "score" }), editData(evidence("pin"), { operation: ["pin"] }), editData(evidence("pin"), { record_id: "" }),
    editData(panel, { open: 1 }), editData(panel, { panel_id: "" }), editData(panel, { action: "unknown" }),
    editData(page, { page: 0 }), editData(page, { page: 1.2 }), editData(page, { page: Number.MAX_SAFE_INTEGER + 1 }), editData(page, { file_id: "" }),
  ])("rejects malformed, unbounded and extra fields (%#)", (value) => { expect(isWorldEvent(value)).toBe(false); });

  it("accepts legitimate boundary values", () => {
    expect(isWorldTime(MAX_WORLD_TIME_MS)).toBe(true);
    expect(isWorldTime(0)).toBe(true);
    expect(isWorldEvent(editData(pose, { position: [-MAX_WORLD_COORDINATE, 0, MAX_WORLD_COORDINATE] }))).toBe(true);
    expect(isWorldEvent(editData(note, { text: "" }))).toBe(true);
    expect(isWorldEvent(editData(click, { button: 4 }))).toBe(true);
  });
  it("requires a list and rejects sparse/corrupt lists whole without including sensitive payloads in errors", () => {
    expect(parseWorldEvents(null)).toEqual({ ok: false, errors: ["world_events: must be a list"] });
    expect(parseWorldEvents([])).toEqual({ ok: true, events: [] });
    expect(parseWorldEvents(Array<unknown>(1))).toEqual({ ok: false, errors: ["world_events[0]: invalid public UI event"] });
    expect(parseWorldEvents([pose, { ...note, secret: "do not echo" }, null])).toEqual({ ok: false, errors: [
      "world_events[1]: invalid public UI event", "world_events[2]: invalid public UI event",
    ] });
  });
  it("stable-sorts without mutating or retaining mutable references to the source", () => {
    const a = { ...key, t_ms: 50 };
    const b = { ...click, t_ms: 50 };
    const source = [b, pose, a];
    const parsed = parseWorldEvents(source);
    if (!parsed.ok) throw new Error("valid list rejected");
    expect(parsed.events).toEqual([pose, b, a]);
    expect(source).toEqual([b, pose, a]);
    expect(parsed.events[0]).not.toBe(pose);
    expect(parsed.events[0]?.data).not.toBe(pose.data);
  });
  it("refuses a valid-shape event that exceeds the wire body cap after JSON escaping", () => {
    const oversized = editData(note, { text: "\u0000".repeat(MAX_NOTE_CHARACTERS) });
    expect(isWorldEvent(oversized)).toBe(true);
    expect(parseWorldEvents([oversized]).ok).toBe(false);
  });
});

describe("recorded UI state", () => {
  it("folds all input kinds with immutable collections and no side effects", () => {
    const start = initialWorldReplayState();
    let state = [pose, camera, key, click, note, panel, page, evidence("inspect"), evidence("request"), evidence("pin")]
      .reduce(reduceWorldEvent, start);
    expect(start).toEqual(initialWorldReplayState());
    expect(state.actors.get("trainee")).toEqual(pose.data);
    expect(state.actors.get("trainee")).not.toBe(pose.data);
    expect(state.camera).toEqual(camera.data);
    expect(state.camera).not.toBe(camera.data);
    expect([...state.pressedKeys]).toEqual(["KeyW"]);
    expect(state.notes.get("n1")).toEqual({ id: "n1", text: "Check the timestamp.", updatedAtMs: 35 });
    expect([...state.openPanels]).toEqual(["dossier"]);
    expect(state.filePages.get("doc1")).toBe(2);
    expect(state.inspectedEvidence).toBe("r1");
    expect([...state.requestedEvidence]).toEqual(["r1"]);
    expect([...state.pinnedEvidence]).toEqual(["r1"]);
    const before = state;
    state = reduceWorldEvent(state, { t_ms: 70, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n1", text: "Updated note." } });
    expect(before.notes.get("n1")?.text).toBe("Check the timestamp.");
    expect(state.notes.size).toBe(1);
    expect(state.notes.get("n1")?.text).toBe("Updated note.");
    state = reduceWorldEvent(state, removeNote);
    state = reduceWorldEvent(state, evidence("unpin"));
    state = reduceWorldEvent(state, { t_ms: 80, kind: "input", data: { action: "key", key: "KeyW", pressed: false } });
    state = reduceWorldEvent(state, { t_ms: 90, kind: "ui", data: { action: "panel", panel_id: "dossier", open: false } });
    expect(state.notes.size + state.pinnedEvidence.size + state.pressedKeys.size + state.openPanels.size).toBe(0);
    expect(state.lastInput).toEqual({ action: "key", key: "KeyW", pressed: false });
  });
  it("restores bounded draft values, paste/IME and clearing without generating keystrokes or submitting", () => {
    const first = reduceWorldEvent(initialWorldReplayState(), text);
    const composed: WorldEvent = { t_ms: 100, kind: "input", data: { action: "text", field_id: "question-draft", value: "東京 🕵️\nPasted text" } };
    const second = reduceWorldEvent(first, composed);
    expect(first.textDrafts.get("question-draft")).toBe("When was this submitted?");
    expect(second.textDrafts.get("question-draft")).toBe("東京 🕵️\nPasted text");
    expect(second.pressedKeys.size).toBe(0);
    expect(second.requestedEvidence.size).toBe(0);
    const clear = reduceWorldEvent(second, { t_ms: 101, kind: "input", data: { action: "text", field_id: "question-draft", value: "" } });
    expect(clear.textDrafts.get("question-draft")).toBe("");
    expect(clear.lastInput).toEqual({ action: "text", field_id: "question-draft", value: "" });
  });
  it("treats prototype-like IDs as ordinary map/set keys and never mutates object prototypes", () => {
    let state = initialWorldReplayState();
    for (const id of ["__proto__", "constructor", "prototype", "toString"]) {
      state = reduceWorldEvent(state, { t_ms: 0, kind: "pose", data: { ...pose.data, actor_id: id } });
      state = reduceWorldEvent(state, { t_ms: 0, kind: "input", data: { action: "notebook", operation: "upsert", note_id: id, text: "note" } });
      state = reduceWorldEvent(state, evidence("pin", id));
      state = reduceWorldEvent(state, { t_ms: 0, kind: "ui", data: { action: "file_page", file_id: id, page: 1 } });
      state = reduceWorldEvent(state, { t_ms: 0, kind: "input", data: { action: "text", field_id: id, value: "draft" } });
      expect(state.textDrafts.get(id)).toBe("draft");
      expect(state.actors.get(id)?.actor_id).toBe(id);
      expect(state.notes.get(id)?.text).toBe("note");
      expect(state.pinnedEvidence.has(id)).toBe(true);
      expect(state.filePages.get(id)).toBe(1);
    }
    expect(Object.hasOwn(Object.prototype, "actor_id")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "text")).toBe(false);
  });
  it("keeps separate actors and latest captures without interpolation or invented clip progress", () => {
    let state = reduceWorldEvent(initialWorldReplayState(), pose);
    state = reduceWorldEvent(state, { ...pose, t_ms: 15, data: { ...pose.data, actor_id: "coach", animation: { clip: "idle", time: 3 } } });
    expect(state.actors.size).toBe(2);
    expect(state.actors.get("trainee")?.animation.time).toBe(0.5);
    const repeated = reduceWorldEvent(state, pose);
    expect(repeated).toEqual(state);
  });
});

describe("world event batching", () => {
  it("measures exact transmitted UTF-8 JSON, including escape sequences and the envelope", () => {
    const event: WorldEvent = { t_ms: 0, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: '東京 🕵️\n"\\\u0000' } };
    const batch = { events: [event] };
    expect(worldEventBatchBytes(batch)).toBe(new Blob([JSON.stringify(batch)]).size);
    expect(worldEventBatchBytes(batch)).toBeGreaterThan(JSON.stringify(batch).length);
    expect(worldEventBatchBytes({ events: [] })).toBe(13);
  });
  it("packs through the exact boundary and splits at one byte below it without dropping/reordering", () => {
    const combined = worldEventBatchBytes({ events: [pose, camera] });
    expect(splitWorldEventBatches([pose, camera], combined)).toEqual([{ events: [pose, camera] }]);
    expect(splitWorldEventBatches([pose, camera], combined - 1)).toEqual([{ events: [pose] }, { events: [camera] }]);
    expect(splitWorldEventBatches([], 13)).toEqual([]);
    const single = worldEventBatchBytes({ events: [pose] });
    expect(splitWorldEventBatches([pose], single)).toEqual([{ events: [pose] }]);
    expect(() => splitWorldEventBatches([pose], single - 1)).toThrow(RangeError);
  });
  it("keeps every large multilingual event in sub-64KB requests and owns copies", () => {
    const events: WorldEvent[] = Array.from({ length: 170 }, (_, i) => ({
      t_ms: i * 3.5, kind: "input", data: { action: "notebook", operation: "upsert", note_id: String(i), text: "東京 🕵️ \n".repeat(100) },
    }));
    const batches = splitWorldEventBatches(events);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => worldEventBatchBytes(batch) <= MAX_WORLD_BATCH_BYTES)).toBe(true);
    expect(batches.flatMap((batch) => batch.events)).toEqual(events);
    expect(batches[0]?.events[0]).not.toBe(events[0]);
  });
  it.each([12, 0, -1, NaN, Infinity, 13.5, MAX_WORLD_BATCH_BYTES + 1])("rejects invalid or raised limit %s", (limit) => {
    expect(() => splitWorldEventBatches([], limit)).toThrow(RangeError);
  });
  it("rejects corrupt and individually oversized events instead of truncating or partly flushing", () => {
    expect(() => splitWorldEventBatches([pose, { ...camera, t_ms: NaN }])).toThrow(TypeError);
    const oversized: WorldEvent = { t_ms: 0, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "\u0000".repeat(MAX_NOTE_CHARACTERS) } };
    expect(() => splitWorldEventBatches([pose, oversized])).toThrow(/index 1 exceeds/);
  });
  it("becomes due after 350 ms from the oldest queued item, with no empty or backward-clock flush", () => {
    expect(WORLD_EVENT_BATCH_INTERVAL_MS).toBe(350);
    expect(worldEventBatchDue(null, 10_000)).toBe(false);
    expect(worldEventBatchDue(0, 349)).toBe(false);
    expect(worldEventBatchDue(0, 350)).toBe(true);
    expect(worldEventBatchDue(300, 200)).toBe(false);
    expect(worldEventBatchDue(-1, 500)).toBe(false);
    expect(worldEventBatchDue(0, NaN)).toBe(false);
    expect(worldEventBatchDue(0, Infinity)).toBe(false);
    expect(worldEventBatchDue(10, 260, 250)).toBe(true);
    expect(worldEventBatchDue(10, 510, 500)).toBe(true);
  });
  it.each([249, 501, NaN, Infinity])("rejects interval outside 250–500 ms (%s)", (interval) => {
    expect(() => worldEventBatchDue(0, 1000, interval)).toThrow(RangeError);
  });
});
