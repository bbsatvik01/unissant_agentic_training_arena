import { describe, expect, it } from "vitest";
import { effectivePrecinctColliders, effectivePrecinctNavmeshSource, STAFF_NAVMESH_FLOOR_Y, STAFF_NAVMESH_RADIUS } from "./effectiveWorldGeometry";
import { PRECINCT_WORLDS } from "./knownWorlds";
import { REVIEWER_COLLIDER_V2 } from "./proceduralReviewerV2";
import type { Vec3 } from "./types";

const xyz = (value: readonly number[]): Vec3 => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];

describe("effective geometry for both immutable architecture choices", () => {
  for (const id of ["office", "courtyard"] as const) {
    it(`applies the exact reviewer overlay once after selecting ${id}`, () => {
      const { manifest } = PRECINCT_WORLDS[id];
      const before = JSON.stringify(manifest.colliders);
      const effective = effectivePrecinctColliders(manifest.colliders);
      expect(effective.filter((collider) => collider.id === REVIEWER_COLLIDER_V2.id)).toEqual([REVIEWER_COLLIDER_V2]);
      expect(effective.slice(0, manifest.colliders.length)).toEqual(manifest.colliders);
      expect(effectivePrecinctColliders(effective)).toEqual(effective);
      expect(JSON.stringify(manifest.colliders)).toBe(before);
    });
    it(`binds ${id} staff navigation to the same effective collider array and selected bounds`, () => {
      const world = PRECINCT_WORLDS[id];
      const walkBounds = { min: xyz(world.authored.walkBounds.min), max: xyz(world.authored.walkBounds.max) };
      const source = effectivePrecinctNavmeshSource({ colliders: world.manifest.colliders, walkBounds });
      expect(source.colliders).toEqual(effectivePrecinctColliders(world.manifest.colliders));
      expect(source.bounds).toEqual({ min: [walkBounds.min[0], walkBounds.min[2]], max: [walkBounds.max[0], walkBounds.max[2]] });
      expect(source.floorY).toBe(STAFF_NAVMESH_FLOOR_Y);
      expect(source.agentRadius).toBe(STAFF_NAVMESH_RADIUS);
      expect(source.colliders.some((collider) => collider.id === "reviewer-chair-v2")).toBe(true);
    });
  }
  it("retains the working-module colliders while the court adds a physically contained annex", () => {
    const office = effectivePrecinctColliders(PRECINCT_WORLDS.office.manifest.colliders);
    const courtyard = effectivePrecinctColliders(PRECINCT_WORLDS.courtyard.manifest.colliders);
    for (const collider of office) expect(courtyard.find((item) => item.id === collider.id)).toEqual(collider);
    expect(courtyard.length).toBeGreaterThan(office.length);
  });
});
