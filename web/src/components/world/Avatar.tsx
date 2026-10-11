/**
 * A realistic rigged human (D-025): a Microsoft Rocketbox character (MIT) with its skeleton, PBR skin and clothing,
 * Oculus viseme and ARKit eye and brow shapes. Layers, in order each frame:
 *   1. Motion-captured seated clips (breathing idle, an occasional look around, a thoughtful pose for thinking).
 *   2. Posture from the persona (lean, head tilt) and work poses for the coaches (typing, handing a card, pointing).
 *   3. Gaze: the head turns toward the current speaker or the work in front of it, with eye saccades and blinks.
 *   4. Speech: visemes from the text stream (`visemes.ts`) with head and hand beats on stressed words.
 *
 * PRB-4: the inputs are the lifecycle pose, the line being spoken and a gaze target. No input is the answer's
 * category, a flag, a finding, the role or the style, and no layer adds a nervous or stress tell; a persona moves the
 * same way whichever variant of its case is played. Under reduced motion or the pause control the clips hold their
 * first frame, saccades and beats stop, and a speaking face holds a still open-mouth marker.
 */
import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  DoubleSide,
  FileLoader,
  Group,
  LoopOnce,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  SkinnedMesh,
  TextureLoader,
  Vector3,
  type AnimationAction,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import { seeded, seedOf, type Persona } from "../../lib/world/cast";
import type { Vec3 } from "../../lib/world/layout";
import { beatTimes, VISEMES, visemeTrack, visemeWeightsAt, type VisemeKey, type VisemeSpan } from "../../lib/world/visemes";
import type { CoachPose, FigurePose, Speech } from "../../lib/world/worldState";

export type AvatarPose = FigurePose | CoachPose;

interface AvatarProps {
  readonly persona: Persona;
  /** A stable name for the persona's idle randomness. */
  readonly name: string;
  readonly position: Vec3;
  readonly facing: number;
  readonly pose: AvatarPose;
  readonly speech?: Speech | null;
  /** World-space point the head turns toward. */
  readonly gaze: Vec3;
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly shadows: boolean;
}

/** Which texture files each avatar ships beside its `avatar.glb`. */
const EXTRAS: Readonly<Record<string, readonly ("opacity" | "glasses")[]>> = {
  Male_Adult_12: [],
  Business_Male_04: [],
  Business_Male_06: [],
  Business_Female_02: ["opacity", "glasses"],
};

function textureUrls(avatar: string): string[] {
  const base = `/avatars/${avatar}/`;
  const extras = EXTRAS[avatar] ?? ["opacity"];
  return [`${base}body.jpg`, `${base}body_n.jpg`, `${base}head.jpg`, `${base}head_n.jpg`, ...extras.map((e) => `${base}${e}.png`)];
}

const CLIP_NAMES = ["sit_table_breathe_01", "sit_table_idle_look_around", "sit_table_gestic_thoughtful"] as const;

/** Morph names of the 15 visemes, in `VISEMES` order. */
const VISEME_MORPHS = ["AA_VI_00_Sil", "AA_VI_01_PP", "AA_VI_02_FF", "AA_VI_03_TH", "AA_VI_04_DD", "AA_VI_05_KK", "AA_VI_06_CH", "AA_VI_07_SS", "AA_VI_08_nn", "AA_VI_09_RR", "AA_VI_10_aa", "AA_VI_11_E", "AA_VI_12_I", "AA_VI_13_O", "AA_VI_14_U"];

function morphName(key: VisemeKey): string {
  return VISEME_MORPHS[VISEMES.indexOf(key)] ?? "AA_VI_00_Sil";
}

const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpV = new Vector3();
const tmpV2 = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Rotate `bone` by `angle` about a world-space `axis`, keeping its parent. */
function rotateWorld(bone: Object3D, axis: Vector3, angle: number): void {
  if (angle === 0 || bone.parent === null) return;
  bone.parent.getWorldQuaternion(tmpQ);
  tmpQ2.setFromAxisAngle(axis, angle);
  // local' = parent^-1 * R * parent * local
  const parentInv = tmpQ.clone().invert();
  bone.quaternion.premultiply(tmpQ).premultiply(tmpQ2).premultiply(parentInv);
}

