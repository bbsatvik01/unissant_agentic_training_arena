import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { seek, startCursor } from "./recording";
import { createWorldCapture, MAX_CAPTURE_BYTES, MAX_CAPTURE_EVENTS, type CaptureContext } from "./worldCapture";
import { MAX_WORLD_BATCH_BYTES, worldEventBatchBytes, type CameraData, type PoseData, type WorldEventBatch } from "./worldEvents";

const pose: PoseData = { actor_id: "trainee", position: [0, 0, 0], rotation: [0, 0, 0, 1], animation: { clip: "idle", time: 0 } };
const camera: CameraData = { mode: "first", position: [0, 1.7, 0], quaternion: [0, 0, 0, 1], fov: 60 };
const parsed = parseRecording(raw);
if (!parsed.ok) throw new Error("bad test fixture");
const recording = parsed.recording;
function setup(limits: { maxEvents?: number; maxBytes?: number } = {}) {
  let context: CaptureContext | null = { sessionKey: "s", trialId: recording.trial_id, clockMs: 0, writable: true,
    publicEvidenceIds: new Set(["record-1"]), publicTextFields: new Set(["interview-question"]) };
  let now = 0;
  const capture = createWorldCapture({ ...limits, context: () => context, now: () => now });
  return { capture, at: (value: number) => { if (context !== null) context = { ...context, clockMs: value }; }, wall: (value: number) => { now = value; },
    patch: (change: Partial<CaptureContext>) => { if (context !== null) context = { ...context, ...change }; }, noContext: () => { context = null; } };
}
function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("explicit world capture", () => {
  it("has no effects before Start, captures actual typed actions on the caller clock, and exports owned copies", () => {
    const { capture, at } = setup();
    expect(capture.pose(pose)).toBe(false);
    expect(capture.getSnapshot()).toMatchObject({ status: "empty", pending: 0, transport: "off" });
    expect(capture.start()).toBe(true);
    expect(capture.clear()).toBe(false);
    expect(capture.pose(pose)).toBe(true);
    expect(capture.camera(camera)).toBe(true);
    at(111.5);
    expect(capture.input({ action: "key", key: "KeyW", pressed: true })).toBe(true);
    expect(capture.input({ action: "click", target: "case-board", button: 0 })).toBe(true);
    expect(capture.input({ action: "text", field_id: "interview-question", value: "A pasted question 東京" })).toBe(true);
    expect(capture.input({ action: "notebook", operation: "upsert", note_id: "n", text: "Check the dated source." })).toBe(true);
    expect(capture.input({ action: "evidence", operation: "pin", record_id: "record-1" })).toBe(true);
    expect(capture.ui({ action: "file_page", file_id: "file-1", page: 2 })).toBe(true);
    const exported = capture.exportEvents();
    expect(exported.events.map((event) => event.t_ms)).toEqual([0, 0, 111.5, 111.5, 111.5, 111.5, 111.5, 111.5]);
    expect(capture.getSnapshot().bytes).toBe(worldEventBatchBytes(exported));
    expect(exported.events[0]).not.toBe(capture.exportEvents().events[0]);
    capture.stop(); expect(capture.input({ action: "key", key: "KeyW", pressed: false })).toBe(false);
    expect(capture.start()).toBe(true); expect(capture.ui({ action: "panel", panel_id: "notebook", open: true })).toBe(true);
  });
  it("notifies and unsubscribes without exposing internal mutable log data", () => {
    const { capture } = setup(); const listener = vi.fn(); const off = capture.subscribe(listener);
    capture.start(); expect(listener).toHaveBeenCalledOnce(); off(); capture.stop(); expect(listener).toHaveBeenCalledOnce();
    const state = capture.getSnapshot(); expect(capture.getSnapshot()).toBe(state);
  });
  it.each([null, { writable: false }, { sessionKey: " " }, { trialId: "" }])("refuses an unavailable initial context %#", (value) => {
    const env = setup(); if (value === null) env.noContext(); else env.patch(value);
    expect(env.capture.start()).toBe(false); expect(env.capture.getSnapshot().issue).toBe("unavailable");
    expect(env.capture.enableSender(() => Promise.resolve())).toBe(false);
  });
  it.each([NaN, Infinity, -1])("refuses an invalid initial session clock %s", (value) => {
    const env = setup(); env.at(value); expect(env.capture.start()).toBe(false); expect(env.capture.getSnapshot().issue).toBe("clock-reset");
  });
  it.each([{ sessionKey: "another" }, { trialId: "another" }, { writable: false }])("keeps captured samples when the parent scope changes %#", (patch) => {
    const env = setup(); env.capture.start(); env.capture.pose(pose); env.patch(patch);
    expect(env.capture.pose(pose)).toBe(false); expect(env.capture.getSnapshot()).toMatchObject({ issue: "scope-changed", count: 1 });
    expect(env.capture.start()).toBe(false); expect(env.capture.clear()).toBe(true); expect(env.capture.exportEvents().events).toEqual([]);
  });
  it("fails closed on disappeared context and clock rewind even after Stop", () => {
    const env = setup(); env.capture.start(); env.at(10); env.capture.pose(pose); env.at(9);
    expect(env.capture.pose(pose)).toBe(false); expect(env.capture.getSnapshot().issue).toBe("clock-reset");
    env.at(11); expect(env.capture.start()).toBe(false); env.capture.clear(); env.capture.start(); env.capture.stop(); env.at(10);
    expect(env.capture.start()).toBe(false); env.capture.clear(); env.capture.start(); env.noContext(); expect(env.capture.pose(pose)).toBe(false);
  });
  it.each([
    { action: "key", key: "password", pressed: true },
    { action: "text", field_id: "password", value: "must not store" },
    { action: "evidence", operation: "inspect", record_id: "private-record" },
  ] as const)("refuses undeclared public inputs %#", (input) => {
    const { capture } = setup(); capture.start(); expect(capture.input(input)).toBe(false);
    expect(capture.getSnapshot().issue).toBe("private-input"); expect(capture.exportEvents().events).toEqual([]);
  });
  it("rejects malformed and oversized samples whole without truncating notes", () => {
    const { capture } = setup(); capture.start(); expect(capture.camera({ ...camera, fov: 0 })).toBe(false);
    expect(capture.getSnapshot().issue).toBe("invalid-event"); capture.clear(); capture.start();
    expect(capture.input({ action: "notebook", operation: "upsert", note_id: "n", text: "\u0000".repeat(16_000) })).toBe(false);
    expect(capture.getSnapshot()).toMatchObject({ issue: "invalid-event", count: 0 });
  });
  it("stops at event and exact-byte budgets, retaining all accepted events for export", () => {
    const sample = { t_ms: 0, kind: "pose" as const, data: pose };
    const bytes = worldEventBatchBytes({ events: [sample] });
    for (const limit of [{ maxEvents: 1 }, { maxBytes: bytes }]) {
      const { capture } = setup(limit); capture.start(); expect(capture.pose(pose)).toBe(true); expect(capture.pose(pose)).toBe(false);
      expect(capture.getSnapshot()).toMatchObject({ issue: "memory-limit", count: 1, bytes });
      expect(capture.exportEvents().events).toEqual([sample]); expect(capture.start()).toBe(false);
    }
    const { capture } = setup({ maxBytes: bytes - 1 }); capture.start(); expect(capture.pose(pose)).toBe(false); expect(capture.getSnapshot().count).toBe(0);
  });
  it.each([{ maxEvents: 0 }, { maxEvents: 1.5 }, { maxEvents: MAX_CAPTURE_EVENTS + 1 }, { maxBytes: 12 }, { maxBytes: NaN }, { maxBytes: MAX_CAPTURE_BYTES + 1 }])("rejects invalid budgets %#", (limit) => { expect(() => setup(limit)).toThrow(RangeError); });
  it("uses a monotonic scheduling clock by default without inventing the session origin", () => {
    const context: CaptureContext = { sessionKey: "s", trialId: "t", clockMs: 123, writable: true, publicEvidenceIds: new Set(), publicTextFields: new Set() };
    const capture = createWorldCapture({ context: () => context }); capture.start(); capture.pose(pose); expect(capture.exportEvents().events[0]?.t_ms).toBe(123);
  });
});

