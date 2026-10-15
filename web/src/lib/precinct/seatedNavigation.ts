import type { LookAngles, Vec3 } from "./types";

export interface ExplorationPose {
  readonly position: Vec3;
  readonly look: LookAngles;
}

/** Save only on entry, restore only on exit. The walking capsule never moves into furniture. */
export function seatedNavigation(saved: ExplorationPose | null, current: ExplorationPose, seated: boolean): {
  readonly saved: ExplorationPose | null;
  readonly pose: ExplorationPose;
  readonly changed: boolean;
} {
  if (seated && saved === null) return {
    saved: { position: [...current.position], look: { ...current.look } }, pose: current, changed: true,
  };
  if (!seated && saved !== null) return { saved: null, pose: saved, changed: true };
  return { saved, pose: current, changed: false };
}
