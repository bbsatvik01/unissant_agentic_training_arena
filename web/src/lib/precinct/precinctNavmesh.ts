/** Original dependency-free convex navigation mesh for a flat, rectangular-collider precinct. */
import { hasLineOfSight, PLAYER_HEIGHT } from "./movement";
import type { Collider, Vec3 } from "./types";

export type NavPoint = readonly [number, number];
export interface NavRect { readonly min: NavPoint; readonly max: NavPoint }
export interface NavmeshSource {
  /** Physical floor envelope. Authoring insets it by agentRadius before polygonization. */
  readonly bounds: NavRect;
  readonly floorY: number;
  readonly agentRadius: number;
  readonly colliders: readonly Collider[];
}
export interface NavPolygon { readonly id: string; readonly vertices: readonly [NavPoint, NavPoint, NavPoint, NavPoint] }
export interface NavPortal { readonly id: string; readonly polygons: readonly [string, string]; readonly endpoints: readonly [NavPoint, NavPoint] }
export interface PrecinctNavmesh {
  readonly schema: "precinct.navmesh.v1";
  readonly agentRadius: number;
  readonly agentHeight: number;
  readonly floorY: number;
  readonly bounds: NavRect;
  /** Exact canonical source agreement is checked in addition to the SHA-256 audit fingerprint. */
  readonly sourceCanonical: string;
  readonly sourceSha256: string;
  readonly polygons: readonly NavPolygon[];
  readonly portals: readonly NavPortal[];
}
const EPSILON = 1e-8;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a: NavPoint, b: NavPoint) => Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const center = (rect: NavRect): NavPoint => [(rect.min[0] + rect.max[0]) / 2, (rect.min[1] + rect.max[1]) / 2];
const contains = (rect: NavRect, point: NavPoint) => point[0] >= rect.min[0] - EPSILON && point[0] <= rect.max[0] + EPSILON && point[1] >= rect.min[1] - EPSILON && point[1] <= rect.max[1] + EPSILON;
const area = (rect: NavRect) => (rect.max[0] - rect.min[0]) * (rect.max[1] - rect.min[1]);
function overlaps(a: NavRect, b: NavRect): boolean {
  return Math.min(a.max[0], b.max[0]) > Math.max(a.min[0], b.min[0]) + EPSILON
    && Math.min(a.max[1], b.max[1]) > Math.max(a.min[1], b.min[1]) + EPSILON;
}
function rectOf(polygon: NavPolygon): NavRect { return { min: polygon.vertices[0], max: polygon.vertices[2] }; }

/** Source order is irrelevant; numeric values and collider identities remain exact. */
export function canonicalNavmeshSource(source: NavmeshSource): string {
  return JSON.stringify({ version: 1, bounds: source.bounds, floorY: source.floorY,
    agentRadius: source.agentRadius, agentHeight: PLAYER_HEIGHT,
    colliders: [...source.colliders].sort((a, b) => compare(a.id, b.id)).map(({ id, min, max }) => ({ id, min, max })) });
}

