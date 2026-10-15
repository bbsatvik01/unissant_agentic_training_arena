// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { deriveAgentWork } from "../../lib/agent-work/model";
import { INVESTIGATOR_EYES, INVESTIGATOR_SEAT } from "../../lib/precinct/interviewStage";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import type { PrecinctCameraSample, PrecinctInterviewScene } from "./interviewScene";
import type { TravelCommand } from "./sceneTypes";

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

const work = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: false, reducedMotion: false });
const interview: PrecinctInterviewScene = { cast: null, subjectName: "Jordan", clock: { current: 0 }, work, present: true, seated: true, location: "interview" };
let canvas: HTMLCanvasElement;
let camera: PerspectiveCamera;
function tick(delta = 0.1) {
  act(() => { if (harness.state === null) throw new Error("Missing scene"); for (const callback of harness.callbacks) callback(harness.state, delta); });
}
function props(): PrecinctCanvasProps {
  return { manifest: { colliders: [], hotspots: [], navigationNodes: [] }, active: true, paused: false, reducedMotion: false,
    cameraMode: "first", tier: "low", travel: { current: null as TravelCommand | null }, onTierChange: vi.fn(), onPose: vi.fn(), onInteract: vi.fn(), onReady: vi.fn(), onCameraSample: vi.fn() };
}
beforeEach(() => {
  canvas = document.createElement("canvas"); document.body.append(canvas); camera = new PerspectiveCamera();
  harness.state = { gl: { domElement: canvas }, camera } as unknown as RootState;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  // These tests mount R3F's declarative elements in a DOM harness, not a WebGL renderer.
  vi.spyOn(console, "error").mockImplementation(() => { /* React's unknown mesh/material DOM warnings are expected here. */ });
});
afterEach(() => { cleanup(); canvas.remove(); harness.callbacks.clear(); harness.state = null; vi.restoreAllMocks(); });

describe("single camera and seated input ownership", () => {
  it("stops queued walks, clears held inputs and commands, and restores the exact pre-seat exploration pose", () => {
    const p = props(); p.travel.current = { position: [5.7, 0, -12.5], yaw: 0.8, instant: true };
    const { rerender, container } = render(<Controls {...p} />); tick();
    fireEvent.keyDown(window, { code: "KeyW" }); tick();
    const before = camera.position.clone(); const rotation = camera.quaternion.clone();
    p.travel.current = { position: [8, 0, -12], yaw: 1, instant: false };
    rerender(<Controls {...p} interview={interview} />); tick();
    expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    expect(p.travel.current).toBeNull();
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ position: INVESTIGATOR_SEAT.position, speed: 0, hotspot: null }));
    fireEvent.keyDown(window, { code: "KeyW" });
    const floor = container.querySelector("mesh"); if (floor === null) throw new Error("Missing floor interaction plane");
    fireEvent.pointerDown(floor, { button: 0 });
    p.travel.current = { position: [0, 0, 0], yaw: 0, instant: true }; tick();
    expect(p.travel.current).toBeNull(); expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    rerender(<Controls {...p} interview={{ ...interview, seated: false }} />); tick(); tick();
    expect(camera.position.toArray()).toEqual(before.toArray()); expect(camera.quaternion.toArray()).toEqual(rotation.toArray());
  });
  it("hides the walking body while seated and allows free inspection only while paused", () => {
    const p = props(); const { rerender, container } = render(<Controls {...p} cameraMode="third" />);
    expect(container.querySelector("group")).not.toBeNull();
    rerender(<Controls {...p} interview={interview} cameraMode="third" />); tick();
    expect(camera.position.toArray()).toEqual([7.64, 1.73, -11.02]);
    expect(container.querySelector("group")).toBeNull();
    rerender(<Controls {...p} interview={interview} cameraMode="free" />); tick();
    expect(container.querySelector("group")).toBeNull(); expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    rerender(<Controls {...p} interview={interview} cameraMode="free" paused />); tick();
    expect(camera.position.toArray()).not.toEqual(INVESTIGATOR_EYES);
    const inspected = camera.position.clone(); fireEvent.keyDown(window, { code: "ArrowRight" }); tick();
    expect(camera.position.toArray()).not.toEqual(inspected.toArray());
    rerender(<Controls {...p} interview={interview} cameraMode="free" />); tick();
    expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    expect(p.onCameraSample).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "first", fov: 52 }));
  });
  it("does not steal a native form/dialog focus and emits only actual camera fields", () => {
    const input = document.createElement("textarea"); document.body.append(input); input.focus();
    const p = props(); render(<Controls {...p} interview={interview} />); tick();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { code: "KeyW" }); tick();
    expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    const callback = vi.mocked(p.onCameraSample ?? vi.fn<(sample: PrecinctCameraSample) => void>());
    const sample = callback.mock.calls.at(-1)?.[0];
    expect(Object.keys(sample ?? {}).sort()).toEqual(["fov", "mode", "position", "quaternion"]);
    expect(Math.hypot(...(sample?.quaternion ?? []))).toBeCloseTo(1);
    expect(sample?.position).toEqual(camera.position.toArray()); input.remove();
  });
});
