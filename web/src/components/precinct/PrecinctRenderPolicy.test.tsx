// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { precinctDiagnosticsEnabled, usePrecinctDpr } from "./PrecinctRenderPolicy";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
describe("viewport-constrained DPR", () => {
  it("updates Canvas's stable DPR after viewport changes", () => {
    vi.stubGlobal("devicePixelRatio", 2); vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
    const hook = renderHook(() => usePrecinctDpr("high")); expect(hook.result.current).toBe(1.75);
    act(() => { vi.stubGlobal("innerWidth", 3840); vi.stubGlobal("innerHeight", 2160); window.dispatchEvent(new Event("resize")); });
    expect(3840 * 2160 * hook.result.current ** 2).toBeLessThanOrEqual(4_000_001);
  });
  it("requires an explicit diagnostic opt-in", () => {
    expect(precinctDiagnosticsEnabled()).toBe(false);
    window.history.replaceState(null, "", "/?precinctPerf=0"); expect(precinctDiagnosticsEnabled()).toBe(false);
    window.history.replaceState(null, "", "/?precinctPerf=1"); expect(precinctDiagnosticsEnabled()).toBe(true);
  });
});
