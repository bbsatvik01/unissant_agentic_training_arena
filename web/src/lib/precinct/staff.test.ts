import { describe, expect, it } from "vitest";

import {
  advanceStaffClock, PATROL_CYCLE_SECONDS, PATROL_DISTANCE, PATROL_SPEED, PATROL_STOPS,
  PRECINCT_STAFF, samplePatrol, sampleStaff, sampleStaffPose, staffForTier, STAFF_RADIUS,
  type StaffActivity,
} from "./staff";
import type { Collider, NavigationNode, Vec3 } from "./types";
import manifestJson from "../../../public/world/precinct-manifest.json?raw";

const manifest = JSON.parse(manifestJson) as {
  colliders: readonly Collider[];
  navigationNodes: readonly NavigationNode[];
};
function clear(position: Vec3, colliders = manifest.colliders, radius = STAFF_RADIUS): boolean {
  return !colliders.some((c) => c.max[1] > position[1] && c.min[1] < position[1] + 1.8
    && position[0] > c.min[0] - radius && position[0] < c.max[0] + radius
    && position[2] > c.min[2] - radius && position[2] < c.max[2] + radius);
}

describe("authored precinct staff", () => {
  it("retains both conversational staff on every tier and bounds the crowd", () => {
    expect(staffForTier("low").map((staff) => staff.id)).toEqual(["receptionist", "sergeant"]);
    expect(staffForTier("medium")).toHaveLength(3);
    expect(staffForTier("high")).toHaveLength(4);
    expect(new Set(PRECINCT_STAFF.map((staff) => staff.id)).size).toBe(4);
  });

  it("keeps stationary staff clear of all architecture and furniture except the analyst's existing chair", () => {
    for (const staff of PRECINCT_STAFF) {
      const blockers = staff.activity === "desk" ? manifest.colliders.filter((c) => !c.id.startsWith("chair-")) : manifest.colliders;
      expect(clear(staff.position, blockers), staff.id).toBe(true);
    }
    const analyst = PRECINCT_STAFF.find((staff) => staff.id === "analyst");
    expect(analyst).toBeDefined();
    if (analyst !== undefined) expect(clear(analyst.position)).toBe(false);
  });

  it("keeps stationary colleagues off the authored automatic-navigation segments", () => {
    for (const staff of PRECINCT_STAFF.filter((value) => value.activity !== "patrol")) {
      for (const a of manifest.navigationNodes) {
        for (const id of a.neighbors) {
          const b = manifest.navigationNodes.find((value) => value.id === id);
          if (b === undefined) continue;
          const dx = b.position[0] - a.position[0];
          const dz = b.position[2] - a.position[2];
          const size = dx * dx + dz * dz;
          const t = size === 0 ? 0 : Math.max(0, Math.min(1, ((staff.position[0] - a.position[0]) * dx + (staff.position[2] - a.position[2]) * dz) / size));
          const distance = Math.hypot(staff.position[0] - a.position[0] - dx * t, staff.position[2] - a.position[2] - dz * t);
          expect(distance, `${staff.id} overlaps navigation ${a.id} -> ${id}`).toBeGreaterThan(STAFF_RADIUS + 0.28);
        }
      }
    }
  });

  it("uses a finite, collision-clear corridor route with no doorway crossing", () => {
    expect(PATROL_STOPS).toHaveLength(4);
    for (const stop of PATROL_STOPS) {
      expect(stop.position[0]).toBe(1.15);
      expect(stop.waitSeconds).toBeGreaterThanOrEqual(4);
    }
    for (let seconds = 0; seconds <= PATROL_CYCLE_SECONDS * 2; seconds += 0.1) {
      const sample = samplePatrol(seconds);
      expect(clear(sample.position), `blocked at ${seconds.toFixed(2)}s`).toBe(true);
      expect(sample.position[2]).toBeGreaterThanOrEqual(-31.1);
      expect(sample.position[2]).toBeLessThanOrEqual(-14.6);
      expect(sample.speed).toBeGreaterThanOrEqual(0);
      expect(sample.speed).toBeLessThanOrEqual(PATROL_SPEED * 1.5 + 1e-8);
    }
  });

  it("is deterministic, loops continuously, and never teleports between stops", () => {
    expect(samplePatrol(12.5)).toEqual(samplePatrol(12.5));
    for (let seconds = 0; seconds < PATROL_CYCLE_SECONDS; seconds += 0.17) {
      const a = samplePatrol(seconds);
      const b = samplePatrol(seconds + 0.01);
      expect(Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2])).toBeLessThan(0.014);
      expect(b.walkedDistance).toBeGreaterThanOrEqual(a.walkedDistance);
    }
    const first = samplePatrol(0);
    const next = samplePatrol(PATROL_CYCLE_SECONDS);
    expect(next.position).toEqual(first.position);
    expect(next.yaw).toBeCloseTo(first.yaw);
    expect(next.walkedDistance - first.walkedDistance).toBeCloseTo(PATROL_DISTANCE);
  });

  it("holds at a stop while turning before departing", () => {
    expect(samplePatrol(2).speed).toBe(0);
    expect(samplePatrol(8).position).toEqual(samplePatrol(2).position);
    expect(samplePatrol(8).yaw).not.toBe(samplePatrol(2).yaw);
    expect(samplePatrol(11).speed).toBeGreaterThan(0);
  });

  it("uses elapsed time only for the patrol; desk/reception/sergeant locations stay fixed", () => {
    for (const staff of PRECINCT_STAFF) {
      const sample = sampleStaff(staff, 12);
      expect(sample).toEqual(staff.activity === "patrol" ? samplePatrol(12)
        : { position: staff.position, yaw: staff.yaw, speed: 0, walkedDistance: 0 });
    }
  });

  it.each([NaN, Infinity, -5])("bounds invalid or negative patrol time (%s)", (time) => {
    expect(samplePatrol(time)).toEqual(samplePatrol(0));
  });
});