describe("explicit serialized transport", () => {
  it("never probes or sends offline and batches on 350ms even when the session clock is paused", async () => {
    const env = setup(); const send = vi.fn(() => Promise.resolve());
    expect(await env.capture.flush()).toBe("empty"); env.capture.start(); env.capture.pose(pose);
    env.wall(10_000); expect(await env.capture.tick()).toBe("disabled"); expect(send).not.toHaveBeenCalled();
    expect(env.capture.enableSender(send)).toBe(true); env.wall(0); expect(await env.capture.tick()).toBe("empty");
    env.wall(349); expect(await env.capture.tick()).toBe("empty"); env.wall(350); expect(await env.capture.tick()).toBe("sent");
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]).toEqual([recording.trial_id, { events: [{ t_ms: 0, kind: "pose", data: pose }] }]);
    expect(env.capture.getSnapshot()).toMatchObject({ pending: 0, count: 1, transport: "ready" }); expect(await env.capture.flush()).toBe("empty");
  });
  it("serializes cap-split bodies, keeps equal-time order, and handles captures during a write", async () => {
    const env = setup(); const first = deferred(); const calls: WorldEventBatch[] = [];
    const send = vi.fn((_trial: string, batch: WorldEventBatch) => { calls.push(batch); return calls.length === 1 ? first.promise : Promise.resolve(); });
    env.capture.start(); env.capture.enableSender(send);
    for (let i = 0; i < 8; i += 1) env.capture.input({ action: "notebook", operation: "upsert", note_id: String(i), text: "x".repeat(16_000) });
    const running = env.capture.flush(); expect(env.capture.flush()).toBe(running); await Promise.resolve();
    expect(env.capture.clear()).toBe(false); expect(send).toHaveBeenCalledOnce(); env.capture.pose(pose);
    first.resolve(); expect(await running).toBe("sent"); await env.capture.flush();
    expect(calls.every((batch) => worldEventBatchBytes(batch) <= MAX_WORLD_BATCH_BYTES)).toBe(true);
    expect(calls.flatMap((batch) => batch.events)).toEqual(env.capture.exportEvents().events);
    expect(env.capture.getSnapshot()).toMatchObject({ count: 9, pending: 0 });
  });
  it("retains a failed batch and newer data, blocks automatic retries, and retries only with duplicate-risk acceptance", async () => {
    const env = setup(); const send = vi.fn<() => Promise<void>>(() => Promise.reject(new Error("secret payload should never be shown")));
    env.capture.start(); env.capture.enableSender(send); env.capture.pose(pose);
    expect(await env.capture.flush()).toBe("uncertain"); expect(env.capture.getSnapshot()).toMatchObject({ pending: 1, transport: "uncertain" });
    env.capture.camera(camera); env.wall(1_000); expect(await env.capture.tick()).toBe("uncertain"); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(env.capture.getSnapshot())).not.toContain("secret");
    expect(await env.capture.retryFlush(false)).toBe("uncertain");
    expect(env.capture.enableSender(send)).toBe(true); expect(env.capture.getSnapshot().transport).toBe("uncertain");
    send.mockImplementation(() => Promise.resolve());
    expect(await env.capture.retryFlush(true)).toBe("sent"); expect(env.capture.getSnapshot()).toMatchObject({ pending: 0, count: 2 });
  });
  it("does not retry a still-pending write and safely disables while in flight", async () => {
    const env = setup(); const pending = deferred(); const send = vi.fn(() => pending.promise);
    env.capture.start(); env.capture.pose(pose); env.capture.enableSender(send);
    const running = env.capture.flush(); expect(env.capture.retryFlush(true)).toBe(running); await Promise.resolve();
    env.capture.disableSender(); expect(env.capture.getSnapshot().transport).toBe("sending"); pending.resolve(); await running;
    expect(env.capture.getSnapshot()).toMatchObject({ transport: "off", pending: 0 });
    env.capture.pose(pose); expect(await env.capture.flush()).toBe("disabled");
  });
  it("keeps the enqueue deadline of samples captured during a slow write", async () => {
    const env = setup(); const pending = deferred(); let calls = 0;
    const send = vi.fn(() => { calls += 1; return calls === 1 ? pending.promise : Promise.resolve(); });
    env.capture.start(); env.capture.enableSender(send); env.capture.pose(pose); const running = env.capture.flush(); await Promise.resolve();
    env.wall(100); env.capture.camera(camera); env.wall(600); pending.resolve(); await running;
    expect(await env.capture.tick()).toBe("sent"); expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not send later batches after a local disconnect or trial replacement", async () => {
    for (const change of ["disconnect", "scope"] as const) {
      const env = setup(); const pending = deferred(); const send = vi.fn(() => pending.promise);
      env.capture.start();
      for (let i = 0; i < 5; i += 1) env.capture.input({ action: "notebook", operation: "upsert", note_id: String(i), text: "x".repeat(16_000) });
      env.capture.enableSender(send); const running = env.capture.flush(); await Promise.resolve();
      if (change === "disconnect") env.capture.disableSender(); else env.patch({ trialId: "other" });
      pending.resolve(); expect(await running).toBe("disabled"); expect(send).toHaveBeenCalledOnce();
      expect(env.capture.getSnapshot().pending).toBe(2); expect(env.capture.getSnapshot().count).toBe(5);
      expect(await env.capture.flush()).toBe("disabled");
    }
  });
  it("preserves only unconfirmed batches after a later batch fails", async () => {
    const env = setup(); let calls = 0;
    const send = vi.fn(() => { calls += 1; return calls === 1 ? Promise.resolve() : Promise.reject(new Error("failed")); });
    env.capture.start(); for (let i = 0; i < 5; i += 1) env.capture.input({ action: "notebook", operation: "upsert", note_id: String(i), text: "x".repeat(16_000) });
    env.capture.enableSender(send); expect(await env.capture.flush()).toBe("uncertain"); expect(env.capture.getSnapshot()).toMatchObject({ pending: 2, count: 5 });
    env.capture.disableSender(); expect(env.capture.getSnapshot().transport).toBe("uncertain"); expect(await env.capture.retryFlush(true)).toBe("disabled");
    env.capture.stop(); expect(env.capture.clear()).toBe(true);
  });
});

