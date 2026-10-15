// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
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
    expect(camera.position.distanceTo(new Vector3(...INVESTIGATOR_EYES))).toBeLessThan(1e-10);
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

describe("recorded and free replay camera ownership", () => {
  it("holds recorded camera exactly while rejecting live movement, travel, interaction and capture", () => {
    const p = props(); const onActorSample = vi.fn();
    const recorded = { mode: "third", position: [3, 1.7, -12], quaternion: [0, 0, 0, 1], fov: 49 } as const;
    const { rerender, container } = render(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: recorded }} actorCapture={{ scope: "ignored", onActorSample }} />);
    tick(); expect(camera.position.toArray()).toEqual(recorded.position); expect(camera.fov).toBe(49);
    expect(harness.callbacks.size).toBe(1);
    expect(camera.quaternion.toArray()).toEqual(recorded.quaternion);
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "KeyE" });
    p.travel.current = { position: [0, 0, 0], yaw: 2, instant: true }; tick();
    expect(camera.position.toArray()).toEqual(recorded.position); expect(p.travel.current).toBeNull();
    expect(p.onPose).not.toHaveBeenCalled(); expect(p.onCameraSample).not.toHaveBeenCalled(); expect(p.onInteract).not.toHaveBeenCalled(); expect(onActorSample).not.toHaveBeenCalled();
    expect(container.querySelector("group")).toBeNull();
    const seek = { ...recorded, position: [9, 2, -16] as const, quaternion: [0, 1, 0, 0] as const };
    rerender(<Controls {...p} paused replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: seek }} />); tick(10);
    expect(camera.position.toArray()).toEqual(seek.position); expect(camera.quaternion.toArray()).toEqual(seek.quaternion);
    rerender(<Controls {...p} paused replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: { ...seek, quaternion: [0, 0, 0, 0] } }} />); tick();
    expect(camera.quaternion.toArray()).toEqual(seek.quaternion);
    rerender(<Controls {...p} />); tick();
    expect(camera.position.toArray()).toEqual([0, 1.65, -2.4]);
  });
  it("lets explicit free viewing own only the display camera without replayed input or actor state", () => {
    const p = props(); const recorded = { mode: "first", position: [8, 1.5, -12], quaternion: [0, 0, 0, 1], fov: 52 } as const;
    const { rerender } = render(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: recorded }} />); tick();
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: recorded }} />); tick();
    const before = camera.position.clone(); fireEvent.keyDown(window, { code: "ArrowRight" }); tick();
    expect(camera.position.toArray()).not.toEqual(before.toArray());
    // New replay map/sample does not clear held viewer controls or replace the explicitly owned free view.
    const moved = camera.position.clone();
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: { ...recorded, position: [0, 0, 0] } }} />); tick();
    expect(camera.position.toArray()).not.toEqual(moved.toArray());
    expect(p.onPose).not.toHaveBeenCalled(); expect(p.onCameraSample).not.toHaveBeenCalled();
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: recorded }} />); tick();
    expect(camera.position.toArray()).toEqual(recorded.position);
    // Returning to free viewing starts from the latest actual view with no stale held inspection keys.
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: recorded }} />); tick();
    const restored = camera.position.clone(); tick(); expect(camera.position.distanceTo(restored)).toBeLessThan(1e-10);
  });
  it("keeps an invisible first-person walking rig only during explicit capture", () => {
    const p = props(); const { container, rerender } = render(<Controls {...p} />);
    expect(container.querySelector("group")).toBeNull();
    rerender(<Controls {...p} actorCapture={{ scope: "a", onActorSample: vi.fn() }} />);
    expect(container.querySelector("group")).not.toBeNull();
    rerender(<Controls {...p} actorCapture={{ scope: "a", onActorSample: vi.fn() }} interview={interview} />);
    expect(container.querySelector("group")).toBeNull();
  });
});

