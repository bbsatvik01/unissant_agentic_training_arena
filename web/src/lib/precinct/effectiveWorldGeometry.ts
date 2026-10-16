/** Frozen geometry-composition seam shared by Canvas collision and navmesh authoring. */
import { withReviewerColliderV2 } from "./proceduralReviewerV2";
import type { Collider, Vec3 } from "./types";

export const EFFECTIVE_WORLD_GEOMETRY_VERSION = "precinct.effective-geometry.v1";
export const STAFF_NAVMESH_RADIUS = 0.34;
export const STAFF_NAVMESH_FLOOR_Y = 0.03;

/** World selection happens first. The same idempotent original overlay is then applied once. */
export function effectivePrecinctColliders(colliders: readonly Collider[]): readonly Collider[] {
  return withReviewerColliderV2(colliders);
}

export interface AuthoredCollisionGeometry {
  readonly colliders: readonly Collider[];
  readonly walkBounds: { readonly min: Vec3; readonly max: Vec3 };
}

/** Return exactly the source accepted by the radius-specific convex navigation mesh. */
export function effectivePrecinctNavmeshSource(manifest: AuthoredCollisionGeometry) {
  return {
    bounds: { min: [manifest.walkBounds.min[0], manifest.walkBounds.min[2]] as const,
      max: [manifest.walkBounds.max[0], manifest.walkBounds.max[2]] as const },
    floorY: STAFF_NAVMESH_FLOOR_Y,
    agentRadius: STAFF_NAVMESH_RADIUS,
    colliders: effectivePrecinctColliders(manifest.colliders),
  };
}