function easeBeat(t: number): number {
  // a quick rise and slower fall over ~0.45 s
  if (t < 0 || t > 0.45) return 0;
  return t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.33;
}

/** The bones and faces the layers drive. */
export interface Rig {
  readonly faces: readonly SkinnedMesh[];
  readonly head: Bone | null;
  readonly neck: Bone | null;
  readonly spine: Bone | null;
  readonly lEye: Bone | null;
  readonly rEye: Bone | null;
  readonly rUpper: Bone | null;
  readonly rFore: Bone | null;
  readonly lFore: Bone | null;
  readonly rHand: Bone | null;
  readonly lHand: Bone | null;
}

/** Everything one frame of an avatar reads. */
export interface FrameContext {
  readonly rig: Rig;
  readonly mixer: AnimationMixer;
  readonly scene: Object3D;
  readonly track: readonly VisemeSpan[];
  readonly beats: readonly number[];
  readonly actions: readonly AnimationAction[];
  readonly thinking: boolean;
  readonly still: boolean;
  readonly pose: AvatarPose;
  readonly speech: Speech | null;
  readonly persona: Persona;
  readonly gaze: Vec3;
  readonly clock: RefObject<number>;
  readonly random: () => number;
}

export interface IdleState {
  nextSaccade: number;
  eyeX: number;
  eyeY: number;
  nextBlink: number;
  blinkAt: number;
  nextLook: number;
  lookEnds: number;
  headYaw: number;
  headPitch: number;
  handing: number;
  pointing: number;
  /** The animated (pre-procedural) pose of each bone the layers rotate, captured after the clips each frame. */
  readonly base: Map<Bone, Quaternion>;
}

/** The bones the procedural layers rotate on top of the clips. */
function drivenBones(rig: Rig): Bone[] {
  return [rig.spine, rig.neck, rig.head, rig.rUpper, rig.rFore, rig.lFore, rig.rHand].filter((b): b is Bone => b !== null);
}

