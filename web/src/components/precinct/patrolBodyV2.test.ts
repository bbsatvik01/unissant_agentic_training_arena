import { Bone, Group, Quaternion, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { moveWithCollisions } from "../../lib/precinct/movement";
import { ABSENT_CLIP, proceduralClip } from "../../lib/precinct/proceduralActors";
import { patrolClipV2, type PatrolTimeV2 } from "../../lib/precinct/proceduralPatrolV2";
import type { Vec3 } from "../../lib/precinct/types";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyLivePatrolBodyV2, applyRecordedPatrolBodyV2 } from "./patrolBodyV2";
import { createActorSampler } from "./actorSamples";
import { syntheticRig } from "./proceduralRigFixture.testSupport";
import { prepareStandingRigV1 } from "./standingAvatarRigV1";
function fixture() {
  const model = syntheticRig(); const rig = prepareStandingRigV1(model.root); const root = new Group(); root.add(model.root);
  return { ...model, model: model.root, root, rig };
}
function sameBody(live: ReturnType<typeof fixture>, replay: ReturnType<typeof fixture>) {
  live.root.updateWorldMatrix(true, true); replay.root.updateWorldMatrix(true, true);
  live.model.traverse((bone) => {
    if (!(bone instanceof Bone)) return;
    const other = replay.model.getObjectByName(bone.name); if (!(other instanceof Bone)) throw new Error(`Missing driven bone ${bone.name}`);
    expect(bone.quaternion.angleTo(other.quaternion), bone.name).toBeLessThan(1e-6);
    expect(bone.getWorldPosition(new Vector3()).distanceTo(other.getWorldPosition(new Vector3())), bone.name).toBeLessThan(1e-8);
  });
  expect(live.root.getWorldPosition(new Vector3()).distanceTo(replay.root.getWorldPosition(new Vector3()))).toBeLessThan(1e-8);
  expect(live.root.getWorldQuaternion(new Quaternion()).angleTo(replay.root.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6);
  expect(replay.mesh.morphTargetInfluences).toEqual(live.mesh.morphTargetInfluences);
}
describe("actual crowd-driven body capture and replay", () => {
  it("reconstructs driven bone quaternions and WORLD roots across collision, block, pause, reduced motion and backwards seeks", () => {
    const live = fixture(); const replay = fixture();
    const liveParent = new Group(); liveParent.position.set(2, 0, -8); liveParent.rotation.y = 0.6; liveParent.add(live.root);
    const replayParent = new Group(); replayParent.position.set(-1, 0, 3); replayParent.rotation.y = -0.8; replayParent.add(replay.root);
    const samples: PoseData[] = []; const onActorSample = vi.fn((sample: PoseData) => samples.push(sample));
    const sampler = createActorSampler({ scope: "scope-a", onActorSample }, "staff:patrol");
    let position: Vec3 = [0, 0.03, 0]; let walkedDistance = 0; let time: PatrolTimeV2 | null = null;
    const frames = [
      { move: [0, 0, 0], delta: 0.1, still: false },
      ...Array.from({ length: 7 }, () => ({ move: [0.15, 0, 0], delta: 0.1, still: false })),
      { move: [0, 0, -0.1], delta: 0.1, still: false },
      { move: [0, 0, 0], delta: 0.1, still: false },
      { move: [0, 0, 0], delta: 40, still: true },
      { move: [0, 0, 0], delta: 0.1, still: true },
      { move: [0, 0, -0.1], delta: 0.1, still: false },
    ];
    const cycles = new Set<string>();
    for (const frame of frames) {
      const next = moveWithCollisions(position, [frame.move[0] ?? 0, 0, frame.move[2] ?? 0], [{ id: "wall", min: [0.7, 0, -2], max: [0.8, 2, 2] }]);
      const distance = Math.hypot(next[0] - position[0], next[2] - position[2]); walkedDistance += distance; position = next;
      time = applyLivePatrolBodyV2(live.root, live.rig, time, { position, yaw: 0.3, speed: distance / frame.delta, walkedDistance }, frame.delta, frame.still);
      sampler.sample(live.root, patrolClipV2(time.cycle), time.time, frame.delta); cycles.add(time.cycle);
      const captured = samples.at(-1); if (captured === undefined) throw new Error("Missing actual sample");
      const clip = proceduralClip(captured); if (clip?.family !== "patrol-v2") throw new Error("Expected finite patrol-v2 clip");
      for (let repeat = 0; repeat < 3; repeat += 1) {
        applyRecordedPatrolBodyV2(replay.root, replay.rig, captured, clip.cycle); sameBody(live, replay);
      }
    }
    expect(cycles).toEqual(new Set(["walk", "idle", "still"]));
    const beforeReplay = onActorSample.mock.calls.length;
    for (const captured of [...samples].reverse()) {
      const clip = proceduralClip(captured); if (clip?.family !== "patrol-v2") throw new Error("Expected finite patrol-v2 clip");
      const independentlyReplayed = fixture();
      applyRecordedPatrolBodyV2(replay.root, replay.rig, captured, clip.cycle);
      applyRecordedPatrolBodyV2(independentlyReplayed.root, independentlyReplayed.rig, captured, clip.cycle); sameBody(replay, independentlyReplayed);
    }
    expect(onActorSample).toHaveBeenCalledTimes(beforeReplay);
    const last = samples.at(-1); sampler.close(); sampler.close();
    expect(onActorSample).toHaveBeenCalledTimes(beforeReplay + 1);
    expect(samples.at(-1)).toEqual({ ...last, animation: { clip: ABSENT_CLIP, time: last?.animation.time } });
  });
});
