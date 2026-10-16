/** New v2 arm/body application. The frozen v1 seated rig and evaluator are unchanged. */
import { Bone, Quaternion, Vector3, type Object3D } from "three";
import { REVIEWER_V2, reviewerMotionV2, type ReviewerPoseV2 } from "../../lib/precinct/proceduralReviewerV2";
import { prepareSeatedRig } from "./seatedAvatarRig";

export function prepareReviewerRigV2(scene: Object3D) {
  const base = prepareSeatedRig(scene);
  const upperArms = new Map<string, { readonly bone: Bone; readonly rest: Quaternion }>();
  for (const side of ["L", "R"]) {
    const bone = scene.getObjectByName(`Bip01_${side}_UpperArm`);
    if (bone instanceof Bone) upperArms.set(side, { bone: bone as Bone, rest: bone.quaternion.clone() });
  }
  const model = new Quaternion(); const parent = new Quaternion(); const inverse = new Quaternion(); const delta = new Quaternion(); const axis = new Vector3();
  return {
    base,
    reset: () => { base.reset(); for (const { bone, rest } of upperArms.values()) bone.quaternion.copy(rest); },
    arm: (side: "L" | "R", pitch: number) => {
      const entry = upperArms.get(side);
      if (entry === undefined || entry.bone.parent === null || pitch === 0) return;
      scene.getWorldQuaternion(model); axis.set(1, 0, 0).applyQuaternion(model);
      entry.bone.parent.getWorldQuaternion(parent); inverse.copy(parent).invert(); delta.setFromAxisAngle(axis, pitch);
      entry.bone.quaternion.premultiply(parent).premultiply(delta).premultiply(inverse);
    },
    /** The blank publication slip follows the actual rendered right hand, never a fake root. */
    hand: scene.getObjectByName("Bip01_R_Hand") ?? null,
  };
}
export type ReviewerRigV2 = ReturnType<typeof prepareReviewerRigV2>;
export function applyReviewerBodyV2(rig: ReviewerRigV2, pose: ReviewerPoseV2, seconds: number, still: boolean): void {
  const motion = reviewerMotionV2(pose, seconds, still);
  rig.reset();
  rig.base.rotate("Bip01_Spine2", "pitch", 0.035 + motion.breath);
  rig.base.look(pose === "listening" ? [REVIEWER_V2.position[0], 1.28, -15.5] : [REVIEWER_V2.position[0], 0.83, -16.7]);
  rig.arm("L", motion.leftArm); rig.arm("R", motion.rightArm);
  rig.base.rotate("Bip01_L_Forearm", "pitch", motion.leftForearm);
  rig.base.rotate("Bip01_R_Forearm", "pitch", motion.rightForearm);
  // This colleague has no audio source or voice binding. Mouth always stays closed.
  rig.base.face({}, motion.blink);
}