/** One frame of the avatar's layers (clips, posture, work poses, gaze, speech, eyes). Mutates the rig in place. */
export function stepAvatar(ctx: FrameContext, s: IdleState, t: number, delta: number): void {
  const { rig, mixer, scene, track, beats, actions: acts, thinking, still, pose, speech, persona, gaze, clock, random } = ctx;
  // The layers below add rotations to bones the clips also drive. Restore last frame's animated pose first, so the
  // additions never accumulate (a paused mixer does not rewrite them), then let the clips advance and capture the
  // fresh animated pose.
  const driven = drivenBones(rig);
  for (const bone of driven) {
    const q = s.base.get(bone);
    if (q !== undefined) bone.quaternion.copy(q);
  }
  mixer.update(still ? 0 : Math.min(delta, 0.1));
  for (const bone of driven) {
    const q = s.base.get(bone);
    if (q === undefined) s.base.set(bone, bone.quaternion.clone());
    else q.copy(bone.quaternion);
  }
  // Occasional idle variation: a look around, at persona-random intervals; it fades back out before it ends.
  const [base, look] = acts;
  if (!still && !thinking && base !== undefined && look !== undefined && t > s.nextLook) {
    s.nextLook = t + 18 + random() * 22;
    look.reset().setLoop(LoopOnce, 1).setEffectiveWeight(1).fadeIn(0.8).play();
    base.fadeOut(0.8);
    s.lookEnds = t + look.getClip().duration - 0.8;
  }
  if (s.lookEnds !== 0 && t > s.lookEnds && base !== undefined && look !== undefined) {
    s.lookEnds = 0;
    look.fadeOut(0.8);
    if (!thinking) base.reset().setEffectiveWeight(1).fadeIn(0.8).play();
  }
  scene.updateMatrixWorld(true);

  // Body axes from the rig: forward from the head toward the eyes, right = forward x up.
  const head = rig.head;
  if (head === null) return;
  const eyeL = rig.lEye?.getWorldPosition(new Vector3()) ?? null;
  const eyeR = rig.rEye?.getWorldPosition(new Vector3()) ?? null;
  const headPos = head.getWorldPosition(tmpV);
  const eyes = eyeL !== null && eyeR !== null ? eyeL.clone().add(eyeR).multiplyScalar(0.5) : headPos.clone();
  const forward = eyes.clone().sub(headPos).setY(0).normalize();
  const right = tmpV2.copy(forward).cross(UP).normalize();

  // Posture: lean from the chest, the persona's habitual head tilt.
  if (rig.spine !== null) rotateWorld(rig.spine, right, -persona.lean);
  rotateWorld(head, forward, persona.headTilt);

  // Work poses (coaches): typing hands, handing a card forward, pointing at the glass.
  const time = still ? 0 : t;
  if (pose === "typing") {
    if (rig.rFore !== null) rotateWorld(rig.rFore, right, Math.sin(time * 11) * 0.06 - 0.25);
    if (rig.lFore !== null) rotateWorld(rig.lFore, right, Math.sin(time * 11 + 1.9) * 0.06 - 0.25);
  }
  s.handing += ((pose === "handing" ? 1 : 0) - s.handing) * Math.min(1, delta * 5);
  s.pointing += ((pose === "pointing" ? 1 : 0) - s.pointing) * Math.min(1, delta * 4);
  if (rig.rUpper !== null) rotateWorld(rig.rUpper, right, -(s.handing * 0.75 + s.pointing * 1.25));
  if (rig.rFore !== null) rotateWorld(rig.rFore, right, -(s.handing * 0.35 + s.pointing * 0.2));

  // Gaze: turn the head toward the target (clamped), the rest with the eyes.
  const target = tmpV.set(gaze[0], gaze[1], gaze[2]);
  const toTarget = target.sub(eyes).normalize();
  const yaw = Math.atan2(toTarget.clone().cross(forward).y, forward.dot(toTarget.clone().setY(0).normalize()));
  const pitch = Math.asin(Math.max(-1, Math.min(1, toTarget.y)));
  const wantYaw = Math.max(-0.6, Math.min(0.6, -yaw)) * 0.7;
  const wantPitch = Math.max(-0.35, Math.min(0.3, pitch)) * 0.7;
  const k = still ? 1 : Math.min(1, delta * 4);
  s.headYaw += (wantYaw - s.headYaw) * k;
  s.headPitch += (wantPitch - s.headPitch) * k;
  if (rig.neck !== null) rotateWorld(rig.neck, UP, s.headYaw * 0.4);
  rotateWorld(head, UP, s.headYaw * 0.6);
  rotateWorld(head, right, -s.headPitch);

  // Speech beats: a small nod and a hand lift on stressed words.
  let mouthOpen = 0;
  const weights: Partial<Record<VisemeKey, number>> = {};
  if (pose === "speaking" && speech !== null) {
    const elapsed = clock.current - speech.startedAt;
    if (still) mouthOpen = 0.5;
    else {
      Object.assign(weights, visemeWeightsAt(track, elapsed));
      let beat = 0;
      for (const b of beats) beat = Math.max(beat, easeBeat((elapsed - b) / 1000));
      rotateWorld(head, right, beat * 0.06 * persona.gesture);
      if (rig.rFore !== null) rotateWorld(rig.rFore, right, -beat * 0.22 * persona.gesture);
      if (rig.rHand !== null) rotateWorld(rig.rHand, right, -beat * 0.15 * persona.gesture);
    }
  }

  // Eyes: saccades, blinks.
  if (!still && t > s.nextSaccade) {
    s.nextSaccade = t + (persona.saccadeMs / 1000) * (0.4 + random() * 1.2);
    s.eyeX = (random() - 0.5) * 0.5;
    s.eyeY = (random() - 0.5) * 0.3;
  }
  if (!still && t > s.nextBlink) {
    s.blinkAt = t;
    s.nextBlink = t + (persona.blinkMs / 1000) * (0.5 + random()) * (random() < 0.15 ? 0.15 : 1);
  }
  const sinceBlink = t - s.blinkAt;
  const blink = still ? 0 : sinceBlink < 0.07 ? sinceBlink / 0.07 : sinceBlink < 0.18 ? 1 - (sinceBlink - 0.07) / 0.11 : 0;
  const eyeYaw = Math.max(-1, Math.min(1, (-yaw - wantYaw) * 1.5)) + s.eyeX;
  const eyePitch = Math.max(-1, Math.min(1, (pitch - wantPitch) * 1.5)) + s.eyeY;

  for (const face of rig.faces) {
    const dict = face.morphTargetDictionary;
    const inf = face.morphTargetInfluences;
    if (dict === undefined || inf === undefined) continue;
    const set = (n: string, v: number) => {
      const i = dict[n];
      if (i !== undefined) inf[i] = (inf[i] ?? 0) + (v - (inf[i] ?? 0)) * (still ? 1 : Math.min(1, delta * 18));
    };
    for (const key of VISEMES) if (key !== "sil") set(morphName(key), weights[key] ?? 0);
    set("AK_25_JawOpen", Math.max(mouthOpen, ((weights.aa ?? 0) + (weights.O ?? 0)) * 0.25));
    const b = Math.max(0, blink);
    const i = dict["AK_09_EyeBlinkLeft"];
    const j = dict["AK_10_EyeBlinkRight"];
    if (i !== undefined) inf[i] = b;
    if (j !== undefined) inf[j] = b;
    set("AK_13_EyeLookInLeft", Math.max(0, eyeYaw) * 0.6);
    set("AK_16_EyeLookOutRight", Math.max(0, eyeYaw) * 0.6);
    set("AK_15_EyeLookOutLeft", Math.max(0, -eyeYaw) * 0.6);
    set("AK_14_EyeLookInRight", Math.max(0, -eyeYaw) * 0.6);
    set("AK_17_EyeLookUpLeft", Math.max(0, eyePitch) * 0.5);
    set("AK_18_EyeLookUpRight", Math.max(0, eyePitch) * 0.5);
    set("AK_11_EyeLookDownLeft", Math.max(0, -eyePitch) * 0.5);
    set("AK_12_EyeLookDownRight", Math.max(0, -eyePitch) * 0.5);
  }
}

