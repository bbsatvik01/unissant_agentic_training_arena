import { navmeshDigest } from "../../test/navmesh-digest";
import { describe, expect, it } from "vitest";
import { buildPrecinctNavmesh, canonicalNavmeshSource, findNavmeshRoute, readPrecinctNavmesh, validatePrecinctNavmesh,
  type NavmeshSource, type PrecinctNavmesh } from "./precinctNavmesh";
import { hasLineOfSight, isWalkable } from "./movement";
import type { Collider, Vec3 } from "./types";
import manifestJson from "../../../public/world/precinct-manifest.json?raw";

const EMPTY: NavmeshSource = { bounds: { min: [-5, -5], max: [5, 5] }, floorY: 0, agentRadius: 0.34, colliders: [] };
const WALL: Collider = { id: "wall", min: [-0.5, 0, -2], max: [0.5, 3, 2] };
async function build(source: NavmeshSource): Promise<PrecinctNavmesh> {
  return buildPrecinctNavmesh(source, await navmeshDigest(canonicalNavmeshSource(source)));
}
function requireRoute(source: NavmeshSource, mesh: PrecinctNavmesh, start: Vec3, destination: Vec3): readonly Vec3[] {
  const route = findNavmeshRoute(start, destination, mesh, source.colliders);
  expect(route).not.toBeNull();
  if (route === null) throw new Error("Expected navmesh route");
  let previous = start;
  for (const point of route) { expect(hasLineOfSight(previous, point, source.colliders, source.agentRadius)).toBe(true); previous = point; }
  expect(route.at(-1)).toEqual(destination);
  return route;
}

describe("original convex navmesh authoring", () => {
  it("authors one radius-inset polygon for an empty floor, with exact provenance", async () => {
    const mesh = await build(EMPTY);
    expect(mesh.polygons).toEqual([{ id: "polygon-0", vertices: [[-4.66, -4.66], [4.66, -4.66], [4.66, 4.66], [-4.66, 4.66]] }]);
    expect(mesh.portals).toEqual([]);
    expect(mesh.sourceSha256).toBe(await navmeshDigest(mesh.sourceCanonical));
    expect(validatePrecinctNavmesh(mesh, EMPTY)).toEqual([]);
    expect(requireRoute(EMPTY, mesh, [-3, 0, 0], [3, 0, 0])).toEqual([[3, 0, 0]]);
  });

  it("decomposes a blocker into non-overlapping convex polygons with real shared-edge portals", async () => {
    const source = { ...EMPTY, colliders: [WALL] }; const mesh = await build(source);
    expect(mesh.polygons.length).toBeGreaterThan(1);
    expect(mesh.portals.length).toBeGreaterThan(1);
    expect(validatePrecinctNavmesh(mesh, source)).toEqual([]);
    for (const polygon of mesh.polygons) for (const [x, z] of polygon.vertices) expect(isWalkable([x, 0, z], [WALL], 0.34)).toBe(true);
    const route = requireRoute(source, mesh, [-3, 0, 0], [3, 0, 0]);
    expect(route.some((point) => Math.abs(point[2]) >= 2.34 - 1e-8)).toBe(true);
  });

  it("is deterministic under collider ordering and persists as ordinary JSON", async () => {
    const colliders: readonly Collider[] = [WALL, { id: "cabinet", min: [-4, 0, -1], max: [-3, 2, 0] }];
    const forward = await build({ ...EMPTY, colliders }); const backward = await build({ ...EMPTY, colliders: [...colliders].reverse() });
    expect(backward).toEqual(forward);
    const roundTrip = JSON.parse(JSON.stringify(forward)) as PrecinctNavmesh;
    expect(validatePrecinctNavmesh(roundTrip, { ...EMPTY, colliders })).toEqual([]);
    expect(findNavmeshRoute([-2, 0, 3], [3, 0, 0], roundTrip, colliders)).toEqual(findNavmeshRoute([-2, 0, 3], [3, 0, 0], forward, colliders));
  });

  it("ignores floor and ceiling but includes obstacles intersecting the full upright height", async () => {
    const floor: Collider = { id: "floor", min: [-5, -0.2, -5], max: [5, 0, 5] };
    const ceiling: Collider = { id: "ceiling", min: [-5, 1.8, -5], max: [5, 2, 5] };
    expect((await build({ ...EMPTY, colliders: [floor, ceiling] })).polygons).toEqual((await build(EMPTY)).polygons);
    expect((await build({ ...EMPTY, colliders: [{ ...WALL, min: [-0.5, 1.79, -2] }] })).polygons.length).toBeGreaterThan(1);
  });

  it("rejects invalid bounds, radii, coordinates, duplicate IDs and missing fingerprint", async () => {
    const sha = "a".repeat(64);
    expect(() => buildPrecinctNavmesh(EMPTY, "not-a-hash")).toThrow("SHA-256");
    for (const radius of [0, -0.1, NaN, 10]) expect(() => buildPrecinctNavmesh({ ...EMPTY, agentRadius: radius }, sha)).toThrow();
    await expect(build({ ...EMPTY, colliders: [WALL, WALL] })).rejects.toThrow("unique");
    await expect(build({ ...EMPTY, colliders: [{ ...WALL, min: [NaN, 0, 0] }] })).rejects.toThrow("collider");
    await expect(build({ ...EMPTY, colliders: [{ ...WALL, min: [2, 0, 0] }] })).rejects.toThrow("collider");
  });

  it("retains exactly safe areas under overlapping blockers and disjoint islands", async () => {
    const source: NavmeshSource = { ...EMPTY, colliders: [
      { id: "divide", min: [-0.1, 0, -6], max: [0.1, 3, 6] },
      { id: "overlap", min: [-0.3, 0, -1], max: [0.3, 3, 1] },
    ] };
    const mesh = await build(source);
    expect(validatePrecinctNavmesh(mesh, source)).toEqual([]);
    expect(findNavmeshRoute([-3, 0, 0], [3, 0, 0], mesh, source.colliders)).toBeNull();
    requireRoute(source, mesh, [-3, 0, -3], [-3, 0, 3]);
  });
});

