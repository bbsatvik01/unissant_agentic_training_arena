/** Finite original crowd-driven patrol body. Every applied limb is a function of clip + one time. */
import { sampleStaffPose, type StaffPose } from "./proceduralStaffV1";
export type PatrolCycleV2 = "walk" | "idle" | "still";
export type PatrolClipIdV2 = `precinct.staff.v2.patrol.${PatrolCycleV2}`;
export const PATROL_SPEED_V2 = 0.85;
export const PATROL_PHASE_V2 = 4.6;
export const PROCEDURAL_PATROL_CLIPS_V2: readonly PatrolClipIdV2[] = Object.freeze([
  "precinct.staff.v2.patrol.walk", "precinct.staff.v2.patrol.idle", "precinct.staff.v2.patrol.still",
]);
export function patrolClipV2(cycle: PatrolCycleV2): PatrolClipIdV2 { return `precinct.staff.v2.patrol.${cycle}`; }
export function patrolCycleV2(clip: string): PatrolCycleV2 | null {
  if (clip === "precinct.staff.v2.patrol.walk") return "walk";
  if (clip === "precinct.staff.v2.patrol.idle") return "idle";
  if (clip === "precinct.staff.v2.patrol.still") return "still";
  return null;
}
export interface PatrolTimeV2 {
  readonly cycle: PatrolCycleV2;
  readonly time: number;
  /** Live-only previous actual crowd distance. It is never encoded or required for replay. */
  readonly walkedDistance: number;
}
export interface PatrolTravelV2 { readonly walkedDistance: number; readonly speed: number }
const finite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
/**
 * Walk advances by measured displacement, not simulation time or requested velocity. Idle has a
 * bounded visual clock. Every transition resets that finite cycle's time; pause/reduced motion is
 * the explicit still cycle. First attachment rebases travel without catch-up. Navigation resets
 * rebase distance rather than advancing or reversing.
 */
export function advancePatrolV2(current: PatrolTimeV2 | null, travel: PatrolTravelV2, delta: number, still: boolean): PatrolTimeV2 {
  const walkedDistance = finite(travel.walkedDistance);
  const distance = Math.max(0, walkedDistance - (current === null ? walkedDistance : finite(current.walkedDistance)));
  if (still) return { cycle: "still", time: 0, walkedDistance };
  const cycle = (current === null || distance > 1e-8) && finite(travel.speed) > 1e-8 ? "walk" : "idle";
  const time = current?.cycle === cycle ? finite(current.time) : 0;
  return { cycle, time: time + (cycle === "walk" ? distance / PATROL_SPEED_V2 : Math.min(0.05, finite(delta))), walkedDistance };
}
/** No navigation, speed-dependent amplitude, wall clock or audio enters the versioned evaluator. */
export function samplePatrolBodyV2(cycle: PatrolCycleV2, seconds: number): StaffPose {
  const time = cycle === "still" ? 0 : finite(seconds);
  return sampleStaffPose("patrol", time + PATROL_PHASE_V2, cycle === "walk" ? time * PATROL_SPEED_V2 : 0, cycle === "walk" ? PATROL_SPEED_V2 : 0, cycle === "still");
}
