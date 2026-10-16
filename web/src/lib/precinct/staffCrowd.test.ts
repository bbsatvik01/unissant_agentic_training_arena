import { describe, expect, it } from "vitest";
import { advanceStaffCrowd, createStaffCrowd, staffCrowdDefinitions, staffCrowdPeople, type StaffCrowdFrame } from "./staffCrowd";
import { hasLineOfSight, isWalkable } from "./movement";
import { PATROL_SPEED, PATROL_STOPS, PRECINCT_STAFF, STAFF_RADIUS } from "./staff";
import type { CrowdWorld } from "./crowdNavigation";
import type { Vec3 } from "./types";
import manifestJson from "../../../public/world/precinct-manifest.json?raw";

const geometry = JSON.parse(manifestJson) as Pick<CrowdWorld, "colliders" | "navigationNodes">;
const FRAME: StaffCrowdFrame = { tier: "high", delta: 0.05, paused: false, reducedMotion: false, replay: false, playerPosition: [0, 0, -2.4] };

describe("ambient staff crowd seam", () => {
  it("keeps finite stable IDs and only the authored patrol moves", () => {
    const definitions = staffCrowdDefinitions("high");
    expect(definitions.map((definition) => definition.id)).toEqual(PRECINCT_STAFF.map((staff) => `staff:${staff.id}`));
    expect(definitions.filter((definition) => definition.speed > 0).map((definition) => definition.id)).toEqual(["staff:patrol"]);
    const patrol = definitions.find((definition) => definition.id === "staff:patrol");
    expect(patrol?.stops).toBe(PATROL_STOPS);
    expect(patrol?.speed).toBe(PATROL_SPEED);
    expect(staffCrowdDefinitions("low").map((definition) => definition.id)).toEqual(["staff:receptionist", "staff:sergeant"]);
  });

  it("skips all navigation in replay, including tier reconciliation", () => {
    const state = createStaffCrowd("high");
    expect(advanceStaffCrowd(state, geometry, { ...FRAME, tier: "low", replay: true })).toBe(state);
    expect(advanceStaffCrowd(state, geometry, { ...FRAME, paused: true })).toBe(state);
    expect(advanceStaffCrowd(state, geometry, { ...FRAME, reducedMotion: true })).toBe(state);
  });

  it("preserves surviving fixed people through tier changes and supplies collision footprints", () => {
    const initial = createStaffCrowd("high");
    const low = advanceStaffCrowd(initial, geometry, { ...FRAME, tier: "low", paused: true });
    expect(low.agents).toHaveLength(2);
    for (const agent of low.agents) expect(agent).toBe(initial.agents.find((candidate) => candidate.id === agent.id));
    expect(staffCrowdPeople(low)).toEqual(low.agents.map((agent) => ({ id: agent.id, position: agent.position, radius: STAFF_RADIUS })));
  });

  it("runs the real authored corridor without walls, furniture or people overlap", () => {
    let state = createStaffCrowd("high");
    let distance = 0;
    let previous: Vec3 = PATROL_STOPS[0]?.position ?? [1.15, 0.03, -14.6];
    for (let frame = 0; frame < 1800; frame += 1) {
      state = advanceStaffCrowd(state, geometry, FRAME);
      const patrol = state.agents.find((agent) => agent.id === "staff:patrol");
      expect(patrol).toBeDefined();
      if (patrol === undefined) throw new Error("Missing patrol");
      expect(isWalkable(patrol.position, geometry.colliders, STAFF_RADIUS)).toBe(true);
      expect(hasLineOfSight(previous, patrol.position, geometry.colliders, STAFF_RADIUS)).toBe(true);
      expect(patrol.walkedDistance).toBeGreaterThanOrEqual(distance);
      expect(patrol.speed).toBeLessThanOrEqual(PATROL_SPEED + 1e-7);
      for (const staff of PRECINCT_STAFF.filter((value) => value.activity !== "patrol")) {
        expect(state.agents.find((agent) => agent.id === `staff:${staff.id}`)?.position).toEqual(staff.position);
        expect(Math.hypot(patrol.position[0] - staff.position[0], patrol.position[2] - staff.position[2])).toBeGreaterThan(2 * STAFF_RADIUS);
      }
      distance = patrol.walkedDistance; previous = patrol.position;
    }
    expect(distance).toBeGreaterThan(30);
  });

  it("routes around a player standing on the authored patrol line", () => {
    let state = createStaffCrowd("high");
    const playerPosition: Vec3 = [1.15, 0, -18];
    let passed = false;
    for (let frame = 0; frame < 1000; frame += 1) {
      state = advanceStaffCrowd(state, geometry, { ...FRAME, playerPosition });
      const patrol = state.agents.find((agent) => agent.id === "staff:patrol");
      if (patrol === undefined) throw new Error("Missing patrol");
      expect(Math.hypot(patrol.position[0] - playerPosition[0], patrol.position[2] - playerPosition[2])).toBeGreaterThanOrEqual(0.645 - 1e-7);
      passed ||= patrol.position[2] < -20;
    }
    expect(passed).toBe(true);
  });
});
