/** Instance-owned Rocketbox rig/materials. No clips or downloaded animation are used. */
import {
  Bone, DoubleSide, Material, Mesh, MeshStandardMaterial, Object3D, Quaternion, SkinnedMesh,
  SRGBColorSpace, Vector3, type Skeleton, type Texture,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import { SEATED_PELVIS, seatedLeg } from "../../lib/precinct/proceduralSeatedV1";
import type { Vec3 } from "../../lib/precinct/types";
import type { Weights } from "../../lib/world/audioLips";
import { VISEMES } from "../../lib/world/visemes";

const EXTRAS: Readonly<Record<string, readonly ("opacity" | "glasses")[]>> = {
  Male_Adult_12: [], Business_Male_04: [], Business_Male_06: [], Business_Female_02: ["opacity", "glasses"],
};
export function seatedTextureUrls(avatar: string): string[] {
  const base = `/avatars/${avatar}/`;
  return [`${base}body.jpg`, `${base}body_n.jpg`, `${base}head.jpg`, `${base}head_n.jpg`,
    ...(EXTRAS[avatar] ?? ["opacity"]).map((name) => `${base}${name}.png`)];
}

export interface SeatedResources { readonly scene: Object3D; readonly dispose: () => void }
/** Clone even unknown materials; never mutate/dispose loader-owned textures, geometry, or materials. */
export function seatedResources(source: Object3D, inputs: readonly Texture[], avatar: string): SeatedResources {
  const scene = cloneSkinned(source);
  const textures = inputs.map((input, index) => {
    const texture = input.clone();
    if (index !== 1 && index !== 3) texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  });
  const [body, bodyN, head, headN, ...extras] = textures;
  const names = EXTRAS[avatar] ?? ["opacity"];
  const opacity = extras[names.indexOf("opacity")];
  const glasses = extras[names.indexOf("glasses")];
  const materials = new Map<Material, Material>();
  const materialFor = (original: Material): Material => {
    const existing = materials.get(original);
    if (existing !== undefined) return existing;
    const name = original.name;
    let material: Material;
    if (name.endsWith("_body")) material = new MeshStandardMaterial({ name, map: body ?? null, normalMap: bodyN ?? null, roughness: 0.78 });
    else if (name.endsWith("_head")) material = new MeshStandardMaterial({ name, map: head ?? null, normalMap: headN ?? null, roughness: 0.58 });
    else if (name.endsWith("_opacity") && opacity !== undefined) material = new MeshStandardMaterial({ name, map: opacity, alphaTest: 0.4, side: DoubleSide, roughness: 0.7 });
    else if (name.endsWith("_glasses") && glasses !== undefined) material = new MeshStandardMaterial({ name, map: glasses, transparent: true, roughness: 0.15, metalness: 0.4 });
    else material = original.clone();
    materials.set(original, material);
    return material;
  };
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const mesh = object as Mesh;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(materialFor) : materialFor(mesh.material);
    // A skinned mesh's loader bounds describe the standing bind pose. Do not cull a seated head incorrectly.
    object.frustumCulled = false;
  });
  return { scene, dispose: () => {
    const skeletons = new Set<Skeleton>();
    scene.traverse((object) => { if (object instanceof SkinnedMesh) skeletons.add(object.skeleton); });
    for (const skeleton of skeletons) skeleton.dispose();
    for (const material of materials.values()) material.dispose();
    for (const texture of textures) texture.dispose();
  } };
}

function pointBoneAt(bone: Bone, child: Bone, target: Vector3): void {
  if (bone.parent === null) return;
  bone.updateWorldMatrix(true, true);
  const origin = bone.getWorldPosition(new Vector3());
  const from = child.getWorldPosition(new Vector3()).sub(origin).normalize();
  const to = target.clone().sub(origin).normalize();
  const delta = new Quaternion().setFromUnitVectors(from, to);
  const parent = bone.parent.getWorldQuaternion(new Quaternion());
  bone.quaternion.premultiply(parent).premultiply(delta).premultiply(parent.clone().invert());
  bone.updateWorldMatrix(false, true);
}

const MORPHS = ["AA_VI_00_Sil", "AA_VI_01_PP", "AA_VI_02_FF", "AA_VI_03_TH", "AA_VI_04_DD", "AA_VI_05_KK", "AA_VI_06_CH", "AA_VI_07_SS", "AA_VI_08_nn", "AA_VI_09_RR", "AA_VI_10_aa", "AA_VI_11_E", "AA_VI_12_I", "AA_VI_13_O", "AA_VI_14_U"] as const;
const DRIVEN = ["Bip01_Spine2", "Bip01_Head", "Bip01_L_Forearm", "Bip01_R_Forearm"] as const;
type Driven = typeof DRIVEN[number];