describe("offline export and replay", () => {
  it("round-trips the same canonical trial stream, notes, draft and camera without resending commands", () => {
    const env = setup(); env.capture.start(); env.capture.camera(camera); env.at(100);
    env.capture.input({ action: "notebook", operation: "upsert", note_id: "n", text: "Dated source" });
    env.at(200); env.capture.input({ action: "notebook", operation: "delete", note_id: "n" });
    const result = env.capture.exportRecording(recording); if (!result.ok) throw new Error(result.errors.join(";"));
    expect(result.recording.format).toBe("arena.recording.v2"); expect(result.recording.events).toEqual(recording.events);
    const end = seek(result.recording, startCursor(result.recording), Infinity);
    expect(end.world.notes.size).toBe(0); const back = seek(result.recording, end, 100);
    expect(back.world.notes.get("n")?.text).toBe("Dated source"); expect(back.world.camera).toEqual(camera);
    expect(env.capture.getSnapshot().pending).toBe(3);
  });
  it("supports a world-only public snapshot export, and rejects another trial or duplicate base stream", () => {
    const env = setup(); expect(env.capture.exportRecording(recording).ok).toBe(false); env.capture.start(); env.capture.pose(pose);
    expect(env.capture.exportRecording({ ...recording, trial_id: "different" }).ok).toBe(false);
    expect(env.capture.exportRecording({ ...recording, world_events: env.capture.exportEvents().events }).ok).toBe(false);
    const result = env.capture.exportRecording({ ...recording, events: [], debrief: null, final_snapshot: null, world_events: [] });
    expect(result.ok && result.recording.events).toEqual([]);
  });
});
