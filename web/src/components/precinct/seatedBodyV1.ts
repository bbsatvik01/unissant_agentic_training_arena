import { seatedGazeV1, type BodyPose, type SeatedActorV1 } from "../../lib/precinct/proceduralActors";
import { seatedMotion } from "../../lib/precinct/proceduralSeatedV1";
import type { Weights } from "../../lib/world/audioLips";
import type { SeatedRig } from "./seatedAvatarRig";

/** Frozen v1 body application shared by both render paths. Mouth weights are a separate live-only input. */
export function applySeatedBodyV1(rig: SeatedRig, actor: SeatedActorV1, pose: BodyPose, seconds: number, still: boolean, mouth: Weights): void {
  const motion = seatedMotion(seconds * 1000, actor.seed, pose, still, actor.gesture);
  rig.reset();
  rig.rotate("Bip01_Spine2", "pitch", Math.max(-0.12, Math.min(0.12, actor.lean)) + motion.breath);
  rig.rotate("Bip01_Head", "roll", Math.max(-0.08, Math.min(0.08, actor.headTilt)));
  rig.look(seatedGazeV1(actor, pose));
  rig.rotate("Bip01_Head", "pitch", motion.head);
  rig.rotate("Bip01_L_Forearm", "pitch", motion.hands);
  rig.rotate("Bip01_R_Forearm", "pitch", -motion.hands);
  rig.face(still ? {} : mouth, motion.blink);
}
