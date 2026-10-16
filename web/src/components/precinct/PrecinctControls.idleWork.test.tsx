// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import { PLAYER_RADIUS } from "../../lib/precinct/movement";
import * as movement from "../../lib/precinct/movement";
import * as staffCrowd from "../../lib/precinct/staffCrowd";
import * as crowdNavigation from "../../lib/precinct/crowdNavigation";
import { deriveAgentWork } from "../../lib/agent-work/model";
import { INVESTIGATOR_SEAT } from "../../lib/precinct/interviewStage";
import { STAFF_RADIUS } from "../../lib/precinct/staff";
import type { PrecinctInterviewScene } from "./interviewScene";

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

/** Run this identical harness against the frozen candidate and the separate proposed patch.
 * The flag changes assertions only. Counts are work/churn evidence, never browser FPS. */
const baseline = import.meta.env["VITE_ARENA_IDLE_WORK_BASELINE"] === "1";
const station = { id: "station", label: "Station", room: "lobby", position: [0, 0, -2.4] as const, radius: 2 };
const distant = { ...station, id: "distant", position: [0, 0, -8] as const };
const interview: PrecinctInterviewScene = { cast: null, subjectName: "Jordan", clock: { current: 0 },
  work: deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: false, reducedMotion: false }),
  present: true, seated: true, location: "interview" };

describe("stationary hotspot work and exact-coordinate pose publication", () => {
  it("counts unchanged-position visibility work, without suppressing initial pose publication", () => {
    const p = props(); const manifest = { ...p.manifest, hotspots: [station, distant] };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); render(<Controls {...p} manifest={manifest} />); tick(0);
    lineOfSight.mockClear();
    for (let i = 0; i < 100; i += 1) tick(0.01);
    const hotspotChecks = lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02).length;
    expect(hotspotChecks).toBe(baseline ? 200 : 0); expect(p.onPose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.onPose).mock.calls[0]?.[0].hotspot).toBe("station");
    console.info("ARENA_IDLE_WORK_EVIDENCE", JSON.stringify({ baseline, frames: 100, hotspotChecks, poseEmissions: vi.mocked(p.onPose).mock.calls.length }));
  });
  it("counts redundant blocked-walk emissions while retaining every camera/capture cadence", () => {
    const p = props(); const wall = { id: "contact-wall", min: [-5, 0, -3.5] as const, max: [5, 3, -2.4 - PLAYER_RADIUS] as const };
    render(<Controls {...p} manifest={{ ...p.manifest, colliders: [wall] }} />);
    tick(0); fireEvent.keyDown(window, { code: "KeyW" }); tick(0.05); tick(0.05);
    const before = camera.position.clone(); vi.clearAllMocks();
    for (let i = 0; i < 20; i += 1) tick(0.05);
    fireEvent.keyUp(window, { code: "KeyW" });
    expect(camera.position.distanceTo(before)).toBe(0);
    expect(p.onPose).toHaveBeenCalledTimes(baseline ? 10 : 0);
    expect(p.onCameraSample).toHaveBeenCalledTimes(10); expect(p.onBeforeFrame).toHaveBeenCalledTimes(20);
    console.info("ARENA_BLOCKED_POSE_EVIDENCE", JSON.stringify({ baseline, frames: 20, poseEmissions: vi.mocked(p.onPose).mock.calls.length,
      cameraSamples: vi.mocked(p.onCameraSample ?? vi.fn()).mock.calls.length, captureFrameCalls: vi.mocked(p.onBeforeFrame ?? vi.fn()).mock.calls.length }));
  });
  it("invalidates visibility on real position or manifest changes and still publishes yaw changes", () => {
    const p = props(); const manifest = { ...p.manifest, hotspots: [station, distant] };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const view = render(<Controls {...p} manifest={manifest} />); tick(0.1);
    lineOfSight.mockClear(); fireEvent.keyDown(window, { code: "ArrowLeft" }); tick(0.1); fireEvent.keyUp(window, { code: "ArrowLeft" });
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    expect(vi.mocked(p.onPose).mock.calls.at(-1)?.[0].yaw).toBeGreaterThan(0);
    lineOfSight.mockClear(); fireEvent.keyDown(window, { code: "KeyW" }); tick(0.1); fireEvent.keyUp(window, { code: "KeyW" });
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
    lineOfSight.mockClear();
    view.rerender(<Controls {...p} manifest={{ ...manifest, hotspots: [{ ...station, id: "replacement" }, distant] }} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
    expect(vi.mocked(p.onPose).mock.calls.at(-1)?.[0].hotspot).toBe("replacement");
  });
  it("uses exact XYZ values rather than tuple identity and keeps tier-only changes out of the visibility key", () => {
    const p = props(); const manifest = { ...p.manifest, hotspots: [station, distant] };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const view = render(<Controls {...p} manifest={manifest} />); tick(0.1);
    lineOfSight.mockClear(); vi.mocked(p.onPose).mockClear();
    p.travel.current = { position: [0, 0, -2.4], yaw: 0, instant: true }; tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    expect(p.onPose).toHaveBeenCalledTimes(baseline ? 1 : 0);
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={manifest} tier="low" />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    for (const position of [[0, 0.5, -2.4], [0.5, 0.5, -2.4], [0.5, 0.5, -2.9]] as const) {
      lineOfSight.mockClear(); p.travel.current = { position, yaw: 0, instant: true }; tick(0.1);
      expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
      expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ position, hotspot: "station" }));
    }
  });
  it("invalidates for collider replacement at the same position and clears an obstructed interaction", () => {
    const p = props(); const near = { ...station, position: [0, 0, -3.4] as const };
    const manifest = { ...p.manifest, hotspots: [near, distant] };
    const wall = { id: "new-wall", min: [-0.25, 0, -3.1] as const, max: [0.25, 3, -2.9] as const };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const view = render(<Controls {...p} manifest={manifest} />); tick(0.1);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ hotspot: "station" }));
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={{ ...manifest, colliders: [wall] }} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ hotspot: null }));
    fireEvent.keyDown(window, { code: "KeyE" }); expect(p.onInteract).not.toHaveBeenCalled();
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={manifest} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ hotspot: "station" }));
  });
  it("withholds seated interaction and revalidates geometry changed while seated on exit", () => {
    const p = props(); const near = { ...station, position: [0, 0, -3.4] as const };
    const manifest = { ...p.manifest, hotspots: [near, distant] };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const view = render(<Controls {...p} manifest={manifest} />); tick(0.1);
    const exploration = camera.position.clone(); lineOfSight.mockClear();
    view.rerender(<Controls {...p} manifest={manifest} interview={interview} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ position: INVESTIGATOR_SEAT.position, hotspot: null }));
    fireEvent.keyDown(window, { code: "KeyE" }); expect(p.onInteract).not.toHaveBeenCalled();
    const changed = { ...manifest, colliders: [{ id: "seated-wall", min: [-0.25, 0, -3.1] as const, max: [0.25, 3, -2.9] as const }] };
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={changed} interview={interview} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={changed} interview={{ ...interview, seated: false }} />); tick(0.1);
    expect(camera.position.toArray()).toEqual(exploration.toArray());
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(2);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ position: [0, 0, -2.4], hotspot: null }));
  });
  it("restores the cached hotspot on seat exit when position and immutable geometry are unchanged", () => {
    const p = props(); const manifest = { ...p.manifest, hotspots: [station, distant] };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const view = render(<Controls {...p} manifest={manifest} />); tick(0.1);
    view.rerender(<Controls {...p} manifest={manifest} interview={interview} />); tick(0.1);
    lineOfSight.mockClear(); view.rerender(<Controls {...p} manifest={manifest} />); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 2 : 0);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ position: [0, 0, -2.4], hotspot: "station" }));
    fireEvent.keyDown(window, { code: "KeyE" }); expect(p.onInteract).toHaveBeenCalledExactlyOnceWith("station");
  });
});