describe("capsule-clear portals and funnel routes", () => {
  function doorway(halfWidth: number): NavmeshSource {
    return { ...EMPTY, colliders: [
      { id: "west", min: [-6, 0, -0.2], max: [-halfWidth, 3, 0.2] },
      { id: "east", min: [halfWidth, 0, -0.2], max: [6, 3, 0.2] },
    ] };
  }

  it("routes through a genuine doorway polygon/portal corridor", async () => {
    const source = doorway(0.6); const mesh = await build(source);
    expect(validatePrecinctNavmesh(mesh, source)).toEqual([]);
    expect(requireRoute(source, mesh, [-2, 0, 3], [2, 0, -3]).length).toBeLessThanOrEqual(3);
    expect(requireRoute(source, mesh, [0, 0, 3], [0, 0, -3])).toEqual([[0, 0, -3]]);
  });

  it("disconnects an undersized doorway instead of representing it as a traversable edge", async () => {
    const source = doorway(0.3); const mesh = await build(source);
    expect(validatePrecinctNavmesh(mesh, source)).toEqual([]);
    expect(findNavmeshRoute([0, 0, 3], [0, 0, -3], mesh, source.colliders)).toBeNull();
  });

  it("does not double-shrink portals after radius expansion", async () => {
    const source = doorway(0.36); const mesh = await build(source);
    expect(mesh.portals.some((portal) => Math.abs(portal.endpoints[1][0] - portal.endpoints[0][0] - 0.04) < 1e-8)).toBe(true);
    requireRoute(source, mesh, [0, 0, 3], [0, 0, -3]);
  });

  it("orders a short portal correctly when both endpoints lie on one side of the centroid chord", async () => {
    const source: NavmeshSource = { bounds: { min: [-6, -8], max: [4, 3] }, floorY: 0, agentRadius: 0.28, colliders: [
      { id: "left-lower", min: [-6, 0, -8], max: [-1, 3, 1] },
      { id: "right", min: [1, 0, -8], max: [4, 3, 3] },
    ] };
    const mesh = await build(source);
    requireRoute(source, mesh, [-4, 0, 2], [0, 0, -6]);
    requireRoute(source, mesh, [0, 0, -6], [-4, 0, 2]);
  });

  it("funnels repeated turns and validates every chord against source walls", async () => {
    const source: NavmeshSource = { ...EMPTY, colliders: [
      { id: "lower", min: [-6, 0, -1.2], max: [1.5, 3, -0.8] },
      { id: "upper", min: [-1.5, 0, 0.8], max: [6, 3, 1.2] },
    ] };
    const mesh = await build(source);
    const route = requireRoute(source, mesh, [-3, 0, -3.5], [3, 0, 3.5]);
    expect(route.length).toBeGreaterThanOrEqual(4);
    requireRoute(source, mesh, [3, 0, 3.5], [-3, 0, -3.5]);
  });

  it("accepts exact polygon boundaries, rejects embedded/outside/invalid points and wrong height", async () => {
    const source = { ...EMPTY, colliders: [WALL] }; const mesh = await build(source);
    expect(findNavmeshRoute([-3, 0, 0], [-3, 0, 0], mesh, [WALL])).toEqual([]);
    expect(findNavmeshRoute([0, 0, 0], [3, 0, 0], mesh, [WALL])).toBeNull();
    expect(findNavmeshRoute([-5, 0, 0], [3, 0, 0], mesh, [WALL])).toBeNull();
    expect(findNavmeshRoute([NaN, 0, 0], [3, 0, 0], mesh, [WALL])).toBeNull();
    expect(findNavmeshRoute([-3, 0.03, 0], [3, 0.03, 0], mesh, [WALL])).toBeNull();
    requireRoute(source, mesh, [-0.84, 0, 0], [-0.84, 0, 3]);
  });

  it("fails closed if collision geometry changes after authoring", async () => {
    const mesh = await build(EMPTY);
    expect(findNavmeshRoute([-3, 0, 0], [3, 0, 0], mesh, [WALL])).toBeNull();
    expect(findNavmeshRoute([0, 0, 0], [0, 0, 0], mesh, [WALL])).toBeNull();
    expect(validatePrecinctNavmesh(mesh, { ...EMPTY, colliders: [WALL] }).length).toBeGreaterThan(0);
  });
});