describe("presentation clock and motion", () => {
  it("freezes under either pause control and resumes without catching up", () => {
    expect(advanceStaffClock(10, 1 / 60, true, false)).toBe(10);
    expect(advanceStaffClock(10, 1 / 60, false, true)).toBe(10);
    expect(advanceStaffClock(10, 30, false, false)).toBe(10.05);
    expect(advanceStaffClock(10, 0.01, false, false)).toBe(10.01);
  });

  it("never moves backwards or accepts non-finite clock input", () => {
    for (const delta of [-1, NaN, Infinity]) expect(advanceStaffClock(10, delta, false, false)).toBe(10);
    expect(advanceStaffClock(NaN, 0, false, false)).toBe(0);
    expect(advanceStaffClock(-3, 0, true, false)).toBe(0);
  });

  it.each<StaffActivity>(["standing", "counter", "desk", "patrol"])("holds a neutral, time-invariant %s pose when motion is disabled", (activity) => {
    expect(sampleStaffPose(activity, 10, 0, 0, true)).toEqual(sampleStaffPose(activity, 400, 80, 1.2, true));
  });

  it("keeps seated knees and subtle desk work independent of gait", () => {
    const pose = sampleStaffPose("desk", 4, 0, 0, false);
    expect(pose.leftHip).toBe(-1.4);
    expect(pose.rightHip).toBe(-1.4);
    expect(pose.leftKnee).toBe(1.45);
    expect(Math.abs(pose.leftArm + 0.54)).toBeLessThanOrEqual(0.025);
    expect(pose.headYaw).toBe(0);
    expect(sampleStaffPose("counter", 4, 0, 0, false).leftHip).toBeCloseTo(0);
  });

  it("moves opposing limbs from traveled distance and compensates ankle angles", () => {
    const pose = sampleStaffPose("patrol", 0, 0.35, 1, false);
    expect(pose.leftHip).toBeLessThan(0);
    expect(pose.rightHip).toBeGreaterThan(0);
    expect(pose.leftFoot + pose.leftHip + pose.leftKnee).toBeCloseTo(0);
    expect(pose.rightFoot + pose.rightHip + pose.rightKnee).toBeCloseTo(0);
  });

  it("uses a bounded neutral blink and rejects non-finite animation inputs", () => {
    expect(sampleStaffPose("standing", 5.59, 0, 0, false).blink).toBeCloseTo(1);
    for (let t = 0; t < 20; t += 0.05) {
      const pose = sampleStaffPose("standing", t, 0, 0, false);
      expect(pose.blink).toBeGreaterThanOrEqual(0);
      expect(pose.blink).toBeLessThanOrEqual(1);
      expect(Math.abs(pose.headYaw)).toBeLessThanOrEqual(0.035);
    }
    expect(Object.values(sampleStaffPose("patrol", NaN, Infinity, NaN, false)).every(Number.isFinite)).toBe(true);
  });
});
