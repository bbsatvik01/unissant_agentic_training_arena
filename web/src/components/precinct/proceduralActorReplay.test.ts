import { Bone, Group, Quaternion, Vector3, type Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { ABSENT_CLIP, proceduralClip, SEATED_ACTORS_V1, seatedClip, staffActorId, staffClip, walkingClip } from "../../lib/precinct/proceduralActors";
import { moveWithCollisions } from "../../lib/precinct/movement";
import { advanceStaffClock, PATROL_CYCLE_SECONDS, PRECINCT_STAFF, sampleStaff, sampleStaffPose } from "../../lib/precinct/proceduralStaffV1";
import { advanceWalkingV1, sampleWalkingV1, type WalkingTimeV1 } from "../../lib/precinct/proceduralWalkingV1";
import { samplePatrolBodyV2 } from "../../lib/precinct/proceduralPatrolV2";
import type { Vec3 } from "../../lib/precinct/types";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot, createActorSampler, readActorRoot } from "./actorSamples";
import { syntheticRig } from "./proceduralRigFixture.testSupport";
import { prepareSeatedRig } from "./seatedAvatarRig";
import { applySeatedBodyV1 } from "./seatedBodyV1";
import { prepareStandingRigV1 } from "./standingAvatarRigV1";
function setup(seated = false) {
  const fixture = syntheticRig();
  const rig = seated ? prepareSeatedRig(fixture.root) : null;
  const standing = seated ? null : prepareStandingRigV1(fixture.root);
  const root = new Group(); root.add(fixture.root);
  return { ...fixture, model: fixture.root, root, rig, standing };
}
function sameBody(a: Object3D, b: Object3D) {
  const bones = new Map<string, Bone>(); b.traverse((object) => { if (object instanceof Bone) bones.set(object.name, object as Bone); });
  a.updateWorldMatrix(true, true); b.updateWorldMatrix(true, true);
  a.traverse((object) => {
    if (!(object instanceof Bone)) return;
    const other = bones.get(object.name); if (other === undefined) throw new Error(`Missing replay bone ${object.name}`);
    expect(object.quaternion.angleTo(other.quaternion), object.name).toBeLessThan(1e-6);
    expect(object.getWorldPosition(new Vector3()).distanceTo(other.getWorldPosition(new Vector3())), object.name).toBeLessThan(1e-8);
  });
}
function replayInto(sample: PoseData, target: ReturnType<typeof setup>) {
  const clip = proceduralClip(sample); if (clip === null || clip.family === "absent") throw new Error("Invalid visible replay fixture");
  if (clip.family === "reviewer-v2") throw new Error("Reviewer v2 parity has its own versioned suite");
  applyActorRoot(target.root, sample);
  if (clip.family === "seated") {
    if (target.rig === null) throw new Error("Expected seated rig");
    applySeatedBodyV1(target.rig, clip.actor, clip.pose, sample.animation.time, clip.still, {});
  } else {
    if (target.standing === null) throw new Error("Expected standing rig");
    const staff = clip.family === "staff" ? sampleStaff(clip.staff, sample.animation.time) : null;
    target.standing.apply(clip.family === "patrol-v2" ? samplePatrolBodyV2(clip.cycle, sample.animation.time) : clip.family === "walking" ? sampleWalkingV1(clip.cycle, sample.animation.time)
      : sampleStaffPose(clip.staff.activity, sample.animation.time + clip.staff.phase, staff?.walkedDistance ?? 0, staff?.speed ?? 0, clip.still));
  }
}
describe("actual applied bones and WORLD roots", () => {
  it("replays every staff family at waits, turns, walking, cycle boundaries, still and resumed frames", () => {
    for (const staff of PRECINCT_STAFF) for (const still of [false, true]) {
      const live = setup(); const replay = setup();
      const times = [0, 2, 8, 11, 22, 32, 45, PATROL_CYCLE_SECONDS - 0.01, PATROL_CYCLE_SECONDS, PATROL_CYCLE_SECONDS + 10, 0];
      for (const seconds of times) {
        const point = sampleStaff(staff, seconds); live.root.position.set(...point.position); live.root.rotation.y = point.yaw + Math.PI;
        live.standing?.apply(sampleStaffPose(staff.activity, seconds + staff.phase, point.walkedDistance, point.speed, still));
        const captured = readActorRoot(live.root, staffActorId(staff.id), staffClip(staff.id, still), seconds);
        replayInto(captured, replay); sameBody(live.model, replay.model);
        expect(readActorRoot(replay.root, captured.actor_id, captured.animation.clip, captured.animation.time)).toEqual(captured);
      }
      expect(advanceStaffClock(11, 1000, true, false)).toBe(11);
      expect(advanceStaffClock(11, 1000, false, true)).toBe(11);
      expect(advanceStaffClock(11, 1000, false, false)).toBe(11.05);
    }
  });
  it("replays every public seated persona, lifecycle and still variant, including backwards seeks", () => {
    for (const actor of SEATED_ACTORS_V1) for (const pose of ["idle", "listening", "speaking", "thinking", "typing"] as const) for (const still of [false, true]) {
      const live = setup(true); const replay = setup(true);
      live.root.position.set(...actor.position); live.root.rotation.y = actor.facing;
      for (const seconds of [0, 0.08, 2.123, 40.3, 2.123]) {
        if (live.rig === null) throw new Error("Missing live rig");
        applySeatedBodyV1(live.rig, actor, pose, seconds, still, { aa: 0.7 });
        const captured = readActorRoot(live.root, actor.actorId, seatedClip(actor, pose, still), seconds);
        replayInto(captured, replay); sameBody(live.model, replay.model);
        expect(replay.mesh.morphTargetInfluences?.slice(0, 2)).toEqual([0, 0]);
        expect(live.mesh.morphTargetInfluences?.[0]).toBe(still ? 0 : 0.7);
        expect(replay.mesh.morphTargetInfluences?.slice(2)).toEqual(live.mesh.morphTargetInfluences?.slice(2));
      }
    }
  });
  it("preserves walking actual collision-path phase for walk/run/stop, pause, reduced motion and held samples", () => {
    const live = setup(); const replay = setup();
    const parent = new Group(); parent.position.set(3, 0, -8); parent.rotation.y = 0.7; parent.add(live.root); live.root.rotation.y = Math.PI;
    const replayParent = new Group(); replayParent.position.set(-2, 0, 5); replayParent.rotation.y = -0.3; replayParent.add(replay.root);
    let position: Vec3 = [0, 0, 0]; let time: WalkingTimeV1 = { cycle: "idle", time: 0 };
    const samples: PoseData[] = [];
    for (const [movement, seconds, still] of [
      [[0.1, 0, 0], 0.05, false], [[0.2, 0, 0], 0.05, false], [[0.2, 0, -0.1], 0.05, false],
      [[0, 0, 0], 0.05, false], [[0.1, 0, 0], 40, true], [[0.1, 0, 0], 0.05, true], [[0, 0, -0.1], 0.05, false],
    ] as const) {
      const next = moveWithCollisions(position, movement, [{ id: "wall", min: [0.7, 0, -2], max: [0.8, 2, 2] }]);
      const distance = Math.hypot(next[0] - position[0], next[2] - position[2]); position = next;
      time = advanceWalkingV1(time, { distance, speed: distance / seconds }, seconds, still);
      live.root.position.set(...next); live.standing?.apply(sampleWalkingV1(time.cycle, time.time));
      const sample = readActorRoot(live.root, "investigator:walking", walkingClip(time.cycle), time.time); samples.push(sample);
      replayInto(sample, replay); sameBody(live.model, replay.model);
      for (let frame = 0; frame < 3; frame += 1) { replayInto(sample, replay); sameBody(live.model, replay.model); }
      expect(replay.root.getWorldPosition(new Vector3()).distanceTo(live.root.getWorldPosition(new Vector3()))).toBeLessThan(1e-8);
      expect(replay.root.getWorldQuaternion(new Quaternion()).angleTo(live.root.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6);
    }
    for (const sample of [...samples].reverse()) {
      replayInto(sample, replay); const repeat = setup(); replayInto(sample, repeat); sameBody(replay.model, repeat.model);
    }
  });
});
describe("opt-in sampling and absence lifecycle", () => {
  it("emits at 10 Hz, records clip changes immediately, and removes at the last actual root once", () => {
    const callback = vi.fn(); const root = new Group(); root.position.set(2, 3, 4);
    const sampler = createActorSampler({ scope: "case-a/capture-1", onActorSample: callback }, "investigator:walking");
    sampler.sample(root, walkingClip("walk"), 1, 0.01); expect(callback).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 8; index += 1) sampler.sample(root, walkingClip("walk"), 1 + index / 100, 0.01);
    expect(callback).toHaveBeenCalledTimes(1);
    sampler.sample(root, walkingClip("walk"), 1.1, 0.01); expect(callback).toHaveBeenCalledTimes(2);
    sampler.sample(root, walkingClip("still"), 0, 0.01); expect(callback).toHaveBeenCalledTimes(3);
    root.position.set(7, 8, 9); sampler.sample(root, walkingClip("still"), 0, 0.01); sampler.close(); sampler.close();
    expect(callback).toHaveBeenLastCalledWith({ actor_id: "investigator:walking", position: [7, 8, 9], rotation: [0, 0, 0, 1], animation: { clip: ABSENT_CLIP, time: 0 } });
    sampler.sample(root, walkingClip("idle"), 2, 1); expect(callback).toHaveBeenCalledTimes(4);
  });
  it("never fabricates absence before an actual pose or sends cleanup into a new callback", () => {
    const old = vi.fn(); const current = vi.fn();
    const empty = createActorSampler({ scope: "empty", onActorSample: old }, "staff:patrol"); empty.close(); expect(old).not.toHaveBeenCalled();
    const first = createActorSampler({ scope: "a", onActorSample: old }, "staff:patrol");
    first.sample(new Group(), staffClip("patrol", false), 2, 0.1);
    const second = createActorSampler({ scope: "b", onActorSample: current }, "staff:patrol"); first.close();
    expect(current).not.toHaveBeenCalled(); second.close(); expect(current).not.toHaveBeenCalled();
    expect(old).toHaveBeenCalledTimes(2);
  });
});
