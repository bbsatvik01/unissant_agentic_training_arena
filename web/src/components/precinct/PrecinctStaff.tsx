/**
 * Ambient precinct colleagues. The public component accepts presentation controls only.
 * Rocketbox meshes/textures are the existing MIT-licensed assets under /avatars/.
 * Idle, walking, counter-work and seated desk gestures below are original procedural motion.
 */
import { useFrame, useLoader } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Bone, DoubleSide, Material, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  SkinnedMesh, SRGBColorSpace, TextureLoader, Vector3, type Group, type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import {
  advanceStaffClock, sampleStaff, sampleStaffPose, staffForTier,
  type StaffAvatar, type StaffDefinition, type StaffPose,
} from "../../lib/precinct/staff";
import type { Tier } from "../../lib/world/quality";

export interface PrecinctStaffProps {
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly tier: Tier;
}

const EXTRAS: Readonly<Record<StaffAvatar, readonly ("opacity" | "glasses")[]>> = {
  Business_Female_01: ["opacity"],
  Business_Male_04: [],
  Business_Male_06: [],
  Business_Female_02: ["opacity", "glasses"],
};

function textureUrls(avatar: StaffAvatar): string[] {
  const base = `/avatars/${avatar}/`;
  return [`${base}body.jpg`, `${base}body_n.jpg`, `${base}head.jpg`, `${base}head_n.jpg`,
    ...EXTRAS[avatar].map((name) => `${base}${name}.png`)];
}

/** Each figure owns its rig and materials; loader geometry and textures remain shared. */
function prepareScene(source: Object3D, textures: readonly Texture[], avatar: StaffAvatar): Object3D {
  const scene = cloneSkinned(source);
  const [body, bodyN, head, headN, ...extras] = textures;
  for (const texture of [body, head, ...extras]) {
    if (texture !== undefined) texture.colorSpace = SRGBColorSpace;
  }
  const opacity = extras[EXTRAS[avatar].indexOf("opacity")];
  const glasses = extras[EXTRAS[avatar].indexOf("glasses")];
  const material = (original: Material): Material => {
    const name = original.name;
    if (name.endsWith("_body")) return new MeshStandardMaterial({ name, map: body ?? null, normalMap: bodyN ?? null, roughness: 0.78, metalness: 0 });
    if (name.endsWith("_head")) return new MeshStandardMaterial({ name, map: head ?? null, normalMap: headN ?? null, roughness: 0.58, metalness: 0 });
    if (name.endsWith("_opacity") && opacity !== undefined) return new MeshStandardMaterial({ name, map: opacity, alphaTest: 0.4, side: DoubleSide, roughness: 0.7 });
    if (name.endsWith("_glasses") && glasses !== undefined) return new MeshStandardMaterial({ name, map: glasses, transparent: true, roughness: 0.15, metalness: 0.4 });
    return original.clone();
  };
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const mesh = object as Mesh;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material) : material(mesh.material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.morphTargetInfluences?.fill(0);
  });
  return scene;
}

const DRIVEN = [
  "Bip01_L_Thigh", "Bip01_R_Thigh", "Bip01_L_Calf", "Bip01_R_Calf",
  "Bip01_L_Foot", "Bip01_R_Foot", "Bip01_L_UpperArm", "Bip01_R_UpperArm",
  "Bip01_L_Forearm", "Bip01_R_Forearm", "Bip01_Spine2", "Bip01_Head",
] as const;
type DrivenBone = typeof DRIVEN[number];

function prepareRig(scene: Object3D) {
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

/** An optional ambient asset failure must never take the walkable precinct down with it. */
class StaffBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { console.warn("An optional ambient staff avatar could not load.", error); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function StaffFigure({ staff, paused, reducedMotion, tier }: PrecinctStaffProps & { readonly staff: StaffDefinition }) {
  const gltf = useLoader(GLTFLoader, `/avatars/${staff.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, textureUrls(staff.avatar));
  const scene = useMemo(() => prepareScene(gltf.scene, textures, staff.avatar), [gltf, textures, staff.avatar]);
  const rig = useMemo(() => prepareRig(scene), [scene]);
  const group = useRef<Group>(null);
  const elapsed = useRef(0);
  const initial = sampleStaff(staff, 0);

  useEffect(() => {
    scene.traverse((object) => { if (object instanceof Mesh) object.castShadow = tier !== "low"; });
  }, [scene, tier]);

  useEffect(() => () => {
    const disposed = new Set<Material>();
    scene.traverse((object) => {
      if (object instanceof SkinnedMesh) object.skeleton.dispose();
      if (!(object instanceof Mesh)) return;
      const mesh = object as Mesh;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (disposed.has(material)) continue;
        material.dispose();
        disposed.add(material);
      }
    });
  }, [scene]);

  useFrame((_, delta) => {
    const root = group.current;
    if (root === null) return;
    elapsed.current = advanceStaffClock(elapsed.current, delta, paused, reducedMotion);
    const sample = sampleStaff(staff, elapsed.current);
    root.position.set(...sample.position);
    // Rocketbox's standing bind pose faces +Z, opposite the camera's yaw-zero direction.
    root.rotation.y = sample.yaw + Math.PI;
    rig.apply(sampleStaffPose(staff.activity, elapsed.current + staff.phase, sample.walkedDistance, sample.speed, paused || reducedMotion));
  });

  return <group ref={group} name={`precinct-staff-${staff.id}`} position={initial.position} rotation={[0, initial.yaw + Math.PI, 0]}>
    <primitive object={scene} dispose={null} />
  </group>;
}

/** Mount inside the existing precinct Canvas. No provider, event handler, or case context is required. */
export function PrecinctStaff({ paused, reducedMotion, tier }: PrecinctStaffProps) {
  return <group name="precinct-ambient-staff">
    {staffForTier(tier).map((staff) => <StaffBoundary key={staff.id}>
      <Suspense fallback={null}>
        <StaffFigure staff={staff} paused={paused} reducedMotion={reducedMotion} tier={tier} />
      </Suspense>
    </StaffBoundary>)}
  </group>;
}
