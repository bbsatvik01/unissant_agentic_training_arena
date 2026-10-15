/** Original versioned investigator gait; the same evaluator applies live and recorded bodies. */
import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Mesh, TextureLoader, type Group } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { INVESTIGATOR_V1, walkingClip, type ActorCapture, type WalkingCycle } from "../../lib/precinct/proceduralActors";
import { advanceWalkingV1, sampleWalkingV1, type WalkingTimeV1, type WalkingTravel } from "../../lib/precinct/proceduralWalkingV1";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot } from "./actorSamples";
import { seatedResources, seatedTextureUrls } from "./seatedAvatarRig";
import { prepareStandingRigV1 } from "./standingAvatarRigV1";
import { useActorSampler } from "./useActorSampler";

export interface WalkingAvatarProps {
  readonly travel: RefObject<WalkingTravel>;
  readonly still: boolean;
  readonly actorCapture?: ActorCapture;
  readonly recorded?: { readonly sample: PoseData; readonly cycle: WalkingCycle };
}
export function WalkingAvatar({ travel, still, actorCapture, recorded }: WalkingAvatarProps) {
  const avatar = INVESTIGATOR_V1.avatar;
  const gltf = useLoader(GLTFLoader, `/avatars/${avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, seatedTextureUrls(avatar));
  const resources = useMemo(() => seatedResources(gltf.scene, textures, avatar), [gltf.scene, textures, avatar]);
  const rig = useMemo(() => prepareStandingRigV1(resources.scene), [resources]);
  const root = useRef<Group>(null);
  const clock = useRef<WalkingTimeV1>({ cycle: "idle", time: 0 });
  const sampler = useActorSampler(recorded === undefined ? actorCapture : undefined, "investigator:walking");
  useEffect(() => { clock.current = { cycle: "idle", time: 0 }; }, [rig]);
  useEffect(() => {
    resources.scene.traverse((object) => { if (object instanceof Mesh) { object.castShadow = true; object.receiveShadow = true; } });
    return () => { resources.dispose(); };
  }, [resources]);
  useFrame((_frame, delta) => {
    if (root.current === null) return;
    const applied = recorded === undefined ? advanceWalkingV1(clock.current, travel.current, delta, still)
      : { cycle: recorded.cycle, time: recorded.sample.animation.time };
    if (recorded === undefined) clock.current = applied;
    else applyActorRoot(root.current, recorded.sample);
    rig.apply(sampleWalkingV1(applied.cycle, applied.time));
    if (recorded === undefined) sampler.current?.sample(root.current, walkingClip(applied.cycle), applied.time, delta);
  }, -1);
  // Capture includes this +π facing conversion and the Controls parent's final position/yaw.
  return <group ref={root} name="precinct-walking-investigator" rotation={[0, Math.PI, 0]}>
    <primitive object={resources.scene} dispose={null} />
  </group>;
}
