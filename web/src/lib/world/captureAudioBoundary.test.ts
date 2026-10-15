import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { LogBuilder, SESSION_ID, TRIAL_ID, snapshot } from "../../test/trial-log";
import { createLocalStaffPlaybackActivity } from "../precinct/localStaffPlaybackActivity";
import { uncapturedAudioActive } from "./captureAudioBoundary";
import { createFreshClientCapture } from "./freshClientCapture";
import { createLocalWorldCapture } from "./localWorldCapture";
import { createWorldCapture } from "./worldCapture";
import { parseRecording } from "./parseRecording";
import { OFFICE_SCENE_CONTEXT } from "./sceneContext";
const checked = parseRecording(raw); if (!checked.ok) throw new Error("fixture"); const packet = checked.recording.case;
const camera = { mode: "first" as const, position: [1, 1.7, -4] as const, quaternion: [0, 0, 0, 1] as const, fov: 60 };
const started = { session_id: SESSION_ID, trial_id: TRIAL_ID, case_id: packet.case_id, mode: "practice" as const };
describe("real playback flag is a silent-capture boundary", () => {
  it("fails a broken activity reader closed without introducing an audio or clock owner", () => {
    expect(uncapturedAudioActive(undefined)).toBe(false); expect(uncapturedAudioActive(() => false)).toBe(false);
    expect(uncapturedAudioActive(() => true)).toBe(true);
    expect(uncapturedAudioActive(() => { throw new Error("owner unavailable"); })).toBe(true);
  });
  it("refuses local Start and fresh Arm during playback", () => {
    const audio = createLocalStaffPlaybackActivity(); audio.set(true);
    const local = createLocalWorldCapture({ packet, isActive: () => true, readScene: () => OFFICE_SCENE_CONTEXT,
      readUncapturedAudio: audio.getSnapshot, now: () => 0, newId: () => "audio-start" });
    expect(local.controller.start()).toBe(false); expect(local.controller.getSnapshot()).toMatchObject({ status: "blocked", issue: "audio-enabled", count: 0 });
    const fresh = createFreshClientCapture(() => OFFICE_SCENE_CONTEXT, audio.getSnapshot);
    expect(fresh.arm(packet, "audio-start")).toBe(false); expect(fresh.getSnapshot().phase).toBe("idle");
    audio.set(false); expect(local.controller.clear()).toBe(true); expect(local.controller.start()).toBe(true);
    expect(fresh.arm(packet, "audio-next")).toBe(true);
  });
  it("freezes the local clock and retains only the old silent samples after real playback starts", () => {
    const audio = createLocalStaffPlaybackActivity(); let now = 0;
    const local = createLocalWorldCapture({ packet, isActive: () => true, readScene: () => OFFICE_SCENE_CONTEXT,
      readUncapturedAudio: audio.getSnapshot, now: () => now, newId: () => "audio-prefix" });
    local.controller.start(); now = 25; local.advanceClock(); expect(local.controller.camera(camera)).toBe(true);
    audio.set(true); now = 50; expect(local.advanceClock()).toBe(25); expect(local.controller.camera(camera)).toBe(false);
    audio.set(false); expect(local.controller.start()).toBe(false);
    const result = local.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(local.controller.getSnapshot()).toMatchObject({ status: "blocked", issue: "audio-enabled", count: 1 });
    expect(result.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT); expect(result.recording.world_events).toEqual([{ t_ms: 25, kind: "camera", data: camera }]);
    expect(result.recording.debrief).toBeNull(); expect(result.recording.events).toEqual([]);
  });
  it("fails armed and actual fresh runs incomplete, retaining only their accepted prefix", () => {
    const audio = createLocalStaffPlaybackActivity(); const fresh = createFreshClientCapture(() => OFFICE_SCENE_CONTEXT, audio.getSnapshot);
    fresh.arm(packet, "armed-audio"); audio.set(true); expect(fresh.prepare(packet)).toBe(false);
    expect(fresh.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "audio-enabled" });
    audio.set(false); expect(fresh.arm(packet, "new-audio")).toBe(true);
    let time = 0; const binding = fresh.begin(started, () => time); if (binding === null) throw new Error("binding");
    binding.observer.observe({ type: "opening", snapshot: snapshot() });
    const frames = new LogBuilder().ask().frames; const first = frames[0]; if (first === undefined) throw new Error("frame");
    time = 10; binding.observer.observe({ type: "frame", frame: first }); binding.camera(camera);
    audio.set(true); time = 20;
    for (const frame of frames.slice(1)) binding.observer.observe({ type: "frame", frame });
    expect(binding.camera(camera)).toBe(false); audio.set(false); expect(binding.camera(camera)).toBe(false);
    const prefix = fresh.exportRecording(); if (!prefix.ok) throw new Error(prefix.errors.join("; "));
    expect(prefix.recording.client_capture).toMatchObject({ status: "incomplete", reason: "audio-enabled", original_audio: "absent" });
    expect(prefix.recording.events.map((entry) => entry.frame)).toEqual([first]); expect(prefix.recording.world_events).toHaveLength(1);
    expect(prefix.recording.debrief).toBeNull(); expect(prefix.recording.published_at_ms).toBeUndefined();
  });
  it("refuses transport and same-tick samples even before the hook's subscription callback", async () => {
    const audio = createLocalStaffPlaybackActivity(); const send = vi.fn(() => Promise.resolve());
    const capture = createWorldCapture({ readUncapturedAudio: audio.getSnapshot, context: () => ({
      sessionKey: "s", trialId: "t", writable: true, clockMs: 0, publicEvidenceIds: new Set<string>(), publicTextFields: new Set<string>(),
    }) });
    capture.start(); capture.camera(camera); capture.enableSender(send); audio.set(true);
    expect(capture.camera(camera)).toBe(false); expect(await capture.flush()).toBe("disabled"); expect(capture.enableSender(send)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(capture.exportEvents().events).toHaveLength(1);
  });
});
