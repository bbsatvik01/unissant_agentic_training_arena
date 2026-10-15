import { navmeshDigest } from "../../test/navmesh-digest";
import { describe, expect, it } from "vitest";
import { PRECINCT_WORLDS } from "./knownWorlds";
import { STATIONS } from "../../components/precinct/sceneTypes";
import { buildPrecinctNavmesh, canonicalNavmeshSource, findNavmeshRoute, validatePrecinctNavmesh } from "./precinctNavmesh";
import { worldNavmeshSource, resolveWorldNavigation, WORLD_NAVMESH_SCHEMA, type NavigationProfile, type WorldNavmeshBundle } from "./worldNavigation";
import { REVIEWER_COLLIDER_V2 } from "./proceduralReviewerV2";
import { PATROL_STOPS } from "./staff";
import { hasLineOfSight } from "./movement";
import type { Vec3 } from "./types";

const xyz = (value: readonly number[]): Vec3 => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
async function fixture(id: "office" | "courtyard", profile: NavigationProfile) {
  const world = PRECINCT_WORLDS[id];
  const source = worldNavmeshSource({ colliders: world.manifest.colliders,
    walkBounds: { min: xyz(world.authored.walkBounds.min), max: xyz(world.authored.walkBounds.max) } }, profile);
  const mesh = buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
  return { world, source, mesh };
}
function checkRoute(start: Vec3, end: Vec3, value: Awaited<ReturnType<typeof fixture>>) {
  const route = findNavmeshRoute(start, end, value.mesh, value.source.colliders);
  expect(route, `Expected ${start.join(",")} → ${end.join(",")}`).not.toBeNull();
  if (route === null) throw new Error("Missing capsule-clear authored-world route");
  let previous = start;
  for (const point of route) { expect(hasLineOfSight(previous, point, value.source.colliders, value.source.agentRadius)).toBe(true); previous = point; }
  if (route.length > 0) expect(route.at(-1)).toEqual(end);
}

describe("actual two-world effective geometry", () => {
  for (const id of ["office", "courtyard"] as const) {
    it(`${id}: reaches every preserved hotspot, travel station and room approach with the original player capsule`, async () => {
      const value = await fixture(id, "player");
      expect(validatePrecinctNavmesh(value.mesh, value.source)).toEqual([]);
      expect(value.source.colliders.filter((collider) => collider.id === REVIEWER_COLLIDER_V2.id)).toEqual([REVIEWER_COLLIDER_V2]);
      for (const hotspot of value.world.authored.hotspots) checkRoute([0, 0, -2.4], [hotspot.position[0] ?? 0, 0, hotspot.position[2] ?? 0], value);
      for (const station of STATIONS) checkRoute([0, 0, -2.4], station.anchor, value);
      for (const room of value.world.authored.rooms) {
        // The unchanged observation label anchor lies within the later reviewer chair's clearance.
        // Its existing user-facing travel station is the safe approach; no authored anchor is moved.
        const station = room.id === "observation" ? STATIONS.find((item) => item.id === "observation") : undefined;
        checkRoute([0, 0, -2.4], station?.anchor ?? xyz(room.anchor), value);
      }
      expect(findNavmeshRoute([0, 0, -2.4], [4.8, 0, -18], value.mesh, value.source.colliders)).toBeNull();
    });
    it(`${id}: preserves real door portals at each profile radius and staff patrol destinations`, async () => {
      for (const profile of ["player", "staff"] as const) {
        const value = await fixture(id, profile);
        for (const door of value.world.authored.doors) {
          const [x, , z] = xyz(door.walkCenter); const y = value.source.floorY;
          const a: Vec3 = door.axis === "x" ? [x, y, z - 0.3] : [x - 0.3, y, z];
          const b: Vec3 = door.axis === "x" ? [x, y, z + 0.3] : [x + 0.3, y, z];
          checkRoute(a, b, value);
        }
        if (profile === "staff") for (const stop of PATROL_STOPS) checkRoute([1.15, 0.03, -14.6], stop.position, value);
      }
    });
    it(`${id}: rejects the other world and the same authored geometry without the exact chair overlay`, async () => {
      const player = await fixture(id, "player"); const staff = await fixture(id, "staff");
      const bundle: WorldNavmeshBundle = { schema: WORLD_NAVMESH_SCHEMA, worldId: id, player: player.mesh, staff: staff.mesh };
      const other = PRECINCT_WORLDS[id === "office" ? "courtyard" : "office"];
      const otherGeometry = { colliders: other.manifest.colliders,
        walkBounds: { min: xyz(other.authored.walkBounds.min), max: xyz(other.authored.walkBounds.max) } };
      // The forged world ID cannot make the canonical collider/bounds disagreement disappear.
      expect(resolveWorldNavigation({ ...bundle, worldId: other.id }, other.id, otherGeometry).player).toBeNull();
      const without = { ...player.source, colliders: player.source.colliders.filter((collider) => collider.id !== REVIEWER_COLLIDER_V2.id) };
      expect(validatePrecinctNavmesh(player.mesh, without).length).toBeGreaterThan(0);
    });
  }
  it("routes the courtyard axis and both gallery loops around actual garden circles", async () => {
    const value = await fixture("courtyard", "player");
    for (const [a, b] of [
      [[0, 0, -2.4], [0, 0, 16.3]], [[-11.3, 0, 2.4], [-11.3, 0, 16.3]],
      [[11.3, 0, 2.4], [11.3, 0, 16.3]], [[-11.3, 0, 9], [11.3, 0, 9]],
    ] as const) checkRoute(a, b, value);
    expect(findNavmeshRoute([0, 0, 9], [4.5, 0, 9], value.mesh, value.source.colliders)).toBeNull();
    expect(findNavmeshRoute([0, 0, 9], [15, 0, 9], value.mesh, value.source.colliders)).toBeNull();
  });
});
