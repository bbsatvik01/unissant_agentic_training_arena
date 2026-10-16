import { describe, expect, it } from "vitest";
import { proceduralClip, PROCEDURAL_CLIPS_V1, staffClip } from "./proceduralActors";
import { advancePatrolV2, patrolClipV2, patrolCycleV2, PROCEDURAL_PATROL_CLIPS_V2, samplePatrolBodyV2, type PatrolTimeV2 } from "./proceduralPatrolV2";
import { PRECINCT_STAFF, sampleStaffPose } from "./proceduralStaffV1";
import type { PoseData } from "../world/worldEvents";
function pose(clip: string, actor_id = "staff:patrol"): PoseData { return { actor_id, position: [1, 0.03, -16], rotation: [0, 0, 0, 1], animation: { clip, time: 3 } }; }
describe("finite patrol v2, preserving every v1 identifier", () => {
  it("adds only three patrol-only clips and refuses unknown, mismatched and invalid samples", () => {
    expect(PROCEDURAL_PATROL_CLIPS_V2).toEqual(["precinct.staff.v2.patrol.walk", "precinct.staff.v2.patrol.idle", "precinct.staff.v2.patrol.still"]);
    expect(PROCEDURAL_CLIPS_V1).toHaveLength(143);
    for (const cycle of ["walk", "idle", "still"] as const) {
      const clip = patrolClipV2(cycle); expect(patrolCycleV2(clip)).toBe(cycle);
      expect(proceduralClip(pose(clip))).toEqual({ family: "patrol-v2", staff: PRECINCT_STAFF.find((staff) => staff.id === "patrol"), cycle });
      expect(proceduralClip(pose(clip, "staff:sergeant"))).toBeNull(); expect(PROCEDURAL_CLIPS_V1).not.toContain(clip);
      expect(proceduralClip({ ...pose(clip), rotation: [0, 0, 0, 2] })).toBeNull();
    }
    expect(patrolCycleV2("precinct.staff.v2.patrol.run")).toBeNull(); expect(proceduralClip(pose("precinct.staff.v2.patrol.run"))).toBeNull();
    for (const staff of PRECINCT_STAFF) for (const still of [false, true]) expect(proceduralClip(pose(staffClip(staff.id, still), `staff:${staff.id}`))).toEqual({ family: "staff", staff, still });
  });
  it("uses one distance clock for walk and a bounded idle clock with explicit stop/pause/reset transitions", () => {
    const attached = advancePatrolV2(null, { speed: 0.85, walkedDistance: 20 }, 0.05, false);
    expect(attached).toEqual({ cycle: "walk", time: 0, walkedDistance: 20 });
    const walk = advancePatrolV2(attached, { speed: 0.425, walkedDistance: 20.0425 }, 0.01, false);
    expect(walk.time).toBeCloseTo(0.05); expect(walk.cycle).toBe("walk");
    const sameDistanceOtherSpeed = advancePatrolV2(attached, { speed: 1.2, walkedDistance: 20.0425 }, 10, false);
    expect(sameDistanceOtherSpeed).toEqual(walk);
    const blocked = advancePatrolV2(walk, { speed: 0.85, walkedDistance: walk.walkedDistance }, 1, false);
    expect(blocked.cycle).toBe("idle"); expect(blocked.time).toBe(0.05);
    const idle = advancePatrolV2(blocked, { speed: 0, walkedDistance: blocked.walkedDistance }, 0.01, false); expect(idle.time).toBeCloseTo(0.06);
    const paused = advancePatrolV2(idle, { speed: 0, walkedDistance: idle.walkedDistance }, 100, true); expect(paused.cycle).toBe("still"); expect(paused.time).toBe(0);
    const reset = advancePatrolV2(walk, { speed: 0, walkedDistance: 0 }, 0.01, false); expect(reset).toEqual({ cycle: "idle", time: 0.01, walkedDistance: 0 });
    const resumed = advancePatrolV2(paused, { speed: 0.85, walkedDistance: paused.walkedDistance + 0.085 }, 100, false); expect(resumed.time).toBeCloseTo(0.1);
  });
  it("pins body amplitude, phase, head and blink to the finite cycle and its time alone", () => {
    for (const time of [0, 0.18, 1.02, 3, 5.61, 20]) {
      expect(samplePatrolBodyV2("walk", time)).toEqual(sampleStaffPose("patrol", time + 4.6, time * 0.85, 0.85, false));
      expect(samplePatrolBodyV2("idle", time)).toEqual(sampleStaffPose("patrol", time + 4.6, 0, 0, false));
      expect(samplePatrolBodyV2("still", time)).toEqual(sampleStaffPose("patrol", 4.6, 0, 0, true));
    }
    for (const value of [NaN, Infinity, -Infinity, -10]) {
      const bad: PatrolTimeV2 = { cycle: "walk", time: value, walkedDistance: value };
      const result = advancePatrolV2(bad, { speed: value, walkedDistance: value }, value, false);
      expect(result).toEqual({ cycle: "idle", time: 0, walkedDistance: 0 });
      expect(Object.values(samplePatrolBodyV2("walk", value)).every(Number.isFinite)).toBe(true);
    }
  });
});