function arrangement(source: NavmeshSource): { readonly bounds: NavRect; readonly blockers: readonly NavRect[]; readonly xs: readonly number[]; readonly zs: readonly number[] } {
  const values = [...source.bounds.min, ...source.bounds.max, source.floorY, source.agentRadius];
  if (!values.every(Number.isFinite) || source.agentRadius <= 0
    || source.bounds.max.some((value, axis) => value <= (source.bounds.min[axis] ?? Infinity) + source.agentRadius * 2)) throw new Error("Invalid navmesh floor bounds or radius.");
  if (new Set(source.colliders.map((collider) => collider.id)).size !== source.colliders.length) throw new Error("Collider IDs must be unique.");
  const bounds: NavRect = { min: [source.bounds.min[0] + source.agentRadius, source.bounds.min[1] + source.agentRadius],
    max: [source.bounds.max[0] - source.agentRadius, source.bounds.max[1] - source.agentRadius] };
  const blockers: NavRect[] = [];
  for (const collider of source.colliders) {
    if (![...collider.min, ...collider.max].every(Number.isFinite)
      || collider.min.some((value, axis) => value > (collider.max[axis] ?? -Infinity))) throw new Error("Invalid navmesh collider.");
    if (collider.max[1] <= source.floorY + EPSILON || collider.min[1] >= source.floorY + PLAYER_HEIGHT - EPSILON) continue;
    const rectangle: NavRect = { min: [Math.max(bounds.min[0], collider.min[0] - source.agentRadius), Math.max(bounds.min[1], collider.min[2] - source.agentRadius)],
      max: [Math.min(bounds.max[0], collider.max[0] + source.agentRadius), Math.min(bounds.max[1], collider.max[2] + source.agentRadius)] };
    if (rectangle.min[0] < rectangle.max[0] && rectangle.min[1] < rectangle.max[1]) blockers.push(rectangle);
  }
  const xs = [...new Set([bounds.min[0], bounds.max[0], ...blockers.flatMap((rectangle) => [rectangle.min[0], rectangle.max[0]])])].sort((a, b) => a - b);
  const zs = [...new Set([bounds.min[1], bounds.max[1], ...blockers.flatMap((rectangle) => [rectangle.min[1], rectangle.max[1]])])].sort((a, b) => a - b);
  return { bounds, blockers, xs, zs };
}

/** Exact rectangular arrangement, not a sampled occupancy grid. Every blocker boundary is a cut. */
function freeRectangles(source: NavmeshSource): readonly NavRect[] {
  const { blockers, xs, zs } = arrangement(source);
  const rectangles: NavRect[] = [];
  let previous = new Map<string, number>();
  for (let z = 0; z < zs.length - 1; z += 1) {
    const low = zs[z]; const high = zs[z + 1];
    if (low === undefined || high === undefined || high - low <= EPSILON) continue;
    const next = new Map<string, number>();
    let runStart: number | undefined;
    for (let x = 0; x < xs.length; x += 1) {
      const left = xs[x]; const right = xs[x + 1];
      const open = left !== undefined && right !== undefined && right - left > EPSILON
        && !blockers.some((rectangle) => contains(rectangle, [(left + right) / 2, (low + high) / 2]));
      if (open && runStart === undefined) runStart = left;
      if (open || runStart === undefined || left === undefined) continue;
      const key = `${String(runStart)}:${String(left)}`;
      const existingIndex = previous.get(key);
      const existing = existingIndex === undefined ? undefined : rectangles[existingIndex];
      if (existing !== undefined && existingIndex !== undefined) {
        rectangles[existingIndex] = { min: existing.min, max: [left, high] }; next.set(key, existingIndex);
      } else {
        next.set(key, rectangles.length); rectangles.push({ min: [runStart, low], max: [left, high] });
      }
      runStart = undefined;
    }
    previous = next;
  }
  return rectangles;
}

function sharedEdge(a: NavRect, b: NavRect): readonly [NavPoint, NavPoint] | null {
  for (const axis of [0, 1] as const) {
    const other = axis === 0 ? 1 : 0;
    const boundary = Math.abs(a.max[axis] - b.min[axis]) < EPSILON ? a.max[axis]
      : Math.abs(a.min[axis] - b.max[axis]) < EPSILON ? a.min[axis] : null;
    if (boundary === null) continue;
    const min = Math.max(a.min[other], b.min[other]); const max = Math.min(a.max[other], b.max[other]);
    if (max - min > EPSILON) return axis === 0 ? [[boundary, min], [boundary, max]] : [[min, boundary], [max, boundary]];
  }
  return null;
}

/** Original conservative convex-polygon mesh; SHA-256 is supplied by the authoring tool's node:crypto. */
export function buildPrecinctNavmesh(source: NavmeshSource, sourceSha256: string): PrecinctNavmesh {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("A SHA-256 source fingerprint is required.");
  const polygons: NavPolygon[] = freeRectangles(source).map((rectangle, index) => ({ id: `polygon-${String(index)}`,
    vertices: [rectangle.min, [rectangle.max[0], rectangle.min[1]], rectangle.max, [rectangle.min[0], rectangle.max[1]]] }));
  const portals: NavPortal[] = [];
  for (let a = 0; a < polygons.length; a += 1) {
    const first = polygons[a];
    if (first === undefined) continue;
    for (let b = a + 1; b < polygons.length; b += 1) {
      const second = polygons[b];
      if (second === undefined) continue;
      const endpoints = sharedEdge(rectOf(first), rectOf(second));
      if (endpoints !== null) portals.push({ id: `portal-${String(portals.length)}`, polygons: [first.id, second.id], endpoints });
    }
  }
  return { schema: "precinct.navmesh.v1", agentRadius: source.agentRadius, agentHeight: PLAYER_HEIGHT,
    floorY: source.floorY, bounds: arrangement(source).bounds, sourceCanonical: canonicalNavmeshSource(source), sourceSha256, polygons, portals };
}

