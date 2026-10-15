import { navmeshDigest } from "../../test/navmesh-digest";
import { describe, expect, it } from "vitest";
import { buildPrecinctNavmesh, canonicalNavmeshSource, findNavmeshRoute, isPointOnNavmesh } from "./precinctNavmesh";
import { planNavigationRoute, resolveWorldNavigation, navigationStatusText, worldNavmeshSource, WORLD_NAVMESH_SCHEMA, type WorldNavmeshBundle } from "./worldNavigation";
import { REVIEWER_COLLIDER_V2 } from "./proceduralReviewerV2";
import { findWaypointRoute, hasLineOfSight } from "./movement";
import type { AuthoredCollisionGeometry } from "./effectiveWorldGeometry";
import type { Vec3 } from "./types";

const EMPTY: AuthoredCollisionGeometry = { walkBounds: { min: [-5, 0, -5], max: [5, 3, 5] }, colliders: [] };
async function bundle(geometry: AuthoredCollisionGeometry, worldId: "office" | "courtyard" = "office"): Promise<WorldNavmeshBundle> {
  const make = async (profile: "player" | "staff") => {
    const source = worldNavmeshSource(geometry, profile);
    return buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
  };
  return { schema: WORLD_NAVMESH_SCHEMA, worldId, player: await make("player"), staff: await make("staff") };
}
function routeClear(start: Vec3, route: readonly Vec3[] | null, geometry: AuthoredCollisionGeometry, radius: number) {
  expect(route).not.toBeNull();
  if (route === null) throw new Error("Expected a capsule-clear route");
  let previous = start;
  for (const next of route) { expect(hasLineOfSight(previous, next, geometry.colliders, radius)).toBe(true); previous = next; }
}

describe("selected effective-world profile binding", () => {
  it("uses exact player and staff radii/heights with the same canonical reviewer overlay", async () => {
    const value = (await bundle(EMPTY)); const result = resolveWorldNavigation(value, "office", EMPTY);
    expect(result.player?.agentRadius).toBe(0.28); expect(result.player?.floorY).toBe(0);
    expect(result.staff?.agentRadius).toBe(0.34); expect(result.staff?.floorY).toBe(0.03);
    expect(result.player?.sourceCanonical).toContain(REVIEWER_COLLIDER_V2.id);
    expect(result.staff?.sourceCanonical).toContain(REVIEWER_COLLIDER_V2.id);
    expect(navigationStatusText(result.status)).toBe("Polygon navigation is active for walking and staff.");
  });
  it("discloses fallback only for missing/invalid live mesh data", async () => {
    for (const value of [null, undefined]) {
      const result = resolveWorldNavigation(value, "office", EMPTY);
      expect(result.player).toBeNull(); expect(result.status.player.reason).toBe("missing");
      expect(navigationStatusText(result.status)).toContain("Waypoint fallback");
    }
    for (const value of [{}, [], { ...(await bundle(EMPTY)), schema: "unknown" }]) {
      const result = resolveWorldNavigation(value, "office", EMPTY);
      expect(result.player).toBeNull(); expect(result.status.player.reason).toBe("invalid");
    }
  });
  it("rejects cross-world, swapped-profile, stale bounds and moved overlay artifacts", async () => {
    const value = (await bundle(EMPTY));
    expect(resolveWorldNavigation(value, "courtyard", EMPTY).player).toBeNull();
    expect(resolveWorldNavigation({ ...value, player: value.staff, staff: value.player }, "office", EMPTY).player).toBeNull();
    expect(resolveWorldNavigation(value, "office", { ...EMPTY, walkBounds: { min: [-6, 0, -5], max: [5, 3, 5] } }).player).toBeNull();
    const moved = { ...EMPTY, colliders: [{ ...REVIEWER_COLLIDER_V2, max: [5.36, 1.5, -16.99] as const }] };
    expect(resolveWorldNavigation(value, "office", moved).player).toBeNull();
  });
  it("rejects an artifact authored without the reviewer overlay", async () => {
    const value = (await bundle(EMPTY));
    const source = { ...worldNavmeshSource(EMPTY, "player"), colliders: [] };
    const absent = buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
    expect(resolveWorldNavigation({ ...value, player: absent }, "office", EMPTY).player).toBeNull();
  });
});

describe("player and crowd planner boundary", () => {
  it("does not graph-fallback when a valid mesh says a destination is unreachable", async () => {
    const geometry = { colliders: [], navigationNodes: [] }; const mesh = (await bundle(EMPTY)).player;
    expect(planNavigationRoute([0, 0, 0], [6, 0, 0], geometry, null)).toEqual([[6, 0, 0]]);
    expect(planNavigationRoute([0, 0, 0], [6, 0, 0], geometry, mesh)).toBeNull();
    expect(planNavigationRoute([0, 0, 0], [2, 0, 0], geometry, mesh, 0.34)).toBeNull();
  });
  it("bounds local crowd avoidance to finite points on the same polygon floor", async () => {
    const mesh = (await bundle(EMPTY)).staff;
    expect(isPointOnNavmesh([0, 0.03, 0], mesh)).toBe(true);
    expect(isPointOnNavmesh([0, 0, 0], mesh)).toBe(false);
    expect(isPointOnNavmesh([6, 0.03, 0], mesh)).toBe(false);
    expect(isPointOnNavmesh([NaN, 0.03, 0], mesh)).toBe(false);
  });
  it("keeps an undersized staff portal closed while preserving the player's original footprint", async () => {
    const geometry: AuthoredCollisionGeometry = { ...EMPTY, colliders: [
      { id: "west", min: [-6, 0, -0.2], max: [-0.30, 3, 0.2] },
      { id: "east", min: [0.30, 0, -0.2], max: [6, 3, 0.2] },
    ] };
    const value = await bundle(geometry);
    routeClear([0, 0, 3], findNavmeshRoute([0, 0, 3], [0, 0, -3], value.player, geometry.colliders), geometry, 0.28);
    expect(findNavmeshRoute([0, 0.03, 3], [0, 0.03, -3], value.staff, geometry.colliders)).toBeNull();
  });
  it("retains frozen legacy behavior and never plans captured-root replay", async () => {
    const value = (await bundle(EMPTY));
    const legacy = resolveWorldNavigation(value, "office", EMPTY, "legacy-replay");
    expect(legacy.player).toBeNull(); expect(legacy.staff).toBeNull();
    expect(legacy.status.player.reason).toBe("legacy-compatibility");
    const geometry = { colliders: [], navigationNodes: [] };
    expect(planNavigationRoute([0, 0, 0], [6, 0, 0], geometry, legacy.player)).toEqual(findWaypointRoute([0, 0, 0], [6, 0, 0], [], []));
    expect(navigationStatusText(legacy.status)).toContain("original waypoint");
    const recorded = resolveWorldNavigation(value, "office", EMPTY, "sampled-replay");
    expect(recorded.player).toBeNull(); expect(recorded.staff).toBeNull();
    expect(navigationStatusText(recorded.status)).toContain("live navigation planning is paused");
  });
});
