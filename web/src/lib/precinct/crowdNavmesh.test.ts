import { navmeshDigest } from "../../test/navmesh-digest";
import { describe, expect, it } from "vitest";
import { createCrowd, stepCrowd, type CrowdDefinition } from "./crowdNavigation";
import { buildPrecinctNavmesh, canonicalNavmeshSource, isPointOnNavmesh, type NavmeshSource } from "./precinctNavmesh";
import { advanceStaffCrowd, createStaffCrowd } from "./staffCrowd";
import { hasLineOfSight } from "./movement";

const SOURCE: NavmeshSource = { bounds: { min: [-5, -5], max: [5, 5] }, floorY: 0.03, agentRadius: 0.34, colliders: [] };
const build = async (source: NavmeshSource) => buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
const PERSON: CrowdDefinition = { id: "walker", position: [-3, 0.03, 0], yaw: 0, radius: 0.34, speed: 1,
  stops: [{ position: [3, 0.03, 0], waitSeconds: 1 }] };
const FRAME = { delta: 0.05, paused: false, reducedMotion: false };

describe("actual crowd polygon planner seam", () => {
  it("moves around a blocker through real portals and keeps each bounded chord safe", async () => {
    const source = { ...SOURCE, colliders: [{ id: "wall", min: [-0.5, 0, -2] as const, max: [0.5, 3, 2] as const }] };
    const mesh = await build(source); let state = createCrowd([PERSON]); let arrived = false;
    for (let frame = 0; frame < 350; frame += 1) {
      const previous = state.agents[0]?.position;
      state = stepCrowd(state, [PERSON], { colliders: source.colliders, navigationNodes: [], navigationMesh: mesh, people: [] }, FRAME);
      const current = state.agents[0]?.position;
      if (previous === undefined || current === undefined) throw new Error("Missing authored walker");
      expect(isPointOnNavmesh(current, mesh)).toBe(true);
      expect(hasLineOfSight(previous, current, source.colliders, 0.34)).toBe(true);
      arrived ||= Math.hypot(current[0] - 3, current[2]) < 0.1;
    }
    expect(arrived).toBe(true);
  });
  it("holds a mesh-unreachable goal even when the graph/direct planner could reach it", async () => {
    const outside = { ...PERSON, stops: [{ position: [6, 0.03, 0] as const, waitSeconds: 0 }] };
    const initial = createCrowd([outside]); const mesh = await build(SOURCE);
    const held = stepCrowd(initial, [outside], { colliders: [], navigationNodes: [], navigationMesh: mesh, people: [] }, FRAME);
    expect(held.agents[0]?.position).toEqual(PERSON.position);
    expect(held.agents[0]?.status).toBe("blocked");
    const fallback = stepCrowd(initial, [outside], { colliders: [], navigationNodes: [], people: [] }, FRAME);
    expect(fallback.agents[0]?.position).not.toEqual(PERSON.position);
  });
  it("never calls live navigation or reconciles actors for captured replay", async () => {
    const state = createStaffCrowd("high"); const mesh = await build(SOURCE);
    expect(advanceStaffCrowd(state, { colliders: [], navigationNodes: [], navigationMesh: mesh }, {
      ...FRAME, tier: "low", replay: true, playerPosition: [0, 0, 0],
    })).toBe(state);
  });
});
