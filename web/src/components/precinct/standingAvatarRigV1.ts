/** Frozen original model-axis procedural body application v1. */
import { Bone, Mesh, Object3D, Quaternion, Vector3 } from "three";
import type { StaffPose } from "../../lib/precinct/proceduralStaffV1";
const DRIVEN = [
  "Bip01_L_Thigh", "Bip01_R_Thigh", "Bip01_L_Calf", "Bip01_R_Calf",
  "Bip01_L_Foot", "Bip01_R_Foot", "Bip01_L_UpperArm", "Bip01_R_UpperArm",
  "Bip01_L_Forearm", "Bip01_R_Forearm", "Bip01_Spine2", "Bip01_Head",
] as const;
type DrivenBone = typeof DRIVEN[number];

export function prepareStandingRigV1(scene: Object3D) {
  const bones = new Map<string, Bone>();
  const rest = new Map<Bone, Quaternion>();
  const faces: Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof Bone && DRIVEN.some((name) => name === object.name)) {
      const bone = object as Bone;
      bones.set(bone.name, bone);
      rest.set(bone, bone.quaternion.clone());
    }
    if (object instanceof Mesh && object.morphTargetInfluences !== undefined) faces.push(object as Mesh);
  });
  const parent = new Quaternion();
  const inverse = new Quaternion();
  const rotation = new Quaternion();
  const model = new Quaternion();
  const axis = new Vector3();
  const sample = new Vector3();
  scene.updateMatrixWorld(true);
  const feet = ["Bip01_L_Foot", "Bip01_R_Foot"].flatMap((name) => {
    const bone = bones.get(name);
    return bone === undefined ? [] : [{ bone, height: scene.worldToLocal(bone.getWorldPosition(sample)).y }];
  });
  const rotate = (name: DrivenBone, direction: "pitch" | "roll" | "yaw", angle: number) => {
    const bone = bones.get(name);
    if (bone === undefined || bone.parent === null) return;
    scene.getWorldQuaternion(model);
    axis.set(direction === "pitch" ? 1 : 0, direction === "yaw" ? 1 : 0, direction === "roll" ? 1 : 0).applyQuaternion(model);
    bone.parent.getWorldQuaternion(parent);
    inverse.copy(parent).invert();
    rotation.setFromAxisAngle(axis, angle);
    bone.quaternion.premultiply(parent).premultiply(rotation).premultiply(inverse);
  };
  const apply = (pose: StaffPose) => {
    for (const [bone, quaternion] of rest) bone.quaternion.copy(quaternion);
    scene.position.y = 0;
    scene.updateMatrixWorld(true);
    rotate("Bip01_L_Thigh", "pitch", pose.leftHip);
    rotate("Bip01_R_Thigh", "pitch", pose.rightHip);
    rotate("Bip01_L_Calf", "pitch", pose.leftKnee);
    rotate("Bip01_R_Calf", "pitch", pose.rightKnee);
    rotate("Bip01_L_Foot", "pitch", pose.leftFoot);
    rotate("Bip01_R_Foot", "pitch", pose.rightFoot);
    // Lower the source A-pose before adding the small original hand/arm movements.
    rotate("Bip01_L_UpperArm", "roll", -0.64);
    rotate("Bip01_R_UpperArm", "roll", 0.64);
    rotate("Bip01_L_UpperArm", "pitch", pose.leftArm);
    rotate("Bip01_R_UpperArm", "pitch", pose.rightArm);
    rotate("Bip01_L_Forearm", "pitch", pose.leftElbow);
    rotate("Bip01_R_Forearm", "pitch", pose.rightElbow);
    rotate("Bip01_Spine2", "pitch", pose.spine);
    rotate("Bip01_Head", "pitch", pose.headPitch);
    rotate("Bip01_Head", "yaw", pose.headYaw);
    scene.updateMatrixWorld(true);
    let lift = Infinity;
    for (const foot of feet) lift = Math.min(lift, scene.worldToLocal(foot.bone.getWorldPosition(sample)).y - foot.height);
    // Seated knees naturally lower the pelvis to the existing chair while keeping both soles grounded.
    if (Number.isFinite(lift)) scene.position.y = -lift;
    for (const face of faces) {
      const dictionary = face.morphTargetDictionary;
      const values = face.morphTargetInfluences;
      if (dictionary === undefined || values === undefined) continue;
      for (const name of ["AK_09_EyeBlinkLeft", "AK_10_EyeBlinkRight"]) {
        const index = dictionary[name];
        if (index !== undefined) values[index] = pose.blink;
      }
    }
  };
  return { apply };
}