export function Avatar({ persona, name, position, facing, pose, speech = null, gaze, clock, still, shadows }: AvatarProps) {
  const gltf = useLoader(GLTFLoader, `/avatars/${persona.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, textureUrls(persona.avatar));
  const clipJson = useLoader(
    FileLoader,
    CLIP_NAMES.map((c) => `/avatars/clips/${persona.clips}_${c}.json`),
  );

  const scene = useMemo(() => {
    // SkeletonUtils.clone rebinds each skinned mesh to the cloned bones (Object3D.clone would keep the originals).
    const root = cloneSkinned(gltf.scene);
    const [body, bodyN, head, headN, ...extras] = textures as [Texture, Texture, Texture, Texture, ...Texture[]];
    for (const t of [body, head, ...extras]) t.colorSpace = SRGBColorSpace;
    const extraNames = EXTRAS[persona.avatar] ?? ["opacity"];
    const opacity = extras[extraNames.indexOf("opacity")];
    const glasses = extras[extraNames.indexOf("glasses")];
    const make = (m: Material): Material => {
      const n = m.name;
      if (n.endsWith("_body")) return new MeshStandardMaterial({ name: n, map: body, normalMap: bodyN, roughness: 0.78, metalness: 0 });
      if (n.endsWith("_head")) return new MeshStandardMaterial({ name: n, map: head, normalMap: headN, roughness: 0.58, metalness: 0 });
      if (n.endsWith("_opacity") && opacity !== undefined) return new MeshStandardMaterial({ name: n, map: opacity, alphaTest: 0.4, side: DoubleSide, roughness: 0.7 });
      if (n.endsWith("_glasses") && glasses !== undefined) return new MeshStandardMaterial({ name: n, map: glasses, transparent: true, roughness: 0.15, metalness: 0.4 });
      return m;
    };
    root.traverse((o: Object3D) => {
      if (o instanceof Mesh) {
        const mesh = o as Mesh;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(make) : make(mesh.material);
        o.castShadow = shadows;
        o.receiveShadow = shadows;
        o.frustumCulled = false;
      }
    });
    return root;
  }, [gltf, textures, persona.avatar, shadows]);

  const clips = useMemo(() => clipJson.map((json) => AnimationClip.parse(JSON.parse(String(json)) as never)), [clipJson]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actions = useRef<AnimationAction[]>([]);
  const rig = useMemo((): Rig => {
    const bones = new Map<string, Bone>();
    const faces: SkinnedMesh[] = [];
    scene.traverse((o: Object3D) => {
      if (o instanceof Bone) bones.set(o.name, o as Bone);
      if (o instanceof SkinnedMesh && o.morphTargetDictionary !== undefined) faces.push(o as SkinnedMesh);
    });
    const bone = (n: string) => bones.get(n) ?? null;
    return {
      faces,
      head: bone("Bip01_Head"),
      neck: bone("Bip01_Neck"),
      spine: bone("Bip01_Spine2"),
      lEye: bone("Bip01_LEye"),
      rEye: bone("Bip01_REye"),
      rUpper: bone("Bip01_R_UpperArm"),
      rFore: bone("Bip01_R_Forearm"),
      lFore: bone("Bip01_L_Forearm"),
      rHand: bone("Bip01_R_Hand"),
      lHand: bone("Bip01_L_Hand"),
    };
  }, [scene]);

  useEffect(() => {
    const list = clips.map((clip) => mixer.clipAction(clip));
    actions.current = list;
    const base = list[0];
    base?.play();
    return () => {
      mixer.stopAllAction();
    };
  }, [clips, mixer]);

  // Thinking poses use the thoughtful clip; everything else rests on the breathing idle.
  const thinking = pose === "thinking";
  useEffect(() => {
    const [base, , thoughtful] = actions.current;
    if (base === undefined || thoughtful === undefined) return;
    if (thinking) {
      thoughtful.reset().setEffectiveWeight(1).fadeIn(0.6).play();
      base.fadeOut(0.6);
    } else {
      base.reset().setEffectiveWeight(1).fadeIn(0.6).play();
      thoughtful.fadeOut(0.6);
    }
  }, [thinking]);

  const random = useMemo(() => seeded(seedOf(name)), [name]);
  const state = useRef<IdleState>({ nextSaccade: 0, eyeX: 0, eyeY: 0, nextBlink: 1.5, blinkAt: -10, nextLook: 14, lookEnds: 0, headYaw: 0, headPitch: 0, handing: 0, pointing: 0, base: new Map() });
  const track = useMemo(() => (speech === null ? [] : visemeTrack(speech.text)), [speech]);
  const beats = useMemo(() => (speech === null ? [] : beatTimes(speech.text)), [speech]);
  const group = useRef<Group>(null);

  // The rig is read through a ref inside the frame loop: its bones and morph weights are mutated every frame, which is
  // the renderer's job, not React state.
  const live = useRef({ rig, mixer, scene, track, beats });
  useEffect(() => {
    live.current = { rig, mixer, scene, track, beats };
  }, [rig, mixer, scene, track, beats]);

  useFrame((frame, delta) => {
    stepAvatar({ ...live.current, actions: actions.current, thinking, still, pose, speech, persona, gaze, clock, random }, state.current, frame.clock.elapsedTime, delta);
  });

  return (
    <group ref={group} position={position} rotation={[0, facing, 0]}>
      <primitive object={scene} />
    </group>
  );
}

/** Preload a persona's assets so the room does not pop in mid-flight. */
export function preloadAvatar(persona: Persona): void {
  useLoader.preload(GLTFLoader, `/avatars/${persona.avatar}/avatar.glb`);
  useLoader.preload(TextureLoader, textureUrls(persona.avatar));
  useLoader.preload(FileLoader, CLIP_NAMES.map((c) => `/avatars/clips/${persona.clips}_${c}.json`));
}
