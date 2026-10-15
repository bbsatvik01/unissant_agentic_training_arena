/**
 * The trainee's standing Rocketbox body. The original gait is driven only by travelled speed;
 * there are no interview clips, case inputs, or behavioral signals in this controller.
 * Rocketbox assets and their MIT attribution are shared with world/Avatar.tsx.
 */
import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Bone, DoubleSide, Material, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  SkinnedMesh, SRGBColorSpace, TextureLoader, Vector3, type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import type { Vec3 } from "../../lib/precinct/types";
import type { Persona } from "../../lib/world/cast";

interface WalkingAvatarProps {
  readonly persona: Persona;
  readonly position: Vec3;
  readonly yaw: number;
  /** Actual horizontal metres travelled per second, including collision response. */
  readonly speed: number;
  /** Paused or reduced-motion mode: show a neutral standing pose without gait or idle motion. */
  readonly still: boolean;
}

const EXTRAS: Readonly<Record<string, readonly ("opacity" | "glasses")[]>> = {
  Male_Adult_12: [],
  Business_Male_04: [],
  Business_Male_06: [],
  Business_Female_02: ["opacity", "glasses"],
};

function textureUrls(avatar: string): string[] {
  const base = `/avatars/${avatar}/`;
  return [`${base}body.jpg`, `${base}body_n.jpg`, `${base}head.jpg`, `${base}head_n.jpg`,
    ...(EXTRAS[avatar] ?? ["opacity"]).map((name) => `${base}${name}.png`)];
}

const DRIVEN = [
  "Bip01_L_Thigh", "Bip01_R_Thigh", "Bip01_L_Calf", "Bip01_R_Calf",
  "Bip01_L_Foot", "Bip01_R_Foot", "Bip01_L_UpperArm", "Bip01_R_UpperArm",
  "Bip01_L_Forearm", "Bip01_R_Forearm", "Bip01_Spine2", "Bip01_Head",
] as const;

/** Clone per-instance rig/material state; geometry and loader textures remain shared. */
function prepareScene(source: Object3D, textures: readonly Texture[], avatar: string): Object3D {
  const scene = cloneSkinned(source);
  const [body, bodyN, head, headN, ...extras] = textures;
  for (const texture of [body, head, ...extras]) {
    if (texture !== undefined) texture.colorSpace = SRGBColorSpace;
  }
  const extraNames = EXTRAS[avatar] ?? ["opacity"];
  const opacity = extras[extraNames.indexOf("opacity")];
  const glasses = extras[extraNames.indexOf("glasses")];
  const material = (original: Material): Material => {
    const name = original.name;
    if (name.endsWith("_body")) return new MeshStandardMaterial({
      name, map: body ?? null, normalMap: bodyN ?? null, roughness: 0.78, metalness: 0,
    });
    if (name.endsWith("_head")) return new MeshStandardMaterial({
      name, map: head ?? null, normalMap: headN ?? null, roughness: 0.58, metalness: 0,
    });
    if (name.endsWith("_opacity") && opacity !== undefined) return new MeshStandardMaterial({
      name, map: opacity, alphaTest: 0.4, side: DoubleSide, roughness: 0.7,
    });
    if (name.endsWith("_glasses") && glasses !== undefined) return new MeshStandardMaterial({
      name, map: glasses, transparent: true, roughness: 0.15, metalness: 0.4,
    });
    // Even an unfamiliar material is owned by this clone, so cleanup never disposes loader state.
    return original.clone();
  };
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const mesh = object as Mesh;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material) : material(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  });
  return scene;
}

