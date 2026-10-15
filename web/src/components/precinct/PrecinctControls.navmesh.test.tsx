// @vitest-environment jsdom
// Authored integration regressions; pending the exclusive QA slot.
import { act, cleanup, render } from "@testing-library/react";
import type { RootState } from "@react-three/fiber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { Controls, type PrecinctCanvasProps } from "./PrecinctCanvas";
import * as staffCrowd from "../../lib/precinct/staffCrowd";
import * as navigation from "../../lib/precinct/worldNavigation";
import { buildPrecinctNavmesh, canonicalNavmeshSource, type NavmeshSource } from "../../lib/precinct/precinctNavmesh";
import { navmeshDigest } from "../../test/navmesh-digest";

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

describe("actual Controls polygon planner integration", () => {
  const source: NavmeshSource = { bounds: { min: [-5, -6], max: [5, 5] }, floorY: 0, agentRadius: 0.28, colliders: [] };
  const mesh = async () => buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
  it("passes the validated player profile to the sole walking-command planner", async () => {
    const p = props(); const player = await mesh();
    const plan = vi.spyOn(navigation, "planNavigationRoute");
    const travel = { current: { position: [2, 0, -2.4] as const, yaw: 0, instant: false } as import("./sceneTypes").TravelCommand | null };
    const manifest = { ...p.manifest, playerNavigationMesh: player };
    render(<Controls {...p} manifest={manifest} travel={travel} />); tick();
    expect(plan).toHaveBeenCalledWith([0, 0, -2.4], [2, 0, -2.4], manifest, player);
    expect(travel.current).toBeNull();
  });
  it("does not move or use graph fallback for a mesh-unreachable click-to-walk command", async () => {
    const p = props(); const player = await mesh();
    const travel = { current: { position: [8, 0, -2.4] as const, yaw: 0, instant: false } as import("./sceneTypes").TravelCommand | null };
    render(<Controls {...p} manifest={{ ...p.manifest, playerNavigationMesh: player }} travel={travel} />);
    for (let frame = 0; frame < 8; frame += 1) tick();
    expect(camera.position.x).toBe(0); expect(camera.position.z).toBe(-2.4);
  });
  it("keeps captured v2 camera/root replay outside all live planning", async () => {
    const p = props(); const plan = vi.spyOn(navigation, "planNavigationRoute");
    const advance = vi.spyOn(staffCrowd, "advanceStaffCrowd"); const initial = staffCrowd.createStaffCrowd("high");
    const travel = { current: { position: [2, 0, -2.4] as const, yaw: 0, instant: false } as import("./sceneTypes").TravelCommand | null };
    render(<Controls {...p} manifest={{ ...p.manifest, playerNavigationMesh: await mesh() }} crowd={{ current: initial }} travel={travel}
      replayActors={new Map()} replayCamera={{ ownership: "recorded", sample: null }} />); tick();
    expect(plan).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(travel.current).toBeNull();
  });
});