/** Exact polygon/portal checks, coverage area and source agreement. Empty means geometrically valid. */
export function validatePrecinctNavmesh(mesh: Omit<PrecinctNavmesh, "schema"> & { readonly schema: string }, source: NavmeshSource): readonly string[] {
  const issues: string[] = [];
  const { bounds, blockers } = arrangement(source);
  if (mesh.schema !== "precinct.navmesh.v1" || mesh.agentRadius !== source.agentRadius || mesh.agentHeight !== PLAYER_HEIGHT || mesh.floorY !== source.floorY
    || canonicalNavmeshSource(source) !== mesh.sourceCanonical || !/^[a-f0-9]{64}$/.test(mesh.sourceSha256)) issues.push("Source/version/radius metadata mismatch.");
  if (!equal(bounds.min, mesh.bounds.min) || !equal(bounds.max, mesh.bounds.max)) issues.push("Mesh bounds mismatch.");
  const byId = new Map(mesh.polygons.map((polygon) => [polygon.id, polygon]));
  if (byId.size !== mesh.polygons.length) issues.push("Duplicate polygon ID.");
  const portalIds = new Set<string>(); const adjacency = new Set<string>();
  for (const polygon of mesh.polygons) {
    const rect = rectOf(polygon);
    const expected = [rect.min, [rect.max[0], rect.min[1]], rect.max, [rect.min[0], rect.max[1]]] as const;
    if (!polygon.vertices.flat().every(Number.isFinite) || rect.max[0] - rect.min[0] <= EPSILON || rect.max[1] - rect.min[1] <= EPSILON
      || polygon.vertices.some((point, index) => !equal(point, expected[index] ?? [NaN, NaN]))
      || !contains(bounds, rect.min) || !contains(bounds, rect.max)) issues.push(`Invalid convex polygon ${polygon.id}.`);
    if (blockers.some((blocker) => overlaps(rect, blocker))) issues.push(`Polygon ${polygon.id} overlaps a clearance-expanded blocker.`);
  }
  for (const portal of mesh.portals) {
    const a = byId.get(portal.polygons[0]); const b = byId.get(portal.polygons[1]);
    const expected = a === undefined || b === undefined || a.id === b.id ? null : sharedEdge(rectOf(a), rectOf(b));
    const key = [...portal.polygons].sort(compare).join("|");
    if (portalIds.has(portal.id) || adjacency.has(key)) issues.push(`Duplicate portal ${portal.id}.`);
    portalIds.add(portal.id); adjacency.add(key);
    if (expected === null || !equal(expected[0], portal.endpoints[0]) || !equal(expected[1], portal.endpoints[1])) issues.push(`Invalid shared-edge portal ${portal.id}.`);
    const from: Vec3 = [portal.endpoints[0][0], mesh.floorY, portal.endpoints[0][1]];
    const to: Vec3 = [portal.endpoints[1][0], mesh.floorY, portal.endpoints[1][1]];
    if (!hasLineOfSight(from, to, source.colliders, source.agentRadius)) issues.push(`Portal ${portal.id} lacks capsule clearance.`);
  }
  for (let a = 0; a < mesh.polygons.length; a += 1) {
    const first = mesh.polygons[a];
    if (first === undefined) continue;
    for (const second of mesh.polygons.slice(a + 1)) {
      if (overlaps(rectOf(first), rectOf(second))) issues.push(`Overlapping polygon interiors ${first.id}/${second.id}.`);
      if (sharedEdge(rectOf(first), rectOf(second)) !== null && !adjacency.has([first.id, second.id].sort(compare).join("|"))) issues.push(`Missing portal ${first.id}/${second.id}.`);
    }
  }
  const expectedArea = freeRectangles(source).reduce((sum, rectangle) => sum + area(rectangle), 0);
  const actualArea = mesh.polygons.reduce((sum, polygon) => sum + area(rectOf(polygon)), 0);
  if (!Number.isFinite(actualArea) || Math.abs(expectedArea - actualArea) > Math.max(1, expectedArea) * 1e-9) issues.push("Free-space coverage area mismatch.");
  return issues;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const point = (value: unknown): value is NavPoint => Array.isArray(value) && value.length === 2 && value.every((entry: unknown) => typeof entry === "number" && Number.isFinite(entry));
function polygonShape(value: unknown): value is NavPolygon {
  return record(value) && typeof value["id"] === "string" && Array.isArray(value["vertices"])
    && value["vertices"].length === 4 && value["vertices"].every(point);
}
function portalShape(value: unknown): value is NavPortal {
  return record(value) && typeof value["id"] === "string" && Array.isArray(value["polygons"])
    && value["polygons"].length === 2 && value["polygons"].every((entry: unknown) => typeof entry === "string")
    && Array.isArray(value["endpoints"]) && value["endpoints"].length === 2 && value["endpoints"].every(point);
}

/** Static JSON is still validated before any navigation. A stale or corrupt mesh is unavailable. */
export function readPrecinctNavmesh(value: unknown, source: NavmeshSource): PrecinctNavmesh | null {
  if (!record(value) || value["schema"] !== "precinct.navmesh.v1" || typeof value["agentRadius"] !== "number"
    || typeof value["agentHeight"] !== "number" || typeof value["floorY"] !== "number"
    || typeof value["sourceCanonical"] !== "string" || typeof value["sourceSha256"] !== "string"
    || !record(value["bounds"]) || !point(value["bounds"]["min"]) || !point(value["bounds"]["max"])
    || !Array.isArray(value["polygons"]) || value["polygons"].length > 5000 || !value["polygons"].every(polygonShape)
    || !Array.isArray(value["portals"]) || value["portals"].length > 20000 || !value["portals"].every(portalShape)) return null;
  const mesh: PrecinctNavmesh = { schema: "precinct.navmesh.v1", agentRadius: value["agentRadius"], agentHeight: value["agentHeight"], floorY: value["floorY"],
    bounds: { min: value["bounds"]["min"], max: value["bounds"]["max"] }, sourceCanonical: value["sourceCanonical"], sourceSha256: value["sourceSha256"],
    polygons: value["polygons"], portals: value["portals"] };
  return validatePrecinctNavmesh(mesh, source).length === 0 ? mesh : null;
}

function corridor(mesh: PrecinctNavmesh, start: NavPoint, destination: NavPoint): readonly NavPortal[] | null {
  const byId = new Map(mesh.polygons.map((polygon) => [polygon.id, polygon]));
  const first = mesh.polygons.find((polygon) => contains(rectOf(polygon), start));
  const last = mesh.polygons.find((polygon) => contains(rectOf(polygon), destination));
  if (first === undefined || last === undefined) return null;
  if (first.id === last.id) return [];
  const costs = new Map<string, number>([[first.id, 0]]);
  const pending = [{ polygon: first, cost: 0, portals: [] as readonly NavPortal[] }];
  while (pending.length > 0) {
    pending.sort((a, b) => (b.cost + distance(center(rectOf(b.polygon)), destination)) - (a.cost + distance(center(rectOf(a.polygon)), destination)) || compare(b.polygon.id, a.polygon.id));
    const current = pending.pop();
    if (current === undefined || current.cost > (costs.get(current.polygon.id) ?? Infinity)) continue;
    if (current.polygon.id === last.id) return current.portals;
    for (const portal of mesh.portals) {
      const nextId = portal.polygons[0] === current.polygon.id ? portal.polygons[1] : portal.polygons[1] === current.polygon.id ? portal.polygons[0] : undefined;
      const next = nextId === undefined ? undefined : byId.get(nextId);
      if (next === undefined) continue;
      const cost = current.cost + distance(center(rectOf(current.polygon)), center(rectOf(next)));
      if (cost >= (costs.get(next.id) ?? Infinity)) continue;
      costs.set(next.id, cost); pending.push({ polygon: next, cost, portals: [...current.portals, portal] });
    }
  }
  return null;
}

/** Clockwise signed area, matching the right/left tightening tests below. */
function signedArea(a: NavPoint, b: NavPoint, c: NavPoint): number { return (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]); }