describe("local canonical clock and accepted-control seams", () => {
  it("ticks canonical presentation before samples and still ticks during replay without capturing camera", () => {
    const order: string[] = []; const p = props();
    const before = vi.fn(() => { order.push("clock"); });
    const sample = vi.fn(() => { order.push("camera"); });
    const { rerender } = render(<Controls {...p} onBeforeFrame={before} onCameraSample={sample} />); tick(0.1);
    expect(order).toEqual(["clock", "camera"]); expect(before).toHaveBeenLastCalledWith(0.1);
    tick(Infinity); expect(before).toHaveBeenLastCalledWith(0); tick(-1); expect(before).toHaveBeenLastCalledWith(0);
    const count = before.mock.calls.length;
    rerender(<Controls {...p} replayActors={new Map()} onBeforeFrame={before} onCameraSample={sample} />); tick();
    expect(before).toHaveBeenCalledTimes(count + 1);
    expect(before).toHaveBeenLastCalledWith(0.1);
  });
  it("records only accepted held controls, deduplicates repeats, and releases on native focus", () => {
    const p = props(); const input = vi.fn(); const { rerender } = render(<Controls {...p} onControlInput={input} />); tick();
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "KeyW", repeat: true });
    expect(input).toHaveBeenCalledTimes(1); expect(input).toHaveBeenLastCalledWith({ action: "key", key: "KeyW", pressed: true });
    const text = document.createElement("textarea"); document.body.append(text); text.focus();
    expect(input).toHaveBeenLastCalledWith({ action: "key", key: "KeyW", pressed: false });
    fireEvent.keyDown(text, { code: "KeyD" }); fireEvent.keyUp(text, { code: "KeyD" });
    fireEvent.keyUp(window, { code: "KeyW" }); expect(input).toHaveBeenCalledTimes(2);
    text.remove(); canvas.focus();
    fireEvent.keyDown(window, { code: "KeyS" }); fireEvent.keyUp(window, { code: "KeyS" });
    expect(input).toHaveBeenLastCalledWith({ action: "key", key: "KeyS", pressed: false });
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: null }} onControlInput={input} />); tick();
    const count = input.mock.calls.length; fireEvent.keyDown(window, { code: "ArrowRight" }); fireEvent.keyUp(window, { code: "ArrowRight" });
    expect(input).toHaveBeenCalledTimes(count);
  });
  it("rejects paused, seated and inactive movement capture", () => {
    const p = props(); const input = vi.fn(); const { rerender } = render(<Controls {...p} paused onControlInput={input} />);
    fireEvent.keyDown(window, { code: "KeyW" }); expect(input).not.toHaveBeenCalled();
    rerender(<Controls {...p} interview={interview} onControlInput={input} />);
    fireEvent.keyDown(window, { code: "KeyW" }); expect(input).not.toHaveBeenCalled();
    rerender(<Controls {...p} active={false} onControlInput={input} />);
    fireEvent.keyDown(window, { code: "KeyW" }); expect(input).not.toHaveBeenCalled();
  });
});

it("keeps accepted key release with its original scope callback and captures accepted pointer-look only", () => {
  const p = props(); const old = vi.fn(); const next = vi.fn();
  const { rerender } = render(<Controls {...p} onControlInput={old} />); tick();
  fireEvent.keyDown(window, { code: "KeyA" });
  rerender(<Controls {...p} onControlInput={next} />);
  fireEvent.keyUp(window, { code: "KeyA" });
  expect(old).toHaveBeenLastCalledWith({ action: "key", key: "KeyA", pressed: false }); expect(next).not.toHaveBeenCalled();
  fireEvent.mouseDown(canvas, { button: 2 });
  expect(next).toHaveBeenLastCalledWith({ action: "click", target: "precinct:look", button: 2 });
  const count = next.mock.calls.length;
  rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: null }} onControlInput={next} />); tick();
  fireEvent.mouseDown(canvas, { button: 2 }); expect(next).toHaveBeenCalledTimes(count);
});

