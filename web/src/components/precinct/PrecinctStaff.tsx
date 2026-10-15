/**
 * Ambient precinct colleagues. The public component accepts presentation controls only.
 * Rocketbox meshes/textures are the existing MIT-licensed assets under /avatars/.
 * Idle, walking, counter-work and seated desk gestures below are original procedural motion.
 */
import { useFrame, useLoader } from "@react-three/fiber";
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import {
  DoubleSide, Material, Mesh, MeshStandardMaterial, Object3D,
  SkinnedMesh, SRGBColorSpace, TextureLoader, type Group, type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import {
  advanceStaffClock, sampleStaff, sampleStaffPose, staffForTier,
  type StaffAvatar, type StaffDefinition,
} from "../../lib/precinct/proceduralStaffV1";
import { staffActorId, staffClip, type ActorCapture } from "../../lib/precinct/proceduralActors";
import type { CrowdState } from "../../lib/precinct/crowdNavigation";
import { patrolClipV2, type PatrolCycleV2, type PatrolTimeV2 } from "../../lib/precinct/proceduralPatrolV2";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot } from "./actorSamples";
import { audioMouth } from "../../lib/world/audioLips";
import { NPC_IDENTITIES } from "../../lib/precinct/npcIdentity";
import { prepareStaffAudioMouth } from "./staffAudioMouth";
import { applyLivePatrolBodyV2, applyRecordedPatrolBodyV2 } from "./patrolBodyV2";
import { prepareStandingRigV1 } from "./standingAvatarRigV1";
import { useActorSampler } from "./useActorSampler";
import type { Tier } from "../../lib/world/quality";

export interface PrecinctStaffProps {
  readonly paused: boolean;
  /** Dialogs pause the body, but an explicitly played staff clip may still move its mouth. */
  readonly speechPaused?: boolean;
  readonly reducedMotion: boolean;
  readonly tier: Tier;
  readonly actorCapture?: ActorCapture;
  /** Explicit live-only navigation snapshot; recorded actors never consume or advance it. */
  readonly crowd?: RefObject<CrowdState>;
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

/** An optional ambient asset failure must never take the walkable precinct down with it. */
class StaffBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { console.warn("An optional ambient staff avatar could not load.", error); }
  override render() { return this.state.failed ? null : this.props.children; }
}

type RecordedStaff = { readonly sample: PoseData; readonly still: boolean; readonly patrolCycle?: never }
  | { readonly sample: PoseData; readonly patrolCycle: PatrolCycleV2; readonly still?: never };
export function StaffFigure({ staff, paused, speechPaused, reducedMotion, tier, actorCapture, recorded, crowd }: PrecinctStaffProps & { readonly staff: StaffDefinition; readonly recorded?: RecordedStaff }) {
  const gltf = useLoader(GLTFLoader, `/avatars/${staff.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, textureUrls(staff.avatar));
  const scene = useMemo(() => prepareScene(gltf.scene, textures, staff.avatar), [gltf, textures, staff.avatar]);
  const rig = useMemo(() => prepareStandingRigV1(scene), [scene]);
  const mouth = useMemo(() => prepareStaffAudioMouth(scene), [scene]);
  const group = useRef<Group>(null);
  const elapsed = useRef(0);
  const patrolTime = useRef<PatrolTimeV2 | null>(null);
  const sampler = useActorSampler(recorded === undefined ? actorCapture : undefined, staffActorId(staff.id));
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
    if (recorded?.patrolCycle !== undefined) {
      applyRecordedPatrolBodyV2(root, rig, recorded.sample, recorded.patrolCycle);
      // Body-only replay owns this figure; live analyser state must never leak into it.
      mouth(null);
      return;
    }
    const navigated = recorded === undefined && staff.id === "patrol" ? crowd?.current.agents.find((actor) => actor.id === "staff:patrol") : undefined;
    if (navigated !== undefined) {
      const body = applyLivePatrolBodyV2(root, rig, patrolTime.current, navigated, delta, paused || reducedMotion);
      patrolTime.current = body;
      // Patrol has no authored speech clip; navigation never synthesizes mouth motion.
      mouth(null);
      sampler.current?.sample(root, patrolClipV2(body.cycle), body.time, delta);
      return;
    }
    patrolTime.current = null;
    const seconds = recorded?.sample.animation.time ?? advanceStaffClock(elapsed.current, delta, paused, reducedMotion);
    if (recorded === undefined) elapsed.current = seconds;
    const sample = sampleStaff(staff, seconds);
    const still = recorded?.still ?? (paused || reducedMotion);
    if (recorded === undefined) {
      root.position.set(...sample.position);
      root.rotation.set(0, sample.yaw + Math.PI, 0);
    } else applyActorRoot(root, recorded.sample);
    rig.apply(sampleStaffPose(staff.activity, seconds + staff.phase, sample.walkedDistance, sample.speed, still));
    // Body replay contains no audio track: never replay or invent lip movement.
    mouth(recorded === undefined && !reducedMotion && !(speechPaused ?? paused) ? audioMouth.weightsFor(NPC_IDENTITIES[staff.id].voice_id) : null);
    if (recorded === undefined) sampler.current?.sample(root, staffClip(staff.id, still), seconds, delta);
  });

  return <group ref={group} name={`precinct-staff-${staff.id}`} position={initial.position} rotation={[0, initial.yaw + Math.PI, 0]}>
    <primitive object={scene} dispose={null} />
  </group>;
}

/** Mount inside the existing precinct Canvas. No provider, event handler, or case context is required. */
export function PrecinctStaff({ paused, speechPaused, reducedMotion, tier, actorCapture, crowd }: PrecinctStaffProps) {
  return <group name="precinct-ambient-staff">
    {staffForTier(tier).map((staff) => <StaffBoundary key={staff.id}>
      <Suspense fallback={null}>
        <StaffFigure {...(crowd === undefined ? {} : { crowd })} staff={staff} paused={paused} {...(speechPaused === undefined ? {} : { speechPaused })} reducedMotion={reducedMotion} tier={tier} {...(actorCapture === undefined ? {} : { actorCapture })} />
      </Suspense>
    </StaffBoundary>)}
  </group>;
}
