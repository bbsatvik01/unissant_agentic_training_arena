import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { seek, startCursor, type Recording } from "./recording";
import { createLocalWorldCapture, isLocalWorldRecording, LOCAL_WORLD_PREFIX, LOCAL_WORLD_REASON } from "./localWorldCapture";
import { recordingJson } from "./recordingFiles";
const parsed = parseRecording(raw); if (!parsed.ok) throw new Error("fixture");
const historical = parsed.recording;
function setup() {
  let now = 10_000; let id = 0;
  const nextId = vi.fn(() => { id += 1; return `new-${String(id)}`; });
  const local = createLocalWorldCapture({ packet: historical.case, isActive: () => true, now: () => now, newId: nextId });
  return { local, at: (time: number) => { now = time; }, nextId };
}
function captureAndExport(): Recording {
  const { local } = setup(); local.controller.start(); local.controller.ui({ action: "panel", panel_id: "dossier", open: true }); local.controller.stop();
  const result = local.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; ")); return result.recording;
}

describe("new local world-only run", () => {
  it("allocates identity and a zero-time base only on explicit Start, with no prior run results", () => {
    const { local, nextId } = setup(); expect(nextId).not.toHaveBeenCalled(); expect(local.exportRecording().ok).toBe(false);
    expect(local.controller.start()).toBe(true); expect(nextId).toHaveBeenCalledOnce(); expect(local.clock.current).toBe(0);
    expect(local.controller.start()).toBe(true); expect(nextId).toHaveBeenCalledOnce();
    expect(local.exportRecording().ok).toBe(false); // No fabricated marker creates a playable file.
    local.controller.ui({ action: "panel", panel_id: "dossier", open: true }); local.controller.stop();
    const result = local.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.trial_id).toBe(`${LOCAL_WORLD_PREFIX}new-1`); expect(result.recording.trial_id).not.toBe(historical.trial_id);
    expect(result.recording.case).toEqual(historical.case); expect(result.recording.events).toEqual([]);
    expect(result.recording.debrief).toBeNull(); expect(result.recording.final_snapshot).toBeNull();
    expect(result.recording.snapshot).toMatchObject({ reason_code: LOCAL_WORLD_REASON, exchanges_used: 0, last_seq: 0, finding: null, commitment_hash: null,
      turns: [], voice_exchanges: [], released: [], requestable: [], cards: [], updates: [], coach_failures: [] });
    expect(isLocalWorldRecording(result.recording)).toBe(true); expect(parseRecording(JSON.parse(recordingJson(result.recording)) as unknown)).toEqual(result);
  });
  it("has a monotonic route-owned clock with explicit stop/resume and fresh identity after clear", () => {
    const env = setup(); env.local.advanceClock(); expect(env.local.clock.current).toBe(0); env.local.controller.start();
    env.at(10_250); expect(env.local.advanceClock()).toBe(250); env.at(10_100); expect(env.local.advanceClock()).toBe(250);
    env.at(NaN); expect(env.local.advanceClock()).toBe(250); env.at(Infinity); expect(env.local.advanceClock()).toBe(250);
    env.at(10_500); env.local.controller.stop(); expect(env.local.clock.current).toBe(500); env.at(50_000); env.local.advanceClock(); expect(env.local.clock.current).toBe(500);
    env.local.controller.start(); env.at(50_100); env.local.advanceClock(); expect(env.local.clock.current).toBe(600);
    expect(env.local.controller.clear()).toBe(false); env.local.controller.stop(); expect(env.local.controller.clear()).toBe(true); expect(env.local.clock.current).toBe(0);
    env.local.controller.start(); expect(env.local.controller.getSnapshot().trialId).toBe(`${LOCAL_WORLD_PREFIX}new-2`);
  });
  it("captures the actual caller-clock samples and replays offline through the existing cursor", () => {
    const env = setup(); env.local.controller.start();
    env.local.controller.camera({ mode: "third", position: [0, 2, 1], quaternion: [0, 0, 0, 1], fov: 60 });
    env.at(10_500); env.local.advanceClock(); env.local.controller.input({ action: "notebook", operation: "upsert", note_id: "n", text: "Read the source first." });
    env.at(10_900); env.local.advanceClock(); env.local.controller.input({ action: "notebook", operation: "delete", note_id: "n" }); env.local.controller.stop();
    const result = env.local.exportRecording(); if (!result.ok) throw new Error("export");
    expect(result.recording.world_events.map((event) => event.t_ms)).toEqual([0, 500, 900]);
    const end = seek(result.recording, startCursor(result.recording), Infinity); expect(end.world.notes.size).toBe(0);
    const back = seek(result.recording, end, 500); expect(back.world.notes.get("n")?.text).toBe("Read the source first."); expect(back.world.camera?.mode).toBe("third");
    expect(back.state.view?.turns).toEqual([]); expect(back.state.view?.runningFinding).toBeNull(); expect(back.state.view?.debriefReady).toBeNull();
  });
  it("hard-disables transport and allows only public packet IDs, not historical releases or interview typing", async () => {
    const env = setup(); const sender = vi.fn(() => Promise.resolve()); env.local.controller.start();
    expect(env.local.controller.enableSender(sender)).toBe(false);
    const doc = historical.case.initial_documents[0]; if (doc === undefined) throw new Error("fixture");
    expect(env.local.controller.input({ action: "evidence", operation: "inspect", record_id: doc.doc_id })).toBe(true);
    expect(await env.local.controller.flush()).toBe("disabled"); expect(sender).not.toHaveBeenCalled();
    expect(env.local.controller.input({ action: "text", field_id: "interview-question", value: "Historical question" })).toBe(false);
    expect(env.local.controller.getSnapshot().issue).toBe("private-input"); expect(env.local.controller.start()).toBe(false);
  });
  it("requires current parent ownership and freezes capture when a live or historical source takes over", () => {
    let active = false; let now = 0;
    const local = createLocalWorldCapture({ packet: historical.case, isActive: () => active, now: () => now });
    expect(local.controller.start()).toBe(false); expect(local.controller.getSnapshot().trialId).toBeNull();
    active = true; local.controller.start(); now = 100; local.advanceClock(); active = false; now = 200;
    expect(local.advanceClock()).toBe(100); expect(local.controller.ui({ action: "panel", panel_id: "replay", open: true })).toBe(false);
    expect(local.controller.getSnapshot().issue).toBe("scope-changed"); expect(local.controller.start()).toBe(false);
  });
  it.each([NaN, Infinity, -1])("refuses an invalid start clock %s", (now) => {
    const local = createLocalWorldCapture({ packet: historical.case, isActive: () => true, now: () => now }); expect(local.controller.start()).toBe(false);
  });
  it.each(["", "../other", "a".repeat(121)])("refuses an invalid local identity %s", (id) => {
    const local = createLocalWorldCapture({ packet: historical.case, isActive: () => true, newId: () => id }); expect(local.controller.start()).toBe(false);
  });
  it("uses platform monotonic time and fresh UUID by default", () => {
    const local = createLocalWorldCapture({ packet: historical.case, isActive: () => true }); expect(local.controller.start()).toBe(true); local.advanceClock();
    expect(local.controller.getSnapshot().trialId).toMatch(/^local-world:[0-9a-f-]{36}$/); local.controller.stop();
  });
  it("refuses a malformed public packet rather than shipping hidden properties", () => {
    expect(() => createLocalWorldCapture({ isActive: () => true, packet: { ...historical.case, subject: { ...historical.case.subject, role: "do not export" } } as typeof historical.case })).toThrow(TypeError);
  });
  it("only labels empty world-only files as local; a prefix never launders a real score or transcript", () => {
    const local = captureAndExport();
    expect(isLocalWorldRecording(historical)).toBe(false); expect(isLocalWorldRecording({ ...local, trial_id: LOCAL_WORLD_PREFIX })).toBe(false);
    expect(isLocalWorldRecording({ ...local, events: historical.events })).toBe(false); expect(isLocalWorldRecording({ ...local, debrief: historical.debrief })).toBe(false);
    expect(isLocalWorldRecording({ ...local, final_snapshot: historical.snapshot })).toBe(false);
    for (const snapshot of [{ ...local.snapshot, reason_code: null }, { ...local.snapshot, status: "completed" as const }, { ...local.snapshot, mode: "assessment" as const },
      { ...local.snapshot, split: "hidden" as const }, { ...local.snapshot, exchanges_used: 1 }, { ...local.snapshot, last_seq: 1 }, { ...local.snapshot, commitment_hash: "a".repeat(64) },
      { ...local.snapshot, requestable: [{ record_id: "rec-01", title: "historical", kind: "badge_log" as const, description: "Historical public record", requestable_after_exchanges: 0 }] }]) {
      expect(isLocalWorldRecording({ ...local, snapshot })).toBe(false);
    }
  });
});
