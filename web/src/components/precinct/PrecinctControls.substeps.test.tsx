// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import * as staffCrowd from "../../lib/precinct/staffCrowd";
import * as navigation from "../../lib/precinct/worldNavigation";
import { PLAYER_RADIUS, SPRINT_SPEED, WALK_SPEED } from "../../lib/precinct/movement";
import { PATROL_SPEED, STAFF_RADIUS } from "../../lib/precinct/staff";
import { deriveAgentWork } from "../../lib/agent-work/model";
import { INVESTIGATOR_EYES } from "../../lib/precinct/interviewStage";

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
afterEach(() => { cleanup(); canvas.remove(); harness.callbacks.clear(); harness.state = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded substeps in the sole Controls frame callback", () => {
  it.each([5, 10, 20, 30, 60])("walks and turns for real elapsed time at %i Hz", (hz) => {
    const p = props(); render(<Controls {...p} />); tick(0); fireEvent.keyDown(window, { code: "KeyW" });
    for (let i = 0; i < hz; i += 1) tick(1 / hz);
    fireEvent.keyUp(window, { code: "KeyW" }); expect(camera.position.z).toBeCloseTo(-2.4 - WALK_SPEED, 9);
    fireEvent.keyDown(window, { code: "ArrowLeft" }); fireEvent.keyDown(window, { code: "ArrowUp" });
    for (let i = 0; i < hz; i += 1) tick(1 / hz);
    expect(camera.rotation.y).toBeCloseTo(1.7, 9); expect(camera.rotation.x).toBeCloseTo(1.3, 9);
    expect(harness.callbacks.size).toBe(1);
  });
  it.each([5, 10, 20, 30, 60])("keeps player path and ambient crowd elapsed time in sync at %i Hz", (hz) => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("high");
    const crowd = { current: { agents: initial.agents.map((agent) => ({ ...agent, waitRemaining: 0 })) } };
    p.travel.current = { position: [0, 0, -8], yaw: 0, instant: false };
    const plan = vi.spyOn(navigation, "planNavigationRoute");
    render(<Controls {...p} crowd={crowd} />);
    for (let i = 0; i < hz; i += 1) tick(1 / hz);
    expect(camera.position.z).toBeCloseTo(-2.4 - WALK_SPEED, 9);
    const playerPlans = plan.mock.calls.filter(([, destination]) => destination[0] === 0 && destination[2] === -8);
    expect(playerPlans).toHaveLength(1); expect(plan).toHaveBeenCalledTimes(2); // One trainee route plus one real patrol route.
    expect(p.travel.current).toBeNull();
    const patrol = crowd.current.agents.find((agent) => agent.id === "staff:patrol");
    expect(patrol?.walkedDistance).toBeCloseTo(PATROL_SPEED, 9);
    expect(patrol?.position[2]).toBeCloseTo(-14.6 - PATROL_SPEED, 9);
  });
  it("caps a 500 ms frame, drops backlog and publishes controls/camera/capture only once", () => {
    const p = props(); const crowd = { current: staffCrowd.createStaffCrowd("high") };
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd"); render(<Controls {...p} crowd={crowd} />); tick(0); vi.clearAllMocks();
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "KeyW", repeat: true });
    tick(0.5);
    expect(camera.position.z).toBeCloseTo(-2.4 - WALK_SPEED * 0.25, 9);
    expect(advance).toHaveBeenCalledTimes(5); expect(p.onBeforeFrame).toHaveBeenCalledExactlyOnceWith(0.5);
    expect(p.onControlInput).toHaveBeenCalledExactlyOnceWith({ action: "key", key: "KeyW", pressed: true });
    expect(p.onCameraSample).toHaveBeenCalledTimes(1); expect(p.onPose).toHaveBeenCalledTimes(1);
    tick(0.01); expect(camera.position.z).toBeCloseTo(-2.4 - WALK_SPEED * 0.26, 9); expect(advance).toHaveBeenCalledTimes(6);
    fireEvent.keyUp(window, { code: "KeyW" }); expect(p.onControlInput).toHaveBeenCalledTimes(2);
  });
  it("consumes controller and keyboard interaction edges once despite five substeps", () => {
    const p = props();
    const button = { pressed: false, touched: false, value: 0 };
    const pad = { connected: true, axes: [0, 0, 0, 0], buttons: [button] } as unknown as Gamepad;
    vi.stubGlobal("navigator", { getGamepads: () => [pad] });
    const manifest = { ...p.manifest, hotspots: [{ id: "station", label: "Station", room: "lobby", position: [0, 0, -2.4] as const, radius: 2 }] };
    const view = render(<Controls {...p} manifest={manifest} />); tick(0);
    button.pressed = true; tick(0.25); tick(0.25); expect(p.onInteract).toHaveBeenCalledExactlyOnceWith("station");
    view.rerender(<Controls {...p} manifest={manifest} paused />);
    button.pressed = false; tick(0.25); button.pressed = true; tick(0.25);
    view.rerender(<Controls {...p} manifest={manifest} />); tick(0.25);
    expect(p.onInteract).toHaveBeenCalledTimes(1);
    button.pressed = false; tick(0.25); button.pressed = true; tick(0.25); expect(p.onInteract).toHaveBeenCalledTimes(2);
    vi.mocked(p.onInteract).mockClear();
    fireEvent.keyDown(window, { code: "KeyE" }); fireEvent.keyDown(window, { code: "KeyE", repeat: true }); tick(0.25);
    expect(p.onInteract).toHaveBeenCalledExactlyOnceWith("station");
    fireEvent.keyUp(window, { code: "KeyE" }); fireEvent.keyDown(window, { code: "KeyE" }); tick(0.25);
    expect(p.onInteract).toHaveBeenCalledTimes(2);
  });
  it("preserves wall and swept-person collision during a slow sprint frame", () => {
    const p = props();
    const wall = { id: "thin-wall", min: [-5, 0, -3] as const, max: [5, 3, -2.9] as const };
    const view = render(<Controls {...p} manifest={{ ...p.manifest, colliders: [wall] }} />); tick(0);
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "ShiftLeft" }); tick(0.25);
    expect(camera.position.z).toBeGreaterThanOrEqual(-2.9 + PLAYER_RADIUS - 1e-7); expect(camera.position.z).toBeLessThan(-2.4);
    view.unmount();
    const initial = staffCrowd.createStaffCrowd("low");
    const crowd = { current: { agents: initial.agents.map((agent) => agent.id === "staff:receptionist" ? { ...agent, position: [0, 0.03, -3.2] as const } : agent) } };
    vi.spyOn(staffCrowd, "advanceStaffCrowd").mockImplementation((state) => state);
    render(<Controls {...p} tier="low" crowd={crowd} />); tick(0);
    fireEvent.keyDown(window, { code: "KeyW" }); fireEvent.keyDown(window, { code: "ShiftLeft" }); tick(0.25);
    expect(Math.hypot(camera.position.x, camera.position.z + 3.2)).toBeGreaterThanOrEqual(PLAYER_RADIUS + STAFF_RADIUS - 1e-7);
    expect(Math.abs(camera.position.z + 2.4)).toBeLessThan(SPRINT_SPEED * 0.25);
  });
  it("consumes null routes once and preserves arrival with multiple short waypoints", () => {
    const p = props(); const plan = vi.spyOn(navigation, "planNavigationRoute").mockReturnValue(null);
    p.travel.current = { position: [1, 0, -3.4], yaw: 0.8, instant: false };
    render(<Controls {...p} />); tick(0.2); expect(plan).toHaveBeenCalledTimes(1); expect(camera.position.z).toBe(-2.4);
    plan.mockReturnValue([[1, 0, -2.4], [1, 0, -3.4]]);
    p.travel.current = { position: [1, 0, -3.4], yaw: 0.8, instant: false };
    for (let i = 0; i < 10; i += 1) tick(0.2);
    expect(plan).toHaveBeenCalledTimes(2); expect(camera.position.x).toBeCloseTo(1, 9); expect(camera.position.z).toBeCloseTo(-3.4, 9);
    expect(camera.rotation.y).toBeCloseTo(0.8, 9);
  });
  it("keeps hidden, native-focus, inactive, paused, seated and recorded paths gated", () => {
    const p = props(); const crowd = { current: staffCrowd.createStaffCrowd("high") };
    const view = render(<Controls {...p} crowd={crowd} />); tick(0); fireEvent.keyDown(window, { code: "KeyW" });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true); fireEvent(document, new Event("visibilitychange")); tick(0.5);
    expect(camera.position.z).toBe(-2.4); hidden.mockReturnValue(false); fireEvent(document, new Event("visibilitychange")); tick(0.01); expect(camera.position.z).toBe(-2.4);
    const text = document.createElement("textarea"); document.body.append(text); text.focus(); fireEvent.keyDown(text, { code: "KeyW" }); tick(0.2); expect(camera.position.z).toBe(-2.4); text.remove();
    for (const change of [{ active: false }, { paused: true }]) {
      view.rerender(<Controls {...p} {...change} crowd={crowd} />); fireEvent.keyDown(window, { code: "KeyW" }); tick(0.5); expect(camera.position.z).toBe(-2.4);
    }
    const work = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: false, reducedMotion: false });
    view.rerender(<Controls {...p} interview={{ cast: null, subjectName: "Jordan", clock: { current: 0 }, work, present: true, seated: true, location: "interview" }} />);
    fireEvent.keyDown(window, { code: "KeyW" }); tick(0.5); expect(camera.position.toArray()).toEqual(INVESTIGATOR_EYES);
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd"); const plan = vi.spyOn(navigation, "planNavigationRoute");
    const sample = { mode: "first", position: [3, 1.7, -4], quaternion: [0, 0, 0, 1], fov: 50 } as const;
    view.rerender(<Controls {...p} crowd={crowd} replayActors={new Map()} replayCamera={{ ownership: "recorded", sample }} />); vi.clearAllMocks();
    fireEvent.keyDown(window, { code: "KeyW" }); tick(0.5);
    expect(camera.position.toArray()).toEqual(sample.position); expect(advance).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled();
    expect(p.onBeforeFrame).toHaveBeenCalledExactlyOnceWith(0.5); expect(p.onCameraSample).not.toHaveBeenCalled(); expect(p.onControlInput).not.toHaveBeenCalled();
  });
  it("keeps reduced-motion background actors still while user-controlled walking remains responsive", () => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("high"), crowd = { current: initial };
    render(<Controls {...p} reducedMotion crowd={crowd} />); tick(0); fireEvent.keyDown(window, { code: "KeyW" });
    for (let i = 0; i < 5; i += 1) tick(0.2);
    expect(camera.position.z).toBeCloseTo(-2.4 - WALK_SPEED, 9); expect(crowd.current).toBe(initial);
  });
});