describe("exact navmesh validation", () => {
  it("reads only finite valid static JSON and rejects stale or malformed artifacts", async () => {
    const mesh = await build(EMPTY);
    expect(readPrecinctNavmesh(JSON.parse(JSON.stringify(mesh)) as unknown, EMPTY)).toEqual(mesh);
    for (const value of [null, [], "bad", {}, { ...mesh, polygons: [{ id: "bad", vertices: [[0, 0]] }] },
      { ...mesh, bounds: { min: [NaN, 0], max: [4, 4] } }, { ...mesh, sourceCanonical: "old" },
      { ...mesh, portals: [{ id: "bad", polygons: ["a"], endpoints: [] }] }]) expect(readPrecinctNavmesh(value, EMPTY)).toBeNull();
  });

  it("rejects bad source fingerprints, concave/deformed polygons and lost free space", async () => {
    const mesh = await build(EMPTY);
    expect(validatePrecinctNavmesh({ ...mesh, schema: "unknown" }, EMPTY)).toContain("Source/version/radius metadata mismatch.");
    expect(validatePrecinctNavmesh({ ...mesh, sourceSha256: "bad" }, EMPTY)).toContain("Source/version/radius metadata mismatch.");
    expect(validatePrecinctNavmesh({ ...mesh, sourceCanonical: "changed" }, EMPTY)).toContain("Source/version/radius metadata mismatch.");
    expect(validatePrecinctNavmesh({ ...mesh, polygons: [] }, EMPTY)).toContain("Free-space coverage area mismatch.");
    expect(validatePrecinctNavmesh({ ...mesh, polygons: [{ id: "bad", vertices: [[-4, -4], [4, -4], [0, 0], [-4, 4]] }] }, EMPTY).some((issue) => issue.includes("Invalid convex"))).toBe(true);
  });

  it("rejects duplicate/overlapping polygons and missing/invalid/duplicate portals", async () => {
    const source = { ...EMPTY, colliders: [WALL] }; const mesh = await build(source);
    const polygon = mesh.polygons[0]; const portal = mesh.portals[0];
    if (polygon === undefined || portal === undefined) throw new Error("Missing fixture polygons/portals");
    expect(validatePrecinctNavmesh({ ...mesh, polygons: [...mesh.polygons, polygon] }, source).some((issue) => issue.includes("Duplicate polygon"))).toBe(true);
    expect(validatePrecinctNavmesh({ ...mesh, polygons: [...mesh.polygons, { ...polygon, id: "extra" }] }, source).some((issue) => issue.includes("Overlapping"))).toBe(true);
    expect(validatePrecinctNavmesh({ ...mesh, portals: [] }, source).some((issue) => issue.includes("Missing portal"))).toBe(true);
    expect(validatePrecinctNavmesh({ ...mesh, portals: [...mesh.portals, portal] }, source).some((issue) => issue.includes("Duplicate portal"))).toBe(true);
    expect(validatePrecinctNavmesh({ ...mesh, portals: [{ ...portal, endpoints: [[0, 0], [0, 1]] }, ...mesh.portals.slice(1)] }, source).some((issue) => issue.includes("Invalid shared-edge"))).toBe(true);
  });
});

describe("actual precinct navmesh source", () => {
  const manifest = JSON.parse(manifestJson) as { readonly walkBounds: { readonly min: Vec3; readonly max: Vec3 }; readonly colliders: readonly Collider[] };
  const source: NavmeshSource = { bounds: { min: [manifest.walkBounds.min[0], manifest.walkBounds.min[2]], max: [manifest.walkBounds.max[0], manifest.walkBounds.max[2]] },
    floorY: 0.03, agentRadius: 0.34, colliders: manifest.colliders };

  it("validates every polygon and portal against the shipped collider manifest", async () => {
    const mesh = await build(source);
    expect(validatePrecinctNavmesh(mesh, source)).toEqual([]);
    expect(mesh.polygons.length).toBeGreaterThan(20);
    expect(mesh.portals.length).toBeGreaterThan(20);
  });

  it("routes the patrol and real station doorways using polygons rather than authored graph nodes", async () => {
    const mesh = await build(source);
    for (const destination of [[1.15, 0.03, -31.1], [-5.4, 0.03, -13.1], [-5.2, 0.03, -22], [-4.3, 0.03, -29.1], [5.7, 0.03, -12.5], [10.4, 0.03, -18.6], [5, 0.03, -22], [4.3, 0.03, -28.8]] as const) {
      requireRoute(source, mesh, [0, 0.03, -3], destination);
    }
  });
});
