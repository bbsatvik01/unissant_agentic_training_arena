// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { localStaffPlaybackActivity } from "../../lib/precinct/localStaffPlaybackActivity";
import { parseRecording } from "../../lib/world/parseRecording";
import { createMountedSceneContext, OFFICE_SCENE_CONTEXT } from "../../lib/world/sceneContext";
import { useLocalWorldCapture } from "./useLocalWorldCapture";
const parsed = parseRecording(raw); if (!parsed.ok) throw new Error("fixture"); const packet = parsed.recording.case;
const camera = { mode: "first" as const, position: [0, 1.7, 0] as const, quaternion: [0, 0, 0, 1] as const, fov: 60 };
afterEach(() => { cleanup(); localStaffPlaybackActivity.set(false); vi.restoreAllMocks(); });
describe("mounted-scene capture seam", () => {
  it("subscribes to actual staff playback and invalidates the prefix synchronously", () => {
    const scene = createMountedSceneContext(); scene.set(OFFICE_SCENE_CONTEXT);
    const { result } = renderHook(() => useLocalWorldCapture(packet, "idle", false, scene));
    const beforeStart = result.current.onCameraSample;
    act(() => { result.current.controller.start(); });
    act(() => { beforeStart(camera); });
    expect(result.current.snapshot.count).toBe(0);
    act(() => { result.current.onCameraSample(camera); });
    act(() => { localStaffPlaybackActivity.set(true); });
    expect(result.current.snapshot).toMatchObject({ status: "blocked", issue: "audio-enabled", count: 1 });
    act(() => { localStaffPlaybackActivity.set(false); result.current.onCameraSample(camera); });
    expect(result.current.snapshot.count).toBe(1); expect(result.current.local?.exportRecording().ok).toBe(true);
  });
  it("marks a readiness loss immediately, retaining the old prefix and invalidating old input callbacks", () => {
    const source = createMountedSceneContext(); source.set(OFFICE_SCENE_CONTEXT);
    const { result } = renderHook(() => useLocalWorldCapture(packet, "idle", false, source));
    act(() => { result.current.controller.start(); });
    const oldCamera = result.current.onCameraSample;
    act(() => { oldCamera(camera); }); expect(result.current.snapshot.count).toBe(1);
    act(() => { source.set(null); });
    expect(result.current.snapshot).toMatchObject({ status: "blocked", issue: "scene-changed", count: 1 });
    act(() => { source.set(OFFICE_SCENE_CONTEXT); oldCamera(camera); result.current.beforeFrame(); });
    expect(result.current.snapshot.count).toBe(1); expect(result.current.actorCapture).toBeUndefined();
    const exported = result.current.local?.exportRecording(); if (exported?.ok !== true) throw new Error("prefix missing");
    expect(exported.recording.scene_context).toEqual(OFFICE_SCENE_CONTEXT);
  });
  it("fails closed on a source-owner replacement even when the replacement reports the same tuple", () => {
    const first = createMountedSceneContext(); first.set(OFFICE_SCENE_CONTEXT);
    const second = createMountedSceneContext(); second.set(OFFICE_SCENE_CONTEXT);
    const { result, rerender } = renderHook((source: typeof first) => useLocalWorldCapture(packet, "idle", false, source), { initialProps: first });
    const beforeStart = result.current.onCameraSample;
    act(() => { result.current.controller.start(); });
    act(() => { beforeStart(camera); });
    expect(result.current.snapshot.count).toBe(0);
    act(() => { result.current.onCameraSample(camera); });
    rerender(second); expect(result.current.snapshot).toMatchObject({ status: "blocked", issue: "scene-changed", count: 1 });
    expect(result.current.local?.exportRecording().ok).toBe(true);
  });
});