export interface SeatedRig {
  readonly reset: () => void;
  readonly rotate: (name: Driven, axis: "pitch" | "yaw" | "roll", angle: number) => void;
  readonly look: (gaze: Vec3) => void;
  readonly face: (weights: Weights, blink: number) => void;
}
/** One-time fit in metres before attaching the model to its world-space seat group. */
export function prepareSeatedRig(scene: Object3D): SeatedRig {
  const bones = new Map<string, Bone>();
  const faces: SkinnedMesh[] = [];
  scene.traverse((object) => {
    if (object instanceof Bone) bones.set(object.name, object as Bone);
    if (object instanceof SkinnedMesh && object.morphTargetDictionary !== undefined) faces.push(object as SkinnedMesh);
  });
  scene.updateMatrixWorld(true);
  const pelvis = bones.get("Bip01_Pelvis");
  const legs = ["L", "R"].flatMap((side) => {
    const thigh = bones.get(`Bip01_${side}_Thigh`);
    const calf = bones.get(`Bip01_${side}_Calf`);
    const foot = bones.get(`Bip01_${side}_Foot`);
    if (thigh === undefined || calf === undefined || foot === undefined) return [];
    const hip = thigh.getWorldPosition(new Vector3());
    const knee = calf.getWorldPosition(new Vector3());
    const ankle = foot.getWorldPosition(new Vector3());
    return [{ thigh, calf, foot, upper: hip.distanceTo(knee), lower: knee.distanceTo(ankle), ankleY: ankle.y, footRotation: foot.getWorldQuaternion(new Quaternion()) }];
  });
  if (pelvis !== undefined) scene.position.y += SEATED_PELVIS - pelvis.getWorldPosition(new Vector3()).y;
  scene.updateMatrixWorld(true);
  for (const leg of legs) {
    const hip = leg.thigh.getWorldPosition(new Vector3());
    const pose = seatedLeg(leg.upper, leg.lower, hip.y, leg.ankleY);
    pointBoneAt(leg.thigh, leg.calf, hip.clone().add(new Vector3(0, ...pose.knee)));
    pointBoneAt(leg.calf, leg.foot, hip.clone().add(new Vector3(0, ...pose.ankle)));
    if (leg.foot.parent !== null) leg.foot.quaternion.copy(leg.foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(leg.footRotation));
  }
  // Rest hands on the lap. Solve each arm from actual bone lengths; no A-pose or chair penetration.
  for (const side of ["L", "R"]) {
    const upper = bones.get(`Bip01_${side}_UpperArm`);
    const fore = bones.get(`Bip01_${side}_Forearm`);
    const hand = bones.get(`Bip01_${side}_Hand`);
    if (upper === undefined || fore === undefined || hand === undefined) continue;
    const shoulder = upper.getWorldPosition(new Vector3());
    pointBoneAt(upper, fore, new Vector3(shoulder.x * 1.03, shoulder.y - 0.25, shoulder.z + 0.06));
    const elbow = fore.getWorldPosition(new Vector3());
    pointBoneAt(fore, hand, new Vector3(elbow.x * 0.75, elbow.y - 0.13, elbow.z + 0.24));
  }
  scene.updateMatrixWorld(true);
  const rest = new Map<Bone, Quaternion>();
  for (const name of DRIVEN) { const bone = bones.get(name); if (bone !== undefined) rest.set(bone, bone.quaternion.clone()); }
  // Scratch objects are per instance and reused; no per-frame vector allocation.
  const parent = new Quaternion(); const inverse = new Quaternion(); const delta = new Quaternion(); const model = new Quaternion();
  const axis = new Vector3(); const at = new Vector3(); const target = new Vector3();
  const rotate: SeatedRig["rotate"] = (name, direction, angle) => {
    const bone = bones.get(name);
    if (bone === undefined || bone.parent === null || angle === 0) return;
    scene.getWorldQuaternion(model);
    axis.set(direction === "pitch" ? 1 : 0, direction === "yaw" ? 1 : 0, direction === "roll" ? 1 : 0).applyQuaternion(model);
    bone.parent.getWorldQuaternion(parent); inverse.copy(parent).invert(); delta.setFromAxisAngle(axis, angle);
    bone.quaternion.premultiply(parent).premultiply(delta).premultiply(inverse);
  };
  const morph = (face: SkinnedMesh, name: string, value: number) => {
    const index = face.morphTargetDictionary?.[name];
    if (index !== undefined && face.morphTargetInfluences !== undefined) face.morphTargetInfluences[index] = value;
  };
  return {
    reset: () => { for (const [bone, quaternion] of rest) bone.quaternion.copy(quaternion); },
    rotate,
    look: (gaze) => {
      const head = bones.get("Bip01_Head");
      if (head === undefined) return;
      head.getWorldPosition(at); target.set(...gaze).sub(at);
      scene.getWorldQuaternion(model); target.applyQuaternion(model.invert());
      const yaw = Math.max(-0.35, Math.min(0.35, Math.atan2(target.x, target.z)));
      const pitch = Math.max(-0.18, Math.min(0.18, Math.atan2(target.y, Math.hypot(target.x, target.z))));
      rotate("Bip01_Head", "yaw", yaw); rotate("Bip01_Head", "pitch", -pitch);
    },
    face: (weights, blink) => {
      for (const face of faces) {
        VISEMES.forEach((key, index) => { const name = MORPHS[index]; if (name !== undefined) morph(face, name, key === "sil" ? 0 : weights[key] ?? 0); });
        morph(face, "AK_25_JawOpen", Math.min(1, (weights.aa ?? 0) + (weights.O ?? 0)) * 0.25);
        morph(face, "AK_09_EyeBlinkLeft", blink); morph(face, "AK_10_EyeBlinkRight", blink);
      }
    },
  };
}
