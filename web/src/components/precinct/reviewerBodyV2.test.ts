import { Bone, Group, Quaternion, Vector3, type Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { ABSENT_CLIP, proceduralClip } from "../../lib/precinct/proceduralActors";
import { REVIEWER_POSES_V2, REVIEWER_V2, reviewerClipV2, reviewerPlaybackV2 } from "../../lib/precinct/proceduralReviewerV2";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot, createActorSampler, readActorRoot } from "./actorSamples";
import { syntheticRig } from "./proceduralRigFixture.testSupport";
import { applyReviewerBodyV2, prepareReviewerRigV2 } from "./reviewerBodyV2";

function setup() {
  const fixture = syntheticRig(); const rig = prepareReviewerRigV2(fixture.root);
  const root = new Group(); root.add(fixture.root);
  return { ...fixture, model: fixture.root, root, rig };
}
function sameBody(a: Object3D, b: Object3D) {
  a.updateWorldMatrix(true, true); b.updateWorldMatrix(true, true);
  a.traverse((bone) => {
    if (!(bone instanceof Bone)) return;
    const other = b.getObjectByName(bone.name);
    if (!(other instanceof Bone)) throw new Error(`Missing ${bone.name}`);
    expect(bone.quaternion.angleTo(other.quaternion), bone.name).toBeLessThan(1e-6);
    expect(bone.getWorldPosition(new Vector3()).distanceTo(other.getWorldPosition(new Vector3())), bone.name).toBeLessThan(1e-8);
  });
}
function replay(sample: PoseData, target: ReturnType<typeof setup>) {
  const clip = proceduralClip(sample);
  if (clip?.family !== "reviewer-v2") throw new Error("Expected a finite reviewer clip");
  applyActorRoot(target.root, sample);
  applyReviewerBodyV2(target.rig, clip.pose, sample.animation.time, clip.still);
}
describe("reviewer shared applied bone/root replay", () => {
  it("matches every actual posed bone and root at all versioned poses, including backwards seeks and held samples", () => {
    for (const pose of REVIEWER_POSES_V2) for (const still of [false, true]) {
      const live = setup(); const replayed = setup();
      live.root.position.set(...REVIEWER_V2.position); live.root.rotation.y = REVIEWER_V2.facing;
      const parent = new Group(); parent.position.set(-2, 0, 3); parent.rotation.y = 0.4; parent.add(replayed.root);
      for (const seconds of [0, 0.08, 0.7, 1.39, 0.08]) {
        // Poison previous mouth state; v2 must explicitly close every mouth on every frame.
        live.mesh.morphTargetInfluences = [0.8, 0.2, 0, 0];
        applyReviewerBodyV2(live.rig, pose, seconds, still);
        const captured = readActorRoot(live.root, REVIEWER_V2.actorId, reviewerClipV2(pose, still), seconds);
        replay(captured, replayed); sameBody(live.model, replayed.model);
        expect(replayed.root.getWorldPosition(new Vector3()).distanceTo(live.root.getWorldPosition(new Vector3()))).toBeLessThan(1e-8);
        expect(replayed.root.getWorldQuaternion(new Quaternion()).angleTo(live.root.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6);
        expect(live.mesh.morphTargetInfluences.slice(0, 2)).toEqual([0, 0]);
        expect(replayed.mesh.morphTargetInfluences).toEqual(live.mesh.morphTargetInfluences);
        for (let i = 0; i < 3; i += 1) { replay(captured, replayed); sameBody(live.model, replayed.model); }
      }
    }
  });
  it("records actual lifecycle clip transitions through the existing sampler and emits absence once on withholding", () => {
    const live = setup(); live.root.position.set(...REVIEWER_V2.position);
    const observed = vi.fn(); const sampler = createActorSampler({ scope: "public-practice-a", onActorSample: observed }, REVIEWER_V2.actorId);
    for (const [lifecycle, nowMs] of [
      [{ phase: "listening", publishedAtMs: null }, 1_000],
      [{ phase: "working", publishedAtMs: null }, 1_100],
      [{ phase: "published", publishedAtMs: 2_000 }, 2_700],
      [{ phase: "published", publishedAtMs: 2_000 }, 3_400],
    ] as const) {
      const current = reviewerPlaybackV2(lifecycle, nowMs, false);
      applyReviewerBodyV2(live.rig, current.pose, current.time, false);
      sampler.sample(live.root, current.clip, current.time, 0.01);
      const actual = observed.mock.lastCall?.[0] as PoseData;
      expect(actual).toEqual(readActorRoot(live.root, REVIEWER_V2.actorId, current.clip, current.time));
      const replayed = setup(); replay(actual, replayed); sameBody(live.model, replayed.model);
    }
    expect(observed).toHaveBeenCalledTimes(4);
    sampler.close(); sampler.close();
    expect(observed).toHaveBeenCalledTimes(5);
    expect(observed.mock.lastCall?.[0]).toMatchObject({ actor_id: REVIEWER_V2.actorId, animation: { clip: ABSENT_CLIP } });
    sampler.sample(live.root, reviewerClipV2("working", false), 5, 1);
    expect(observed).toHaveBeenCalledTimes(5);
  });
});