function funnel(start: NavPoint, destination: NavPoint, edges: readonly (readonly [NavPoint, NavPoint])[]): readonly NavPoint[] {
  const portals = [[start, start] as const, ...edges, [destination, destination] as const];
  const path: NavPoint[] = [];
  let apex = start; let left = start; let right = start;
  let leftIndex = 0; let rightIndex = 0;
  for (let index = 1; index < portals.length; index += 1) {
    const edge = portals[index];
    if (edge === undefined) continue;
    const [nextLeft, nextRight] = edge;
    if (signedArea(apex, right, nextRight) <= 0) {
      if (equal(apex, right) || signedArea(apex, left, nextRight) > 0) { right = nextRight; rightIndex = index; }
      else { path.push(left); apex = left; index = leftIndex; left = apex; right = apex; rightIndex = index; continue; }
    }
    if (signedArea(apex, left, nextLeft) >= 0) {
      if (equal(apex, left) || signedArea(apex, right, nextLeft) < 0) { left = nextLeft; leftIndex = index; }
      else { path.push(right); apex = right; index = rightIndex; left = apex; right = apex; leftIndex = index; }
    }
  }
  if (path.length === 0 || !equal(path[path.length - 1] ?? start, destination)) path.push(destination);
  return path;
}

/** Local crowd avoidance may move away from its corridor, but must stay on its authored free surface. */
export function isPointOnNavmesh(position: Vec3, mesh: PrecinctNavmesh): boolean {
  return position.every(Number.isFinite) && Math.abs(position[1] - mesh.floorY) <= EPSILON
    && mesh.polygons.some((polygon) => contains(rectOf(polygon), [position[0], position[2]]));
}

