/** Shared live/replay body application. The renderer samples only after this applies the actual rig. */
import type { Object3D } from "three";
import type { CrowdAgent } from "../../lib/precinct/crowdNavigation";
import { advancePatrolV2, samplePatrolBodyV2, type PatrolCycleV2, type PatrolTimeV2 } from "../../lib/precinct/proceduralPatrolV2";
import type { StaffPose } from "../../lib/precinct/proceduralStaffV1";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot } from "./actorSamples";
type BodyRig = { readonly apply: (pose: StaffPose) => void };
export function applyLivePatrolBodyV2(root: Object3D, rig: BodyRig, current: PatrolTimeV2 | null,
  navigation: Pick<CrowdAgent, "position" | "yaw" | "speed" | "walkedDistance">, delta: number, still: boolean): PatrolTimeV2 {
  const next = advancePatrolV2(current, navigation, delta, still);
  root.position.set(...navigation.position); root.rotation.set(0, navigation.yaw + Math.PI, 0);
  rig.apply(samplePatrolBodyV2(next.cycle, next.time));
  return next;
}
/** No live accumulator, crowd input or capture callback exists on this replay path. */
export function applyRecordedPatrolBodyV2(root: Object3D, rig: BodyRig, sample: PoseData, cycle: PatrolCycleV2): void {
  applyActorRoot(root, sample);
  rig.apply(samplePatrolBodyV2(cycle, sample.animation.time));
}