describe("independent free inspection", () => {
  it("pans and raises beyond the seat without moving the trainee, emitting capture input, or opening stations", () => {
    const p = props(); const input = vi.fn(); p.travel.current = { position: [5.7, 0, -12.5], yaw: 0.8, instant: true };
    const { rerender } = render(<Controls {...p} onControlInput={input} />); tick();
    const exploration = camera.position.clone(); const explorationRotation = camera.quaternion.clone();
    rerender(<Controls {...p} interview={interview} onControlInput={input} />); tick();
    const seat = camera.position.clone();
    rerender(<Controls {...p} interview={interview} paused cameraMode="free" onControlInput={input} />); tick();
    expect(camera.position.distanceTo(seat)).toBeLessThan(1e-10);
    const sample = vi.mocked(p.onCameraSample ?? vi.fn<(value: PrecinctCameraSample) => void>());
    const captured = sample.mock.calls.length; const poseCount = vi.mocked(p.onPose).mock.calls.length;
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "KeyD" }); fireEvent.keyDown(window, { code: "KeyE" }); fireEvent.keyDown(window, { code: "ShiftLeft" });
    for (let frame = 0; frame < 30; frame += 1) tick(0.05);
    expect(camera.position.distanceTo(seat)).toBeGreaterThan(4); expect(camera.position.y).toBeCloseTo(3.1);
    expect(input).not.toHaveBeenCalled(); expect(p.onInteract).not.toHaveBeenCalled(); expect(sample).toHaveBeenCalledTimes(captured); expect(p.onPose).toHaveBeenCalledTimes(poseCount);
    const text = document.createElement("textarea"); document.body.append(text); text.focus(); const held = camera.position.clone();
    fireEvent.keyDown(text, { code: "KeyQ" }); tick(); expect(camera.position.distanceTo(held)).toBeLessThan(1e-10); text.remove();
    rerender(<Controls {...p} interview={interview} onControlInput={input} />); tick();
    expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    rerender(<Controls {...p} interview={{ ...interview, seated: false }} onControlInput={input} />); tick();
    expect(camera.position.toArray()).toEqual(exploration.toArray()); expect(camera.quaternion.toArray()).toEqual(explorationRotation.toArray());
  });
  it("uses mocked gamepad pan/orbit/height and restores the latest recorded camera without changing samples", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "getGamepads");
    const buttons = Array.from({ length: 11 }, (_, index) => ({ pressed: index === 5 || index === 10, touched: false, value: index === 5 || index === 10 ? 1 : 0 }));
    const pad = { connected: true, axes: [0.8, -0.7, 0.3, -0.2], buttons } as unknown as Gamepad;
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [pad] });
    try {
      const p = props(); const input = vi.fn(); const recorded = { mode: "first", position: [8, 1.5, -12], quaternion: [0, 0, 0, 1], fov: 52 } as const;
      const { rerender } = render(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: recorded }} onControlInput={input} />); tick();
      rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample: recorded }} onControlInput={input} />);
      for (let frame = 0; frame < 10; frame += 1) tick(0.05);
      expect(camera.position.x).not.toBe(8); expect(camera.position.y).toBeGreaterThan(1.5); expect(camera.quaternion.toArray()).not.toEqual(recorded.quaternion);
      expect(input).not.toHaveBeenCalled(); expect(p.onPose).not.toHaveBeenCalled(); expect(p.onCameraSample).not.toHaveBeenCalled();
      const latest = { ...recorded, position: [9, 1.8, -15] as const };
      rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: latest }} onControlInput={input} />); tick();
      expect(camera.position.toArray()).toEqual(latest.position); expect(camera.quaternion.toArray()).toEqual(latest.quaternion); expect(recorded.position).toEqual([8, 1.5, -12]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, "getGamepads"); else Object.defineProperty(navigator, "getGamepads", original);
    }
  });
  it("supports pointer orbit and wheel zoom while guarding inactive and native-dialog focus", () => {
    const p = props(); const sample = { mode: "first", position: [8, 1.5, -12], quaternion: [0, 0, 0, 1], fov: 52 } as const;
    const { rerender } = render(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample }} />); tick();
    rerender(<Controls {...p} replayActors={new Map()} replayCamera={{ ownership: "free", sample }} />); tick();
    const before = camera.position.clone();
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 }); fireEvent.mouseMove(document, { clientX: 140, clientY: 110 }); fireEvent.mouseUp(window); tick();
    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.1);
    const orbit = camera.position.clone(); fireEvent.wheel(canvas, { deltaY: -100 }); tick(); expect(camera.position.distanceTo(orbit)).toBeGreaterThan(0.1);
    const held = camera.position.clone();
    const text = document.createElement("textarea"); document.body.append(text); text.focus();
    fireEvent.wheel(canvas, { deltaY: 100 }); fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 }); fireEvent.mouseMove(document, { clientX: 160, clientY: 120 }); tick();
    expect(camera.position.distanceTo(held)).toBeLessThan(1e-10); expect(document.activeElement).toBe(text); text.remove();
    rerender(<Controls {...p} active={false} replayActors={new Map()} replayCamera={{ ownership: "free", sample }} />); tick();
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.wheel(canvas, { deltaY: 100 }); tick(); expect(camera.position.distanceTo(held)).toBeLessThan(1e-10);
  });
});
