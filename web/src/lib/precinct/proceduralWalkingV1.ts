/** Original canonical gait v1: a single clip time drives stride and breathing. */
import type { WalkingCycle } from "./proceduralActors";
import type { StaffPose } from "./proceduralStaffV1";
export interface WalkingTimeV1 { readonly cycle: WalkingCycle; readonly time: number }
export interface WalkingTravel { readonly distance: number; readonly speed: number }
const finite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const speedFor = (cycle: WalkingCycle) => cycle === "run" ? 4.2 : cycle === "walk" ? 2.1 : 0;
const strideFor = (cycle: WalkingCycle) => cycle === "run" ? 2.43 : 2.115;
/** Actual collision-resolved distance, not intended velocity, advances locomotion. Teleports supply zero. */
export function advanceWalkingV1(previous: WalkingTimeV1, travel: WalkingTravel, delta: number, still: boolean): WalkingTimeV1 {
  const cycle: WalkingCycle = still ? "still" : finite(travel.distance) === 0 || finite(travel.speed) < 0.01 ? "idle" : travel.speed >= 2.7 ? "run" : "walk";
  if (cycle === "still") return { cycle, time: 0 };
  if (cycle === "idle") return { cycle, time: (previous.cycle === cycle ? finite(previous.time) : 0) + Math.min(0.05, finite(delta)) };
  const previousSpeed = speedFor(previous.cycle);
  const preserved = previousSpeed > 0 ? finite(previous.time) * previousSpeed / strideFor(previous.cycle) * strideFor(cycle) / speedFor(cycle) : 0;
  return { cycle, time: preserved + finite(travel.distance) / speedFor(cycle) };
}
/** Finite authored amplitudes intentionally replace the previous continuously speed-scaled gait. */
export function sampleWalkingV1(cycle: WalkingCycle, seconds: number): StaffPose {
  const time = finite(seconds);
  const velocity = speedFor(cycle);
  const swing = Math.sin(time * velocity * Math.PI * 2 / strideFor(cycle));
  const amplitude = cycle === "run" ? 0.744 : 0.597;
  const leftKnee = Math.max(0, swing) * 0.65;
  const rightKnee = Math.max(0, -swing) * 0.65;
  const breath = cycle === "still" ? 0 : Math.sin(time * 1.7) * 0.006;
  return {
    leftHip: -swing * amplitude, rightHip: swing * amplitude, leftKnee, rightKnee,
    leftFoot: swing * amplitude - leftKnee, rightFoot: -swing * amplitude - rightKnee,
    leftArm: swing * 0.32, rightArm: -swing * 0.32,
    leftElbow: -Math.max(0, -swing) * 0.13, rightElbow: -Math.max(0, swing) * 0.13,
    spine: breath + velocity * 0.009, headPitch: -breath * 0.45, headYaw: 0, blink: 0,
  };
}
