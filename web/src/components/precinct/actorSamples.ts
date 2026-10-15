import { Quaternion, Vector3, type Object3D } from "three";
import { advanceCadence } from "../../lib/precinct/cadence";
import { ABSENT_CLIP, type ActorCapture } from "../../lib/precinct/proceduralActors";
import type { PoseData } from "../../lib/world/worldEvents";

/** WORLD root, including the walking parent's yaw and the model's +π conversion. */
export function readActorRoot(root: Object3D, actorId: string, clip: string, time: number): PoseData {
  root.updateWorldMatrix(true, true);
  return { actor_id: actorId, position: root.getWorldPosition(new Vector3()).toArray(),
    rotation: root.getWorldQuaternion(new Quaternion()).normalize().toArray(), animation: { clip, time } };
}
/** Apply world coordinates even when a renderer has a transformed parent. No actor-owned camera. */
export function applyActorRoot(root: Object3D, sample: PoseData): void {
  const position = new Vector3(...sample.position);
  const rotation = new Quaternion(...sample.rotation);
  if (root.parent !== null) {
    root.parent.updateWorldMatrix(true, false);
    root.parent.worldToLocal(position);
    rotation.premultiply(root.parent.getWorldQuaternion(new Quaternion()).invert());
  }
  root.position.copy(position); root.quaternion.copy(rotation); root.updateWorldMatrix(false, true);
}
/** One lifecycle's last actual root. Cleanup cannot adopt a callback from a different scope. */
export function createActorSampler(capture: ActorCapture, actorId: string) {
  let last: PoseData | null = null;
  let elapsed = 0;
  let closed = false;
  let emittedClip: string | null = null;
  return {
    sample(root: Object3D, clip: string, time: number, delta: number) {
      if (closed) return;
      last = readActorRoot(root, actorId, clip, time);
      const cadence = advanceCadence(elapsed, delta); elapsed = cadence.elapsed;
      if (cadence.due || emittedClip !== clip) {
        emittedClip = clip; capture.onActorSample(last);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (last !== null) capture.onActorSample({ ...last, animation: { clip: ABSENT_CLIP, time: last.animation.time } });
    },
  };
}
