// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene } from "three";

const mock = vi.hoisted(() => ({ frames: [] as (() => void)[], after: null as (() => void) | null,
  get: vi.fn(), renderer: vi.fn(), scene: vi.fn() }));
vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: () => void) => { mock.frames.push(callback); },
  useThree: (select: (state: { get: typeof mock.get }) => unknown) => select({ get: mock.get }),
  addAfterEffect: (callback: () => void) => { mock.after = callback; return () => { mock.after = null; }; },
}));
vi.mock("./inspectPrecinctRenderer", () => ({ inspectPrecinctRenderer: mock.renderer, inspectPrecinctScene: mock.scene }));

import { PrecinctPerformanceProbe } from "./PrecinctPerformanceProbe";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mock.frames = []; delete window.__arenaPrecinctPerformance; });

describe("opt-in precinct render probe", () => {
  it("samples only after actual render callbacks, keeps inputs private, and cleans up", () => {
    const canvas = document.createElement("canvas"); canvas.tabIndex = 0; canvas.width = 400; canvas.height = 300; document.body.append(canvas);
    const gl = { domElement: canvas, getPixelRatio: () => 1.25, info: { render: { calls: 75, triangles: 200_000 } } };
    const state = { gl, camera: new PerspectiveCamera(), scene: new Scene() };
    mock.get.mockReturnValue(state); mock.renderer.mockReturnValue({ softwareRenderer: true }); mock.scene.mockReturnValue({ meshes: 12 });
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const view = render(<PrecinctPerformanceProbe tier="medium" continuous sceneAsset="/world/precinct.glb" />);
    const api = window.__arenaPrecinctPerformance;
    expect(api).toBeDefined(); if (api === undefined) throw new Error("Probe missing");
    expect(api.status()).toMatchObject({ active: false, tier: "medium", drawingBuffer: { width: 400, height: 300 } });
    api.start(); now = 10; mock.after?.(); expect(api.snapshot().framesRendered).toBe(0);
    canvas.focus(); window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "PRIVATE_TEXT" }));
    now = 12; mock.frames[0]?.(); now = 15; mock.after?.();
    now = 30; mock.frames[0]?.(); now = 32; mock.after?.(); mock.after?.();
    const report = api.stop();
    expect(report.framesRendered).toBe(2); expect(report.frameIntervalMs.p50).toBe(17); expect(report.drawCalls.p50).toBe(75);
    expect(report.cpuFrameAndRenderSubmissionMs.p95).toBe(3); expect(report.inputToRenderSubmissionMs.p50).toBe(5);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_TEXT"); expect(report.gpuFrameMs).toBeNull();
    now = 40; mock.frames[0]?.(); mock.after?.(); expect(api.snapshot().framesRendered).toBe(2);
    act(() => { view.unmount(); }); expect(window.__arenaPrecinctPerformance).toBeUndefined(); expect(mock.after).toBeNull(); canvas.remove();
  });
  it("records supported browser observers, flushes pending entries and excludes pre-start events", () => {
    const canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.append(canvas);
    mock.get.mockReturnValue({ gl: { domElement: canvas, getPixelRatio: () => 1, info: { render: { calls: 1, triangles: 12 } } }, camera: new PerspectiveCamera(), scene: new Scene() });
    const instances: Observer[] = [];
    class Observer {
      static supportedEntryTypes = ["longtask", "event"];
      entries: PerformanceEntry[] = [];
      constructor() { instances.push(this); }
      observe() { /* The browser supplies queued entries below. */ }
      disconnect() { /* Cleanup observed separately by probe lifecycle. */ }
      takeRecords(): PerformanceEntry[] { return this.entries.splice(0); }
    }
    vi.stubGlobal("PerformanceObserver", Observer);
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<PrecinctPerformanceProbe tier="low" continuous sceneAsset="/world/precinct.glb" />);
    const api = window.__arenaPrecinctPerformance; if (api === undefined) throw new Error("Probe missing");
    api.start();
    instances[0]?.entries.push({ entryType: "longtask", name: "self", startTime: 120, duration: 70 } as PerformanceEntry);
    instances[0]?.entries.push({ entryType: "longtask", name: "self", startTime: 90, duration: 90 } as PerformanceEntry);
    instances[1]?.entries.push({ entryType: "event", name: "keydown", startTime: 120, duration: 24, target: canvas } as unknown as PerformanceEntry);
    instances[1]?.entries.push({ entryType: "event", name: "keydown", startTime: 120, duration: 80, target: document.body } as unknown as PerformanceEntry);
    now = 200; const report = api.stop();
    expect(report.observers).toEqual({ longtask: true, event: true }); expect(report.longTaskMs).toMatchObject({ samples: 1, p50: 70 });
    expect(report.eventTimingDurationMs).toMatchObject({ samples: 1, p50: 24 }); canvas.remove();
  });
  it("reports observer setup failures rather than breaking the scene or inventing zero latency", () => {
    const canvas = document.createElement("canvas");
    mock.get.mockReturnValue({ gl: { domElement: canvas }, camera: new PerspectiveCamera(), scene: new Scene() });
    class Observer {
      static supportedEntryTypes = ["longtask", "event"];
      observe() { throw new Error("Unsupported observer options"); }
      disconnect() { /* No entries were observed. */ }
    }
    vi.stubGlobal("PerformanceObserver", Observer);
    render(<PrecinctPerformanceProbe tier="low" continuous sceneAsset="/world/precinct.glb" />);
    const report = window.__arenaPrecinctPerformance?.snapshot();
    expect(report?.observers).toEqual({ longtask: false, event: false }); expect(report?.eventTimingDurationMs.p50).toBeNull();
    expect(report?.measurementNotes.join(" ")).toContain("Unsupported observer options");
  });
});
