// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import { WALK_SPEED } from "../../lib/precinct/movement";

const harness = vi.hoisted(() => ({ callbacks: new Set<(state: RootState, delta: number) => void>(), state: null as RootState | null }));
vi.mock("@react-three/fiber", async () => {
  const { useEffect } = await import("react");
  return { Canvas: () => null, useLoader: vi.fn(),
    useThree: (select: (state: RootState) => unknown) => { if (harness.state === null) throw new Error("Missing scene"); return select(harness.state); },
    useFrame: (callback: (state: RootState, delta: number) => void) => {
      useEffect(() => { harness.callbacks.add(callback); return () => { harness.callbacks.delete(callback); }; }, [callback]);
    } };
});
vi.mock("./WalkingAvatar", () => ({ WalkingAvatar: () => null }));
vi.mock("./PrecinctStaff", () => ({ PrecinctStaff: () => null }));
vi.mock("./PrecinctInterviewCast", () => ({ PrecinctInterviewCast: () => null }));
vi.mock("./ObservationWorkScreens", () => ({ ObservationWorkScreens: () => null }));
let canvas: HTMLCanvasElement, camera: PerspectiveCamera;
function tick(delta: number) {
  act(() => { if (harness.state === null) throw new Error("Missing scene"); for (const callback of harness.callbacks) callback(harness.state, delta); });
}
function props(): PrecinctCanvasProps {
  return { manifest: { colliders: [], hotspots: [], navigationNodes: [] }, active: true, paused: false, reducedMotion: false,
    cameraMode: "first", tier: "high", travel: { current: null }, onTierChange: vi.fn(), onPose: vi.fn(), onInteract: vi.fn(), onReady: vi.fn(),
    onBeforeFrame: vi.fn(), onCameraSample: vi.fn(), onControlInput: vi.fn() };
}
beforeEach(() => {
  canvas = document.createElement("canvas"); canvas.tabIndex = 0; document.body.append(canvas); camera = new PerspectiveCamera();
  harness.state = { gl: { domElement: canvas }, camera } as unknown as RootState;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => { /* DOM harness hosts R3F declarative mesh elements. */ });
});
afterEach(() => { cleanup(); canvas.remove(); harness.callbacks.clear(); harness.state = null; vi.restoreAllMocks(); });

/** Identical test source in both A/B overlays. The flag selects the asserted legacy expectation,
 * not the implementation: Controls is imported from the actual build under test above.
 * These controlled frame deltas test integration correctness, not browser-rendering FPS. */
const baseline = import.meta.env["VITE_ARENA_PERF_BASELINE"] === "1";
describe("one-second actual Controls movement evidence", () => {
  it.each([5, 10, 20, 30, 60])("reports straight walking and separate arrow rotation at %i Hz", (hz) => {
    const p = props(); render(<Controls {...p} />); tick(0);
    const before = camera.position.clone();
    fireEvent.keyDown(window, { code: "KeyW" });
    for (let frame = 0; frame < hz; frame += 1) tick(1 / hz);
    fireEvent.keyUp(window, { code: "KeyW" });
    const metres = camera.position.distanceTo(before);
    const beforeYaw = camera.rotation.y;
    fireEvent.keyDown(window, { code: "ArrowLeft" });
    for (let frame = 0; frame < hz; frame += 1) tick(1 / hz);
    fireEvent.keyUp(window, { code: "ArrowLeft" });
    const yawRadians = camera.rotation.y - beforeYaw;
    const fraction = baseline ? Math.min(1, hz * 0.05) : 1;
    expect(WALK_SPEED).toBe(2.4);
    expect(metres).toBeCloseTo(WALK_SPEED * fraction, 9);
    expect(yawRadians).toBeCloseTo(1.7 * fraction, 9);
    expect(harness.callbacks.size).toBe(1);
    console.info("ARENA_MOVEMENT_EVIDENCE", JSON.stringify({ variant: baseline ? "instrumentation-only-baseline" : "optimized-candidate",
      hz, simulatedSecondsPerPhase: 1, measuredStraightWalkingMetres: metres, measuredSeparateYawRadians: yawRadians,
      expectedWalkSpeedMetresPerSecond: WALK_SPEED, combinedTurnAndWalkPathInvarianceMeasured: false }));
  });
});