/** Polygon A* and portal funnel. Every output chord is rechecked against current collision geometry. */
export function findNavmeshRoute(start: Vec3, destination: Vec3, mesh: PrecinctNavmesh, colliders: readonly Collider[]): readonly Vec3[] | null {
  if (![...start, ...destination].every(Number.isFinite) || Math.abs(start[1] - mesh.floorY) > EPSILON || Math.abs(destination[1] - mesh.floorY) > EPSILON) return null;
  if (!hasLineOfSight(start, start, colliders, mesh.agentRadius) || !hasLineOfSight(destination, destination, colliders, mesh.agentRadius)) return null;
  const from: NavPoint = [start[0], start[2]]; const to: NavPoint = [destination[0], destination[2]];
  const portals = corridor(mesh, from, to);
  if (portals === null) return null;
  if (equal(from, to)) return [];
  const byId = new Map(mesh.polygons.map((polygon) => [polygon.id, polygon]));
  let current = mesh.polygons.find((polygon) => contains(rectOf(polygon), from));
  const edges: (readonly [NavPoint, NavPoint])[] = [];
  for (const portal of portals) {
    if (current === undefined) return null;
    const next = byId.get(portal.polygons[0] === current.id ? portal.polygons[1] : portal.polygons[0]);
    if (next === undefined) return null;
    const a = center(rectOf(current)); const b = center(rectOf(next));
    const [one, two] = portal.endpoints;
    // A centroid chord can miss a short shared edge entirely when rectangles are skewed.
    // Compare endpoints to each other, not to zero: both may lie on the same chord side.
    edges.push(signedArea(a, b, one) < signedArea(a, b, two) ? [one, two] : [two, one]); current = next;
  }
  const result = funnel(from, to, edges).map((point): Vec3 => [point[0], mesh.floorY, point[1]]);
  let previous = start;
  for (const point of result) {
    if (!hasLineOfSight(previous, point, colliders, mesh.agentRadius)) return null;
    previous = point;
  }
  return result;
}
