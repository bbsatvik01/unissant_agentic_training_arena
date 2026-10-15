/** Seated cast only: mount inside the precinct's existing Canvas, beside Architecture. */
import { useFrame, useLoader } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, type RefObject } from "react";
import { Mesh, TextureLoader } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  audibleMouth, castBudget, INVESTIGATOR_EYES, INVESTIGATOR_SEAT, OBSERVATION_SEATS,
  seatedMotion, SUBJECT_EYES, SUBJECT_SEAT, type InterviewCastState, type SeatAnchor,
} from "../../lib/precinct/interviewStage";
import type { CameraMode, Vec3 } from "../../lib/precinct/types";
import { audioMouth, type Weights } from "../../lib/world/audioLips";
import { COACHES, INVESTIGATOR, seedOf, subjectPersona, type Persona } from "../../lib/world/cast";
import type { Tier } from "../../lib/world/quality";
import type { FigurePose } from "../../lib/world/worldState";
import { prepareSeatedRig, seatedResources, seatedTextureUrls } from "./seatedAvatarRig";

export interface PrecinctInterviewCastProps {
  /** Explicit allow-list from projectInterviewCast; never pass the whole trial/recording/debrief. */
  readonly state: InterviewCastState | null;
  readonly subjectName: string;
  readonly clock: RefObject<number>;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly tier: Tier;
  readonly view: CameraMode;
  readonly present: boolean;
  /** Use "observation" while walking there so first-person never hides the distant investigator. */
  readonly location?: "interview" | "observation";
  /** Only decoded speech audio/supplied audio-aligned visemes. Null leaves the mouth closed. */
  readonly readMouth?: (voiceKey: string) => Weights | null;
}

interface SeatedFigureProps {
  readonly persona: Persona;
  readonly name: string;
  readonly seat: SeatAnchor;
  readonly gaze: Vec3;
  readonly pose: FigurePose | "typing";
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly tier: Tier;
  readonly readMouth: (voiceKey: string) => Weights | null;
}

function SeatedFigure(props: SeatedFigureProps) {
  const gltf = useLoader(GLTFLoader, `/avatars/${props.persona.avatar}/avatar.glb`);
  const textures = useLoader(TextureLoader, seatedTextureUrls(props.persona.avatar));
  const resources = useMemo(() => seatedResources(gltf.scene, textures, props.persona.avatar), [gltf.scene, textures, props.persona.avatar]);
  const rig = useMemo(() => prepareSeatedRig(resources.scene), [resources]);
  const budget = castBudget(props.tier);
  const phase = useMemo(() => seedOf(props.name), [props.name]);
  const elapsed = useRef(Infinity);
  const live = useRef({ rig, props, phase, budget });
  useEffect(() => { live.current = { rig, props, phase, budget }; elapsed.current = Infinity; }, [rig, props, phase, budget]);
  useEffect(() => () => { resources.dispose(); }, [resources]);
  useEffect(() => {
    resources.scene.traverse((object) => { if (object instanceof Mesh) { object.castShadow = budget.shadows; object.receiveShadow = budget.shadows; } });
  }, [resources, budget.shadows]);
  useFrame((_frame, delta) => {
    const current = live.current;
    elapsed.current += Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (elapsed.current < current.budget.frameSeconds) return;
    elapsed.current = 0;
    const { persona, clock, still, pose, gaze, readMouth } = current.props;
    const motion = seatedMotion(clock.current, current.phase, pose, still, persona.gesture);
    current.rig.reset();
    current.rig.rotate("Bip01_Spine2", "pitch", Math.max(-0.12, Math.min(0.12, persona.lean)) + motion.breath);
    current.rig.rotate("Bip01_Head", "roll", Math.max(-0.08, Math.min(0.08, persona.headTilt)));
    current.rig.look(gaze);
    current.rig.rotate("Bip01_Head", "pitch", motion.head);
    current.rig.rotate("Bip01_L_Forearm", "pitch", motion.hands);
    current.rig.rotate("Bip01_R_Forearm", "pitch", -motion.hands);
    current.rig.face(audibleMouth(still ? null : readMouth(persona.voice.gemini), still), motion.blink);
  });
  return <group name={`precinct-cast:${props.name}`} position={props.seat.position} rotation={[0, props.seat.facing, 0]}>
    <primitive object={resources.scene} dispose={null} />
  </group>;
}

export function PrecinctInterviewCast({ state, subjectName, clock, paused, reducedMotion, tier, view, present, location = "interview", readMouth = audioMouth.weightsFor }: PrecinctInterviewCastProps) {
  if (!present) return null;
  const still = paused || reducedMotion;
  const investigatorVisible = location === "observation" || view === "third" || (view === "free" && paused);
  const shared = { clock, still, tier, readMouth };
  return <group name="precinct-interview-cast">
    <Suspense fallback={null}>
      <SeatedFigure {...shared} persona={subjectPersona(subjectName)} name={subjectName} seat={SUBJECT_SEAT} gaze={INVESTIGATOR_EYES} pose={state?.subject.pose ?? "idle"} />
    </Suspense>
    {investigatorVisible ? <Suspense fallback={null}>
      <SeatedFigure {...shared} persona={INVESTIGATOR} name="Investigator" seat={INVESTIGATOR_SEAT} gaze={SUBJECT_EYES} pose={state?.investigator.speech == null ? "listening" : "speaking"} />
    </Suspense> : null}
    {state?.mode !== "practice" ? null : COACHES.map((persona) => {
      const coach = state.coaches.find((entry) => entry.desk === persona.desk);
      if (coach === undefined) return null;
      const seat = OBSERVATION_SEATS[coach.desk];
      const gaze: Vec3 = coach.pose === "typing" || coach.pose === "thinking" ? [seat.position[0], 0.9, -16.7] : SUBJECT_EYES;
      return <Suspense key={persona.desk} fallback={null}>
        <SeatedFigure {...shared} persona={persona} name={persona.name} seat={seat} gaze={gaze} pose={coach.pose} />
      </Suspense>;
    })}
  </group>;
}
