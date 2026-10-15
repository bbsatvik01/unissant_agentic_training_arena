/** Exact profile selection. A valid mesh saying unreachable is never a graph-fallback invitation. */
import { effectivePrecinctNavmeshSource, type AuthoredCollisionGeometry } from "./effectiveWorldGeometry";
import { findWaypointRoute, PLAYER_RADIUS } from "./movement";
import { findNavmeshRoute, readPrecinctNavmesh, type NavmeshSource, type PrecinctNavmesh } from "./precinctNavmesh";
import type { PrecinctWorldId } from "./sceneSelection";
import type { Collider, NavigationNode, Vec3 } from "./types";

export const WORLD_NAVMESH_SCHEMA = "precinct.world-navmeshes.v1";
export type NavigationProfile = "player" | "staff";
export type NavigationContext = "live" | "legacy-replay" | "sampled-replay";
export interface NavigationProfileStatus { readonly mode: "mesh" | "graph"; readonly reason: "ready" | "missing" | "invalid" | "legacy-compatibility" | "replay-owned" }
export interface WorldNavigationStatus { readonly context: NavigationContext; readonly player: NavigationProfileStatus; readonly staff: NavigationProfileStatus }
export interface WorldNavigation {
  readonly player: PrecinctNavmesh | null;
  readonly staff: PrecinctNavmesh | null;
  readonly status: WorldNavigationStatus;
}
export interface WorldNavmeshBundle {
  readonly schema: typeof WORLD_NAVMESH_SCHEMA;
  readonly worldId: PrecinctWorldId;
  readonly player: PrecinctNavmesh;
  readonly staff: PrecinctNavmesh;
}
const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

export function worldNavmeshSource(manifest: AuthoredCollisionGeometry, profile: NavigationProfile): NavmeshSource {
  const staff = effectivePrecinctNavmeshSource(manifest);
  return profile === "staff" ? staff : { ...staff, floorY: 0, agentRadius: PLAYER_RADIUS };
}

/** The supplied files are bundled, but still reject malformed, stale and cross-world geometry. */
export function resolveWorldNavigation(value: unknown, worldId: PrecinctWorldId, manifest: AuthoredCollisionGeometry, context: NavigationContext = "live"): WorldNavigation {
  const unavailable = (reason: NavigationProfileStatus["reason"]): WorldNavigation => ({ player: null, staff: null,
    status: { context, player: { mode: "graph", reason }, staff: { mode: "graph", reason } } });
  if (context === "legacy-replay") return unavailable("legacy-compatibility");
  if (context === "sampled-replay") return unavailable("replay-owned");
  if (value === null || value === undefined) return unavailable("missing");
  if (!record(value) || value["schema"] !== WORLD_NAVMESH_SCHEMA || value["worldId"] !== worldId) return unavailable("invalid");
  try {
    const player = readPrecinctNavmesh(value["player"], worldNavmeshSource(manifest, "player"));
    const staff = readPrecinctNavmesh(value["staff"], worldNavmeshSource(manifest, "staff"));
    return { player, staff, status: { context,
      player: { mode: player === null ? "graph" : "mesh", reason: player === null ? "invalid" : "ready" },
      staff: { mode: staff === null ? "graph" : "mesh", reason: staff === null ? "invalid" : "ready" } } };
  } catch { return unavailable("invalid"); }
}

export interface RouteGeometry { readonly colliders: readonly Collider[]; readonly navigationNodes: readonly NavigationNode[] }
/** No fallback after a valid mesh returns null; radius/height mismatches also fail closed. */
export function planNavigationRoute(start: Vec3, destination: Vec3, geometry: RouteGeometry, mesh: PrecinctNavmesh | null | undefined, radius = PLAYER_RADIUS): readonly Vec3[] | null {
  if (mesh == null) return findWaypointRoute(start, destination, geometry.navigationNodes, geometry.colliders, radius);
  if (Math.abs(mesh.agentRadius - radius) > 1e-8) return null;
  return findNavmeshRoute(start, destination, mesh, geometry.colliders);
}

export function navigationStatusText(status: WorldNavigationStatus): string {
  if (status.context === "sampled-replay") return "Recorded movement owns this scene; live navigation planning is paused.";
  if (status.context === "legacy-replay") return "Legacy replay retains the original waypoint navigation behavior.";
  const fallback = (["player", "staff"] as const).filter((profile) => status[profile].mode === "graph");
  if (fallback.length === 0) return "Polygon navigation is active for walking and staff.";
  return `Waypoint fallback for ${fallback.map((profile) => `${profile} (${status[profile].reason} mesh)`).join(" and ")}. Unreachable polygon routes never switch to waypoints.`;
}
