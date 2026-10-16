/** One fictional review colleague at the existing observation bench. No network or own clock. */
import { useFrame, useLoader } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, type RefObject } from "react";
import { Mesh, Quaternion, TextureLoader, Vector3, type Group } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { castBudget } from "../../lib/precinct/interviewStage";
import type { ActorCapture } from "../../lib/precinct/proceduralActors";
import { REVIEWER_CHAIR_V2, REVIEWER_V2, reviewerMotionV2, reviewerPlaybackV2, type ReviewerClipV2, type ReviewerLifecycleV2 } from "../../lib/precinct/proceduralReviewerV2";
import type { Tier } from "../../lib/world/quality";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot } from "./actorSamples";
import { applyReviewerBodyV2, prepareReviewerRigV2 } from "./reviewerBodyV2";
import { seatedResources, seatedTextureUrls } from "./seatedAvatarRig";
import { useActorSampler } from "./useActorSampler";

/** Original low-poly chair only: no second worktop, room or monitor. Matches authored seat height. */
export function ReviewPanelChairV2() {
  return <group name="review-panel-chair-v2" position={REVIEWER_CHAIR_V2.position}>
    <mesh position={[0, 0.47, 0]}><boxGeometry args={[...REVIEWER_CHAIR_V2.seatSize]} /><meshStandardMaterial color="#425f65" roughness={0.9} /></mesh>
    <mesh position={REVIEWER_CHAIR_V2.backOffset}><boxGeometry args={[...REVIEWER_CHAIR_V2.backSize]} /><meshStandardMaterial color="#425f65" roughness={0.9} /></mesh>
    {[-0.21, 0.21].flatMap((x) => [-0.18, 0.18].map((z) => <mesh key={`${String(x)}:${String(z)}`} position={[x, 0.235, z]}><boxGeometry args={[0.035, 0.47, 0.035]} /><meshStandardMaterial color="#303a3e" roughness={0.7} /></mesh>))}
  </group>;
}
export interface ReviewerFigureV2Props {
  readonly lifecycle: ReviewerLifecycleV2;
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly tier: Tier;
  readonly actorCapture?: ActorCapture;
  readonly recorded?: { readonly sample: PoseData; readonly clip: ReviewerClipV2 };
}
export function ReviewerFigureV2(props: ReviewerFigureV2Props) {
  const gltf = useLoader(GLTFLoader, `/avatars/${REVIEWER_V2.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, seatedTextureUrls(REVIEWER_V2.avatar));
  const resources = useMemo(() => seatedResources(gltf.scene, textures, REVIEWER_V2.avatar), [gltf.scene, textures]);
  const rig = useMemo(() => prepareReviewerRigV2(resources.scene), [resources]);
  const root = useRef<Group>(null); const paper = useRef<Group>(null);
  const elapsed = useRef(Infinity); const captureElapsed = useRef(0);
  const sampler = useActorSampler(props.recorded === undefined ? props.actorCapture : undefined, REVIEWER_V2.actorId);
  const budget = castBudget(props.tier);
  const live = useRef(props);
  const scratch = useMemo(() => ({ position: new Vector3(), rotation: new Quaternion(), parent: new Quaternion() }), []);
  useEffect(() => { live.current = props; elapsed.current = Infinity; }, [props]);
  useEffect(() => () => { resources.dispose(); }, [resources]);
  useEffect(() => {
    resources.scene.traverse((object) => { if (object instanceof Mesh) { object.castShadow = budget.shadows; object.receiveShadow = budget.shadows; } });
  }, [resources, budget.shadows]);
  useFrame((_frame, delta) => {
    if (root.current === null) return;
    const current = live.current;
    const step = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    elapsed.current += step; captureElapsed.current += step;
    if (current.recorded === undefined && elapsed.current < budget.frameSeconds) return;
    elapsed.current = 0;
    const playback = current.recorded === undefined ? reviewerPlaybackV2(current.lifecycle, current.clock.current, current.still)
      : { pose: current.recorded.clip.pose, time: current.recorded.sample.animation.time, clip: current.recorded.sample.animation.clip };
    const pose = playback.pose;
    const seconds = playback.time;
    const still = current.recorded?.clip.still ?? current.still;
    if (current.recorded !== undefined) applyActorRoot(root.current, current.recorded.sample);
    applyReviewerBodyV2(rig, pose, seconds, still);
    if (paper.current !== null) {
      paper.current.visible = reviewerMotionV2(pose, seconds, still).paper && rig.hand !== null;
      if (rig.hand !== null) {
        rig.hand.getWorldPosition(scratch.position); root.current.worldToLocal(scratch.position);
        paper.current.position.copy(scratch.position);
        rig.hand.getWorldQuaternion(scratch.rotation); root.current.getWorldQuaternion(scratch.parent);
        paper.current.quaternion.copy(scratch.parent.invert().multiply(scratch.rotation));
      }
    }
    if (current.recorded === undefined) sampler.current?.sample(root.current, playback.clip, seconds, captureElapsed.current);
    captureElapsed.current = 0;
  }, -1);
  return <group ref={root} name="precinct-review-panel-v2" position={REVIEWER_V2.position} rotation={[0, REVIEWER_V2.facing, 0]}>
    <primitive object={resources.scene} dispose={null} />
    <group ref={paper} name="published-review-blank-slip" visible={false}><mesh position={[0, 0, 0.08]}><boxGeometry args={[0.13, 0.003, 0.19]} /><meshStandardMaterial color="#eee8d8" roughness={0.95} /></mesh></group>
  </group>;
}
export function PrecinctReviewPanel(props: Omit<ReviewerFigureV2Props, "lifecycle" | "recorded"> & { readonly lifecycle: ReviewerLifecycleV2 | null }) {
  return props.lifecycle === null ? null : <Suspense fallback={null}><ReviewerFigureV2 {...props} lifecycle={props.lifecycle} /></Suspense>;
}
