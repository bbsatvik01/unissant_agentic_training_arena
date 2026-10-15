// @vitest-environment jsdom
// Authored integration regressions; pending the exclusive QA slot.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import * as staffCrowd from "../../lib/precinct/staffCrowd";
import { PLAYER_RADIUS } from "../../lib/precinct/movement";
import { STAFF_RADIUS } from "../../lib/precinct/staff";
import type { CrowdState } from "../../lib/precinct/crowdNavigation";

const harness = vi.hoisted(() => ({ callbacks: new Set<(state: RootState, delta: number) => void>(), state: null as RootState | null }));
vi.mock("@react-three/fiber", async () => {
  const { useEffect } = await import("react");
  return {
    Canvas: () => null, useLoader: vi.fn(),
    useThree: (selector: (state: RootState) => unknown) => { if (harness.state === null) throw new Error("Missing scene"); return selector(harness.state); },
    useFrame: (callback: (state: RootState, delta: number) => void) => {
      useEffect(() => { harness.callbacks.add(callback); return () => { harness.callbacks.delete(callback); }; }, [callback]);
    },
  };
});
vi.mock("./WalkingAvatar", () => ({ WalkingAvatar: () => null }));
vi.mock("./PrecinctStaff", () => ({ PrecinctStaff: () => null }));
vi.mock("./PrecinctInterviewCast", () => ({ PrecinctInterviewCast: () => null }));
vi.mock("./ObservationWorkScreens", () => ({ ObservationWorkScreens: () => null }));
let canvas: HTMLCanvasElement;
let camera: PerspectiveCamera;
function tick(delta = 0.05) {
  act(() => { if (harness.state === null) throw new Error("Missing scene"); for (const callback of harness.callbacks) callback(harness.state, delta); });
}
function props(): PrecinctCanvasProps {
  return { manifest: { colliders: [], hotspots: [], navigationNodes: [] }, active: true, paused: false, reducedMotion: false,
    cameraMode: "first", tier: "high", travel: { current: null }, onTierChange: vi.fn(), onPose: vi.fn(), onInteract: vi.fn(), onReady: vi.fn() };
}
beforeEach(() => {
  canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.append(canvas); camera = new PerspectiveCamera();
  harness.state = { gl: { domElement: canvas }, camera } as unknown as RootState;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // Declarative R3F objects are hosted by the DOM harness; this is not WebGL evidence.
  vi.spyOn(console, "error").mockImplementation(() => { /* Expected unknown mesh/material DOM warnings. */ });
});
afterEach(() => { cleanup(); canvas.remove(); harness.callbacks.clear(); harness.state = null; vi.restoreAllMocks(); });

describe("one Controls-owned bounded live navigation frame", () => {
  it("runs bounded crowd substeps between one canonical clock tick and camera sample", () => {
    const p = props(); const order: string[] = []; const ref = { current: staffCrowd.createStaffCrowd(p.tier) };
    const original = staffCrowd.advanceStaffCrowd;
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd").mockImplementation((...args) => { order.push("crowd"); return original(...args); });
    render(<Controls {...p} crowd={ref} onBeforeFrame={() => { order.push("clock"); }} onCameraSample={() => { order.push("camera"); }} />);
    expect(harness.callbacks.size).toBe(1); tick(1);
    expect(order).toEqual(["clock", "crowd", "crowd", "crowd", "crowd", "crowd", "camera"]); expect(advance).toHaveBeenCalledTimes(5);
    expect(advance).toHaveBeenLastCalledWith(expect.anything(), p.manifest, expect.objectContaining({ delta: 0.05, replay: false, playerPosition: [0, 0, -2.4] }));
    tick(0.01); expect(advance).toHaveBeenCalledTimes(6); expect(harness.callbacks.size).toBe(1);
  });
  it("does not simulate or reconcile crowd in recorded or free replay, including a tier change", () => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("high"); const ref = { current: initial };
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd");
    const view = render(<Controls {...p} crowd={ref} tier="low" replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: null }} />);
    tick(5); expect(advance).not.toHaveBeenCalled(); expect(ref.current).toBe(initial);
    view.rerender(<Controls {...p} crowd={ref} tier="low" replayActors={new Map()} replayCamera={{ ownership: "free", sample: null }} />);
    tick(5); expect(advance).not.toHaveBeenCalled(); expect(ref.current).toBe(initial); expect(harness.callbacks.size).toBe(1);
  });
  it("freezes navigation during a dialog, actual pause and reduced motion without catch-up", () => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("high"); const ref = { current: initial };
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd");
    const view = render(<Controls {...p} crowd={ref} active={false} />); tick(10);
    expect(ref.current).toBe(initial); expect(advance).toHaveBeenLastCalledWith(initial, p.manifest, expect.objectContaining({ paused: true, delta: 0.05 }));
    view.rerender(<Controls {...p} crowd={ref} paused />); tick(10); expect(ref.current).toBe(initial);
    view.rerender(<Controls {...p} crowd={ref} reducedMotion />); tick(10); expect(ref.current).toBe(initial);
    view.rerender(<Controls {...p} crowd={ref} />); advance.mockClear(); tick(10);
    expect(advance).toHaveBeenCalledTimes(5);
    expect(advance).toHaveBeenNthCalledWith(1, initial, p.manifest, expect.objectContaining({ paused: false, reducedMotion: false, delta: 0.05 }));
    expect(ref.current.agents.find((agent) => agent.id === "staff:patrol")?.waitRemaining).toBeCloseTo(8.75);
  });
  it("uses the actual people sweep for player walking rather than crossing a stationary colleague", () => {
    const p = props(); const state = staffCrowd.createStaffCrowd("low");
    const ref: { current: CrowdState } = { current: { agents: state.agents.map((agent) => agent.id === "staff:receptionist" ? { ...agent, position: [0, 0.03, -3.2] as const } : agent) } };
    // Isolate the player-side integration; the unmocked solver has its separate geometry/traffic suite.
    vi.spyOn(staffCrowd, "advanceStaffCrowd").mockImplementation((current) => current);
    render(<Controls {...p} crowd={ref} tier="low" />); tick(); fireEvent.keyDown(window, { code: "KeyW" });
    for (let step = 0; step < 30; step += 1) tick();
    expect(camera.position.z).toBeLessThan(-2.4);
    expect(Math.hypot(camera.position.x, camera.position.z + 3.2)).toBeGreaterThanOrEqual(PLAYER_RADIUS + STAFF_RADIUS - 1e-7);
  });
});
