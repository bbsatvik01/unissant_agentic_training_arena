import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { LogBuilder, SESSION_ID, TRIAL_ID, snapshot } from "../../test/trial-log";
import { fixture } from "../../test/wire-fixtures";
import type { Debrief } from "../contracts/generated/types";
import { createFreshClientCapture } from "./freshClientCapture";
import { createLocalWorldCapture } from "./localWorldCapture";
import { createWorldCapture } from "./worldCapture";
import { parseRecording } from "./parseRecording";
import { COURTYARD_SCENE_CONTEXT, createMountedSceneContext, OFFICE_SCENE_CONTEXT } from "./sceneContext";
import { recordingJson } from "./recordingFiles";
import { seek, startCursor } from "./recording";
const checked = parseRecording(raw); if (!checked.ok) throw new Error("invalid fixture"); const packet = checked.recording.case;
const started = { session_id: SESSION_ID, trial_id: TRIAL_ID, mode: "practice" as const, case_id: packet.case_id };
const camera = { mode: "first" as const, position: [1, 1.7, -4] as const, quaternion: [0, 0, 0, 1] as const, fov: 60 };

describe("one mounted scene per capture", () => {
  it("binds the actual local scene, freezes the clock on replacement and retains only its old prefix", () => {
    let now = 100;
    const source = createMountedSceneContext();
    const local = createLocalWorldCapture({ packet, isActive: () => true, readScene: source.read, now: () => now, newId: () => "scene-test" });
    expect(local.controller.start()).toBe(false); source.set(OFFICE_SCENE_CONTEXT);
    expect(local.controller.clear()).toBe(true); expect(local.controller.start()).toBe(true);
    now = 150; local.advanceClock(); expect(local.controller.camera(camera)).toBe(true);
    source.set(null); now = 200; expect(local.advanceClock()).toBe(50);
    expect(local.controller.getSnapshot()).toMatchObject({ status: "blocked", issue: "scene-changed", count: 1 });
    source.set(OFFICE_SCENE_CONTEXT); now = 300; expect(local.advanceClock()).toBe(50); expect(local.controller.start()).toBe(false);
    expect(local.controller.camera({ ...camera, position: [99, 1, 0] })).toBe(false);
    const result = local.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT); expect(result.recording.world_events).toHaveLength(1);
    expect(seek(result.recording, startCursor(result.recording), Infinity).world.camera).toEqual(camera);
    expect(parseRecording(JSON.parse(recordingJson(result.recording)) as unknown)).toEqual(result);
    expect(local.controller.clear()).toBe(true); expect(local.controller.start()).toBe(true);
  });
  it("never relabels an Office prefix as Courtyard when a known tuple replaces another", () => {
    const source = createMountedSceneContext(); source.set(OFFICE_SCENE_CONTEXT);
    const local = createLocalWorldCapture({ packet, isActive: () => true, readScene: source.read, now: () => 0, newId: () => "known-switch" });
    expect(local.controller.start()).toBe(true); expect(local.controller.camera(camera)).toBe(true);
    source.set(COURTYARD_SCENE_CONTEXT); expect(local.controller.validateScene()).toBe(false);
    expect(local.controller.camera({ ...camera, position: [2, 3, 4] })).toBe(false);
    const prefix = local.exportRecording(); if (!prefix.ok) throw new Error(prefix.errors.join("; "));
    expect(prefix.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT); expect(prefix.recording.world_events).toHaveLength(1);
    expect(local.controller.clear()).toBe(true); expect(local.controller.start()).toBe(true);
    expect(local.controller.camera(camera)).toBe(true);
    const next = local.exportRecording(); if (!next.ok) throw new Error(next.errors.join("; "));
    expect(next.recording.scene_context).toEqual(COURTYARD_SCENE_CONTEXT);
  });
  it("keeps a scene-blocked adapter transport disabled on repeated flush without sending file metadata", async () => {
    const source = createMountedSceneContext(); source.set(OFFICE_SCENE_CONTEXT);
    const sender = vi.fn(() => Promise.resolve());
    const capture = createWorldCapture({ readScene: source.read, context: () => ({ sessionKey: "current", trialId: "trial", clockMs: 0,
      writable: true, publicEvidenceIds: new Set<string>(), publicTextFields: new Set<string>() }) });
    expect(capture.start()).toBe(true); expect(capture.enableSender(sender)).toBe(true);
    capture.camera(camera); expect(await capture.flush()).toBe("sent");
    expect(sender).toHaveBeenCalledWith("trial", { events: [{ t_ms: 0, kind: "camera", data: camera }] });
    capture.camera(camera); source.set(null);
    expect(await capture.flush()).toBe("disabled"); expect(await capture.flush()).toBe("disabled");
    expect(capture.enableSender(sender)).toBe(false); expect(sender).toHaveBeenCalledTimes(1);
  });
  it("refuses fresh arming until ready and marks a forced armed-scene replacement incomplete before Begin", () => {
    const source = createMountedSceneContext(); const capture = createFreshClientCapture(source.read);
    expect(capture.arm(packet, "fresh-scene")).toBe(false);
    source.set(OFFICE_SCENE_CONTEXT); expect(capture.arm(packet, "fresh-scene")).toBe(true);
    source.set(null); expect(capture.begin(started, () => 0)).toBeNull();
    expect(capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "scene-changed", frames: 0 });
    expect(capture.exportRecording().ok).toBe(false);
  });
  it("does not append late frames or inputs after a scene change and exports the original accepted prefix", () => {
    const source = createMountedSceneContext(); source.set(OFFICE_SCENE_CONTEXT);
    const capture = createFreshClientCapture(source.read); capture.arm(packet, "fresh-scene");
    let now = 0; const binding = capture.begin(started, () => now); if (binding === null) throw new Error("missing binding");
    binding.observer.observe({ type: "opening", snapshot: snapshot() });
    const frames = new LogBuilder().ask().frames; const first = frames[0]; if (first === undefined) throw new Error("missing frame");
    now = 10; binding.observer.observe({ type: "frame", frame: first }); expect(binding.camera(camera)).toBe(true);
    source.set(null); now = 20;
    for (const frame of frames.slice(1)) binding.observer.observe({ type: "frame", frame });
    expect(binding.input({ action: "text", field_id: "question-draft", value: "late" })).toBe(false);
    expect(capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "scene-changed", frames: 1, worldSamples: 1 });
    source.set(OFFICE_SCENE_CONTEXT); expect(capture.validateScene()).toBe(true); // Inactive journal never resumes.
    expect(binding.camera(camera)).toBe(false);
    const result = capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT); expect(result.recording.events.map((event) => event.frame)).toEqual([first]);
    expect(result.recording.client_capture).toMatchObject({ status: "incomplete", reason: "scene-changed" });
    expect(result.recording.debrief).toBeNull(); expect(parseRecording(JSON.parse(recordingJson(result.recording)) as unknown)).toEqual(result);
  });
  it("keeps complete silent-text publication and raw camera samples independent from a later scene selection", () => {
    const source = createMountedSceneContext(); source.set(OFFICE_SCENE_CONTEXT);
    const capture = createFreshClientCapture(source.read); capture.arm(packet, "complete-scene");
    let now = 0; const binding = capture.begin(started, () => now); if (binding === null) throw new Error("missing binding");
    binding.observer.observe({ type: "opening", snapshot: snapshot() });
    for (const frame of new LogBuilder().ask().commit().debriefReady().frames) { now += 10; binding.observer.observe({ type: "frame", frame }); }
    expect(binding.camera(camera)).toBe(true); now = 900;
    binding.observer.observe({ type: "terminal", equivalent: true }); binding.observer.observe({ type: "debrief", debrief: fixture("debrief:scored") as Debrief });
    expect(capture.getSnapshot().phase).toBe("complete"); source.set(null); capture.validateScene();
    const result = capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT); expect(result.recording.published_at_ms).toBe(900);
    expect(result.recording.client_capture?.status).toBe("complete"); expect(seek(result.recording, startCursor(result.recording), Infinity).world.camera).toEqual(camera);
  });
});
