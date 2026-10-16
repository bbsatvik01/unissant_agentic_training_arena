/** Seated cast only: one Canvas, finite public personas and exact procedural body replay. */
import { useFrame, useLoader } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, type RefObject } from "react";
import { Mesh, TextureLoader, type Group } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { audibleMouth, castBudget, type InterviewCastState } from "../../lib/precinct/interviewStage";
import {
  bodyPoseV1, INVESTIGATOR_V1, publicSubjectV1, SEATED_ACTORS_V1, seatedClip,
  type ActorCapture, type BodyPose, type SeatedActorV1,
} from "../../lib/precinct/proceduralActors";
import type { CameraMode } from "../../lib/precinct/types";
import { audioMouth, type Weights } from "../../lib/world/audioLips";
import type { Tier } from "../../lib/world/quality";
import type { PoseData } from "../../lib/world/worldEvents";
import { applyActorRoot } from "./actorSamples";
import { prepareSeatedRig, seatedResources, seatedTextureUrls } from "./seatedAvatarRig";
import { applySeatedBodyV1 } from "./seatedBodyV1";
import { useActorSampler } from "./useActorSampler";

export interface PrecinctInterviewCastProps {
  readonly state: InterviewCastState | null;
  readonly subjectName: string;
  readonly clock: RefObject<number>;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly tier: Tier;
  readonly view: CameraMode;
  readonly present: boolean;
  readonly investigatorPresent?: boolean;
  readonly location?: "interview" | "observation";
  readonly readMouth?: (voiceKey: string) => Weights | null;
  readonly actorCapture?: ActorCapture;
}
export interface SeatedFigureProps {
  readonly actor: SeatedActorV1;
  readonly pose: BodyPose;
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly tier: Tier;
  readonly visible?: boolean;
  readonly readMouth: (voiceKey: string) => Weights | null;
  readonly actorCapture?: ActorCapture;
  readonly recorded?: PoseData;
}
export function SeatedFigure(props: SeatedFigureProps) {
  const avatar = props.actor.avatar;
  const gltf = useLoader(GLTFLoader, `/avatars/${avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, seatedTextureUrls(avatar));
  const resources = useMemo(() => seatedResources(gltf.scene, textures, avatar), [gltf.scene, textures, avatar]);
  const rig = useMemo(() => prepareSeatedRig(resources.scene), [resources]);
  const root = useRef<Group>(null);
  const elapsed = useRef(Infinity);
  const captureElapsed = useRef(0);
  const budget = castBudget(props.tier);
  const sampler = useActorSampler(props.recorded === undefined ? props.actorCapture : undefined, props.actor.actorId);
  const live = useRef(props);
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
    // Replayed samples are applied immediately, including paused seeks; time never accumulates.
    if (current.recorded === undefined && elapsed.current < budget.frameSeconds) return;
    elapsed.current = 0;
    const seconds = current.recorded?.animation.time ?? Math.max(0, current.clock.current) / 1000;
    if (current.recorded !== undefined) applyActorRoot(root.current, current.recorded);
    const mouth = current.recorded === undefined ? audibleMouth(current.still ? null : current.readMouth(current.actor.voiceKey), current.still) : {};
    applySeatedBodyV1(rig, current.actor, current.pose, seconds, current.still, mouth);
    if (current.recorded === undefined) sampler.current?.sample(root.current, seatedClip(current.actor, current.pose, current.still), seconds, captureElapsed.current);
    captureElapsed.current = 0;
  }, -1);
  return <group ref={root} name={`precinct-cast:${props.actor.name}`} position={props.actor.position} rotation={[0, props.actor.facing, 0]} visible={props.visible ?? true}>
    <primitive object={resources.scene} dispose={null} />
  </group>;
}
export function PrecinctInterviewCast({ state, subjectName, clock, paused, reducedMotion, tier, view, present, investigatorPresent = true, location = "interview", readMouth = audioMouth.weightsFor, actorCapture }: PrecinctInterviewCastProps) {
  if (!present) return null;
  const still = paused || reducedMotion;
  const investigatorVisible = location === "observation" || view === "third" || (view === "free" && paused);
  const shared = { clock, still, tier, readMouth, ...(actorCapture === undefined ? {} : { actorCapture }) };
  const subject = publicSubjectV1(subjectName);
  return <group name="precinct-interview-cast">
    {subject === undefined ? null : <Suspense fallback={null}>
      <SeatedFigure {...shared} actor={subject} pose={bodyPoseV1(state?.subject.pose ?? "idle")} />
    </Suspense>}
    {investigatorPresent && (investigatorVisible || actorCapture !== undefined) ? <Suspense fallback={null}>
      <SeatedFigure {...shared} actor={INVESTIGATOR_V1} visible={investigatorVisible} pose={state?.investigator.speech == null ? "listening" : "speaking"} />
    </Suspense> : null}
    {state?.mode !== "practice" ? null : SEATED_ACTORS_V1.filter((actor) => actor.kind === "coach").map((actor) => {
      const coach = state.coaches.find((entry) => entry.desk === actor.desk);
      return coach === undefined ? null : <Suspense key={actor.actorId} fallback={null}>
        <SeatedFigure {...shared} actor={actor} pose={bodyPoseV1(coach.pose)} />
      </Suspense>;
    })}
  </group>;
}
