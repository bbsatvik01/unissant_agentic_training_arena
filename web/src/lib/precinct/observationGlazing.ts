/** Original two-triangle viewing-side finish for the authored observation partition.
 * This is a directional scene treatment, not a security/privacy boundary or physical optics model.
 * +Z faces the interview room. The observer-side back face is culled, retaining the original glass.
 */
import type { Vec3 } from "./types";

export const OBSERVATION_MIRROR = {
  position: [8.05, 1.87, -15.981] as Vec3,
  size: [6.1, 1.78] as const,
  normal: [0, 0, 1] as Vec3,
  color: "#849398",
  roughness: 0.16,
  metalness: 0.92,
} as const;

/** Diagnostic only: chooses the visible finish from the same plane normal as the renderer. */
export function observationGlassFace(position: Vec3): "mirror" | "viewing" {
  return position[2] >= OBSERVATION_MIRROR.position[2] ? "mirror" : "viewing";
}
