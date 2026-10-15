// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { useLocalWorldCapture } from "./useLocalWorldCapture";
const checked = parseRecording(raw); if (!checked.ok) throw new Error("fixture"); const packet = checked.recording.case;
const camera = { mode: "first" as const, position: [0, 1.7, 0] as const, quaternion: [0, 0, 0, 1] as const, fov: 60 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("single-frame local capture route adapter", () => {
  it("does not start or sample on mount; uses the existing frame callback after explicit Start", () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useLocalWorldCapture(packet, "idle", false));
    act(() => { result.current.beforeFrame(); result.current.onCameraSample(camera); }); expect(result.current.snapshot.count).toBe(0);
    act(() => { result.current.controller.start(); }); expect(result.current.actorCapture?.scope).toMatch(/^local-world:/);
    now = 150; act(() => { result.current.beforeFrame(); result.current.onCameraSample(camera); });
    expect(result.current.localClock?.current).toBe(50); expect(result.current.controller.exportEvents().events[0]?.t_ms).toBe(50);
    expect(result.current.local?.exportRecording().ok).toBe(true);
  });
  it("freezes/stops on global pause and refuses live or historical capture with no auto-resume", () => {
    const { result, rerender } = renderHook(({ source, paused }: { source: "idle" | "live" | "recording"; paused: boolean }) => useLocalWorldCapture(packet, source, paused), { initialProps: { source: "idle", paused: false } });
    act(() => { result.current.controller.start(); }); const old = result.current.onCameraSample;
    rerender({ source: "recording", paused: false }); act(() => { old(camera); result.current.beforeFrame(); });
    expect(result.current.snapshot.status).toBe("stopped"); expect(result.current.snapshot.count).toBe(0); expect(result.current.actorCapture).toBeUndefined(); expect(result.current.localClock).toBeNull();
    rerender({ source: "live", paused: false }); act(() => { result.current.controller.start(); }); expect(result.current.snapshot.status).toBe("stopped");
    rerender({ source: "idle", paused: false }); expect(result.current.snapshot.status).toBe("stopped");
    act(() => { result.current.controller.start(); }); rerender({ source: "idle", paused: true }); expect(result.current.snapshot.status).toBe("stopped");
  });
  it("rejects old-scoped samples after Clear or packet replacement, and stays inert without a packet", () => {
    const { result, rerender } = renderHook<ReturnType<typeof useLocalWorldCapture>, typeof packet | null>((value) => useLocalWorldCapture(value, "idle", false), { initialProps: packet });
    act(() => { result.current.controller.start(); }); const old = result.current.onCameraSample;
    act(() => { result.current.controller.stop(); result.current.controller.clear(); result.current.controller.start(); });
    act(() => { old(camera); }); expect(result.current.snapshot.count).toBe(0);
    act(() => { result.current.onControlInput({ action: "key", key: "KeyW", pressed: true }); }); expect(result.current.snapshot.count).toBe(1);
    rerender(null); act(() => { result.current.onCameraSample(camera); result.current.beforeFrame(); }); expect(result.current.snapshot.count).toBe(0); expect(result.current.local).toBeNull();
  });
});