function prepareRig(scene: Object3D) {
  const bones = new Map<string, Bone>();
  const rest = new Map<Bone, Quaternion>();
  scene.traverse((object) => {
    if (object instanceof Bone && DRIVEN.some((name) => name === object.name)) {
      const bone = object as Bone;
      bones.set(bone.name, bone);
      rest.set(bone, bone.quaternion.clone());
    }
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

  /** Rotate around an axis in the model's upright frame rather than arbitrary FBX bone axes. */
  const rotate = (name: typeof DRIVEN[number], direction: "pitch" | "roll", angle: number) => {
    const bone = bones.get(name);
    if (bone === undefined || bone.parent === null) return;
    scene.getWorldQuaternion(model);
    axis.set(direction === "pitch" ? 1 : 0, 0, direction === "roll" ? 1 : 0).applyQuaternion(model);
    bone.parent.getWorldQuaternion(parent);
    inverse.copy(parent).invert();
    rotation.setFromAxisAngle(axis, angle);
    bone.quaternion.premultiply(parent).premultiply(rotation).premultiply(inverse);
  };
  const ground = () => {
    scene.updateMatrixWorld(true);
    let lift = Infinity;
    for (const foot of feet) {
      lift = Math.min(lift, scene.worldToLocal(foot.bone.getWorldPosition(sample)).y - foot.height);
    }
    // Keep the lower sole at its standing ground height; the other foot may lift in its swing.
    if (Number.isFinite(lift)) scene.position.y = -lift;
  };
  return { scene, rest, rotate, ground };
}

export function WalkingAvatar({ persona, position, yaw, speed, still }: WalkingAvatarProps) {
  const gltf = useLoader(GLTFLoader, `/avatars/${persona.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, textureUrls(persona.avatar));
  const scene = useMemo(() => prepareScene(gltf.scene, textures, persona.avatar), [gltf, textures, persona.avatar]);
  const rig = useMemo(() => prepareRig(scene), [scene]);
  const live = useRef(rig);
  const phase = useRef(0);

  useEffect(() => {
    live.current = rig;
    phase.current = 0;
  }, [rig]);

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

  useFrame((frame, delta) => {
    const current = live.current;
    const velocity = still || !Number.isFinite(speed) ? 0 : Math.max(0, Math.min(4.2, speed));
    const stride = 1.8 + velocity * 0.15;
    phase.current = (phase.current + velocity * Math.min(delta, 0.05) * Math.PI * 2 / stride) % (Math.PI * 2);
    const blend = Math.min(1, velocity / 1.2);
    const swing = Math.sin(phase.current) * blend;
    const leftKnee = Math.max(0, swing) * 0.65;
    const rightKnee = Math.max(0, -swing) * 0.65;
    const amplitude = 0.45 + velocity * 0.07;
    const breath = still ? 0 : Math.sin(frame.clock.elapsedTime * 1.7) * 0.006;

    for (const [bone, rest] of current.rest) bone.quaternion.copy(rest);
    current.scene.position.y = 0;
    current.scene.updateMatrixWorld(true);

    current.rotate("Bip01_L_Thigh", "pitch", -swing * amplitude);
    current.rotate("Bip01_R_Thigh", "pitch", swing * amplitude);
    current.rotate("Bip01_L_Calf", "pitch", leftKnee);
    current.rotate("Bip01_R_Calf", "pitch", rightKnee);
    current.rotate("Bip01_L_Foot", "pitch", swing * amplitude - leftKnee);
    current.rotate("Bip01_R_Foot", "pitch", -swing * amplitude - rightKnee);

    // The source is a standing A-pose. Lower each arm before applying the opposite-leg swing.
    current.rotate("Bip01_L_UpperArm", "roll", -0.64);
    current.rotate("Bip01_R_UpperArm", "roll", 0.64);
    current.rotate("Bip01_L_UpperArm", "pitch", swing * 0.32);
    current.rotate("Bip01_R_UpperArm", "pitch", -swing * 0.32);
    current.rotate("Bip01_L_Forearm", "pitch", -Math.max(0, -swing) * 0.13);
    current.rotate("Bip01_R_Forearm", "pitch", -Math.max(0, swing) * 0.13);
    current.rotate("Bip01_Spine2", "pitch", breath + velocity * 0.009);
    current.rotate("Bip01_Head", "pitch", -breath * 0.45);
    current.ground();
  });

  // Rocketbox's standing bind pose faces +Z; the player/camera convention faces -Z at yaw 0.
  return <group position={position} rotation={[0, yaw + Math.PI, 0]}><primitive object={scene} dispose={null} /></group>;
}