describe("cached selection retains the actual nearest-visible semantics", () => {
  it("chooses a visible second-nearest hotspot behind an occluded nearest hotspot", () => {
    const p = props(); const wall = { id: "occluder", min: [-0.25, 0, -3.1] as const, max: [0.25, 3, -2.9] as const };
    const blocked = { ...station, id: "blocked", position: [0, 0, -3.4] as const };
    const visible = { ...station, id: "visible", position: [1.2, 0, -2.4] as const };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight");
    render(<Controls {...p} manifest={{ ...p.manifest, colliders: [wall], hotspots: [blocked, visible, distant] }} />); tick(0.1);
    expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ hotspot: "visible" }));
    lineOfSight.mockClear(); tick(0.1);
    expect(lineOfSight.mock.calls.filter(([, , , radius]) => radius === 0.02)).toHaveLength(baseline ? 3 : 0);
    fireEvent.keyDown(window, { code: "KeyE" }); expect(p.onInteract).toHaveBeenCalledExactlyOnceWith("visible");
  });
  it.each([false, true])("preserves manifest-order distance ties (reverse=%s)", (reverse) => {
    const p = props(); const first = { ...station, id: "left", position: [-1, 0, -2.4] as const };
    const second = { ...station, id: "right", position: [1, 0, -2.4] as const };
    render(<Controls {...p} manifest={{ ...p.manifest, hotspots: reverse ? [second, first] : [first, second] }} />); tick(0.1); tick(0.1);
    fireEvent.keyDown(window, { code: "KeyE" }); expect(p.onInteract).toHaveBeenCalledExactlyOnceWith(reverse ? "right" : "left");
  });
  it.each([
    { name: "inclusive outer boundary", x: 2, radius: 2, expected: "station" },
    { name: "just outside boundary", x: 2 + 1e-9, radius: 2, expected: null },
    { name: "zero-radius exact location", x: 0, radius: 0, expected: "station" },
    { name: "zero-radius different location", x: 1e-9, radius: 0, expected: null },
  ])("preserves $name", ({ x, radius, expected }) => {
    const p = props(); render(<Controls {...p} manifest={{ ...p.manifest, hotspots: [{ ...station, position: [x, 100, -2.4], radius }] }} />);
    tick(0.1); tick(0.1); expect(p.onPose).toHaveBeenLastCalledWith(expect.objectContaining({ hotspot: expected }));
    fireEvent.keyDown(window, { code: "KeyE" });
    if (expected === null) expect(p.onInteract).not.toHaveBeenCalled();
    else expect(p.onInteract).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

describe("retained crowd snapshots leave Controls timing and capture ownership intact", () => {
  it("keeps actual stationary-person collision active while reusing the crowd snapshot", () => {
    const p = props(); const authored = staffCrowd.createStaffCrowd("low");
    const initial = { agents: authored.agents.map((agent) => agent.id === "staff:receptionist"
      ? { ...agent, position: [0, 0.03, -3.2] as const } : agent) };
    const crowd = { current: initial };
    render(<Controls {...p} tier="low" crowd={crowd} />); tick(0); fireEvent.keyDown(window, { code: "KeyW" });
    for (let frame = 0; frame < 30; frame += 1) tick(0.05);
    fireEvent.keyUp(window, { code: "KeyW" });
    expect(camera.position.z).toBeLessThan(-2.4);
    expect(Math.hypot(camera.position.x, camera.position.z + 3.2)).toBeGreaterThanOrEqual(PLAYER_RADIUS + STAFF_RADIUS + crowdNavigation.CROWD_CLEARANCE - 1e-7);
    expect(crowd.current).toStrictEqual(initial); expect(crowd.current === initial).toBe(!baseline);
    expect(p.onBeforeFrame).toHaveBeenCalledTimes(31); expect(p.onCameraSample).toHaveBeenCalledTimes(15);
  });
  it("counts five adapter substeps but no stationary solver invocations in a stalled live frame", () => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("low"); const crowd = { current: initial };
    const order: string[] = []; const original = staffCrowd.advanceStaffCrowd;
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd").mockImplementation((...args) => { order.push("crowd"); return original(...args); });
    const step = vi.spyOn(crowdNavigation, "stepCrowd");
    render(<Controls {...p} tier="low" crowd={crowd} onBeforeFrame={(delta) => { order.push("clock"); p.onBeforeFrame?.(delta); }}
      onCameraSample={(sample) => { order.push("camera"); p.onCameraSample?.(sample); }} />); tick(1);
    expect(advance).toHaveBeenCalledTimes(5); expect(step).toHaveBeenCalledTimes(baseline ? 5 : 0);
    expect(order).toEqual(["clock", "crowd", "crowd", "crowd", "crowd", "crowd", "camera"]);
    expect(p.onBeforeFrame).toHaveBeenCalledExactlyOnceWith(1); expect(p.onCameraSample).toHaveBeenCalledTimes(1);
    expect(crowd.current).toStrictEqual(initial); if (!baseline) expect(crowd.current).toBe(initial);
    console.info("ARENA_IDLE_CROWD_CONTROLS_EVIDENCE", JSON.stringify({ baseline, rawFrameCalls: vi.mocked(p.onBeforeFrame ?? vi.fn()).mock.calls.length,
      adapterCalls: advance.mock.calls.length, solverCalls: step.mock.calls.length, cameraSamples: vi.mocked(p.onCameraSample ?? vi.fn()).mock.calls.length }));
  });
  it.each(["recorded", "free"] as const)("skips visibility and every crowd step in %s replay while preserving raw frame callbacks", (ownership) => {
    const p = props(); const initial = staffCrowd.createStaffCrowd("high"); const crowd = { current: initial };
    const lineOfSight = vi.spyOn(movement, "hasLineOfSight"); const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd");
    render(<Controls {...p} tier="low" crowd={crowd} manifest={{ ...p.manifest, hotspots: [station, distant] }}
      replayActors={new Map()} replayCamera={{ ownership, sample: null }} />);
    for (let frame = 0; frame < 20; frame += 1) tick(0.25);
    expect(lineOfSight).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(crowd.current).toBe(initial);
    expect(p.onBeforeFrame).toHaveBeenCalledTimes(20); expect(p.onCameraSample).not.toHaveBeenCalled(); expect(p.onPose).not.toHaveBeenCalled();
  });
});
