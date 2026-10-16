// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStaffPlaybackActivity } from "../../lib/precinct/localStaffPlaybackActivity";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { CASES, RECORDED_CASE_ID } from "../../lib/world/cases";
import { COURTYARD_SCENE_CONTEXT, createMountedSceneContext, OFFICE_SCENE_CONTEXT, type MountedSceneContext } from "../../lib/world/sceneContext";
import { usePrecinctSession } from "./usePrecinctSession";
const options = { reducedMotion: true, paused: false, audioInRoom: false };
const transport = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
beforeEach(() => {
  transport.mockReset();
  transport.mockImplementation((path) => Promise.resolve(new Response(JSON.stringify(path === "/api/me"
    ? { user_id: "local-user", display_name: "Local trainee", roles: ["trainee"], csrf_token: "test-token", ex4_acknowledged: "2026-10-15T09:00:00Z" }
    : path === "/api/cases" ? { cases: CASES } : { case: CASES.find((item) => item.case_id === RECORDED_CASE_ID), brief: { initial_documents: raw.case.initial_documents } }), { status: 200 })));
  vi.stubGlobal("fetch", transport); vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => { cleanup(); localStaffPlaybackActivity.set(false); sessionStorage.clear(); vi.unstubAllGlobals(); });
function mount(captureScene?: MountedSceneContext) {
  return renderHook((source: MountedSceneContext | undefined) => usePrecinctSession({ ...options, ...(source === undefined ? {} : { captureScene: source }) }), { initialProps: captureScene });
}
async function prepare(result: ReturnType<typeof mount>["result"]) {
  await act(async () => { await result.current.connectLocalBackend(); });
  act(() => { result.current.selectCase(RECORDED_CASE_ID); });
  await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
  expect(result.current.canStart).toBe(true);
}
describe("existing session with mounted scene capability", () => {
  it("refuses staff playback while arming and synchronously marks a later armed capture incomplete", async () => {
    const scene = createMountedSceneContext(); scene.set(OFFICE_SCENE_CONTEXT);
    const { result } = mount(scene); await prepare(result);
    act(() => { localStaffPlaybackActivity.set(true); expect(result.current.freshCapture.arm()).toBe(false); });
    act(() => { localStaffPlaybackActivity.set(false); expect(result.current.freshCapture.arm()).toBe(true); });
    act(() => { localStaffPlaybackActivity.set(true); });
    expect(result.current.freshCapture.state).toMatchObject({ phase: "incomplete", reason: "audio-enabled" });
    expect(result.current.freshCapture.exportRecording().ok).toBe(false);
  });
  it("retains ordinary explicit connection behavior but refuses fresh capture without actual scene readiness", async () => {
    const { result } = mount(); expect(transport).not.toHaveBeenCalled(); await prepare(result);
    act(() => { expect(result.current.freshCapture.arm()).toBe(false); });
    expect(result.current.freshCapture.state.phase).toBe("idle");
    expect(transport.mock.calls.some(([path]) => path === "/api/sessions")).toBe(false);
  });
  it("arms only after known readiness and invalidates an armed capture on actual tuple replacement", async () => {
    const scene = createMountedSceneContext(); const { result } = mount(scene); await prepare(result);
    act(() => { expect(result.current.freshCapture.arm()).toBe(false); scene.set(OFFICE_SCENE_CONTEXT); });
    act(() => { expect(result.current.freshCapture.arm()).toBe(true); });
    expect(result.current.freshCapture.state.phase).toBe("armed");
    act(() => { scene.set(COURTYARD_SCENE_CONTEXT); });
    expect(result.current.freshCapture.state).toMatchObject({ phase: "incomplete", reason: "scene-changed" });
    expect(result.current.freshCapture.exportRecording().ok).toBe(false); // No actual run opening exists.
    expect(transport.mock.calls.some(([path]) => path === "/api/sessions")).toBe(false);
  });
  it("fails an armed observer closed when its owner changes even if both owners report Office", async () => {
    const first = createMountedSceneContext(); first.set(OFFICE_SCENE_CONTEXT);
    const second = createMountedSceneContext(); second.set(OFFICE_SCENE_CONTEXT);
    const { result, rerender } = mount(first); await prepare(result);
    act(() => { expect(result.current.freshCapture.arm()).toBe(true); });
    rerender(second); expect(result.current.freshCapture.state).toMatchObject({ phase: "incomplete", reason: "scene-changed" });
  });
});
