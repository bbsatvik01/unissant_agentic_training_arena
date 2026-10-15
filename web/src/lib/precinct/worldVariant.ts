/** Known, local world assets only. This adds no camera or session state owner. */
import type { Vec3 } from "./types";

export interface WorldVariantMetadata {
  readonly asset?: string;
  readonly worldVariant?: { readonly id: string; readonly footprintBounds?: { readonly min: Vec3; readonly max: Vec3 } };
  readonly walkBounds?: { readonly min: Vec3; readonly max: Vec3 };
}

export interface PointerFloor {
  readonly center: Vec3;
  readonly size: readonly [number, number];
}

export const BASELINE_POINTER_FLOOR: PointerFloor = { center: [0, 0.015, -18], size: [28, 36] };

export function precinctAsset(manifest: WorldVariantMetadata): string {
  return manifest.worldVariant?.id === "northstar-courtyard-v1" && manifest.asset === "precinct-courtyard.glb"
    ? "/world/precinct-courtyard.glb" : "/world/precinct.glb";
}

export function precinctPointerFloor(manifest: WorldVariantMetadata): PointerFloor {
  if (precinctAsset(manifest) !== "/world/precinct-courtyard.glb" || manifest.walkBounds === undefined) return BASELINE_POINTER_FLOOR;
  const { min, max } = manifest.walkBounds;
  if (![...min, ...max].every(Number.isFinite) || max[0] <= min[0] || max[2] <= min[2]) return BASELINE_POINTER_FLOOR;
  return { center: [(min[0] + max[0]) / 2, 0.015, (min[2] + max[2]) / 2], size: [max[0] - min[0], max[2] - min[2]] };
}

export interface MinimapFrame {
  readonly viewBox: string;
  readonly footprint: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export const BASELINE_MINIMAP_FRAME: MinimapFrame = {
  viewBox: "-15 -37 30 38", footprint: { x: -14, y: -36, width: 28, height: 36 },
};

/** Keep SVG in unchanged world X/Z coordinates; framing expands without moving stations. */
export function precinctMinimapFrame(manifest: WorldVariantMetadata): MinimapFrame {
  if (precinctAsset(manifest) !== "/world/precinct-courtyard.glb" || manifest.worldVariant?.footprintBounds === undefined) return BASELINE_MINIMAP_FRAME;
  const { min, max } = manifest.worldVariant.footprintBounds;
  if (![...min, ...max].every(Number.isFinite) || max[0] <= min[0] || max[2] <= min[2]) return BASELINE_MINIMAP_FRAME;
  const width = max[0] - min[0];
  const height = max[2] - min[2];
  return { viewBox: [min[0] - 1, min[2] - 1, width + 2, height + 2].join(" "),
    footprint: { x: min[0], y: min[2], width, height } };
}

export function precinctMinimapPoint(position: Vec3): readonly [number, number] {
  return [position[0], position[2]];
}
