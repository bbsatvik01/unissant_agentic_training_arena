/** Public finite versioned procedural catalogue. These identifiers are not asset paths or encoded state. */
import { isWorldEvent, type CameraData, type PoseData } from "../world/worldEvents";
import { PRECINCT_STAFF, type StaffDefinition, type StaffId } from "./proceduralStaffV1";
import type { Vec3 } from "./types";
import { REVIEWER_ACTOR_ID_V2, reviewerClipForV2, type ReviewerClipIdV2, type ReviewerClipV2 } from "./proceduralReviewerV2";
import { patrolCycleV2, type PatrolClipIdV2, type PatrolCycleV2 } from "./proceduralPatrolV2";

export interface ActorCapture {
  /** Change with the case/capture session. The callback must reject calls after this scope closes. */
  readonly scope: string;
  readonly onActorSample: (sample: PoseData) => void;
}
export interface ReplayCamera {
  readonly ownership: "recorded" | "free";
  readonly sample: CameraData | null;
}
export type BodyPose = "idle" | "listening" | "speaking" | "thinking" | "typing";
export type WalkingCycle = "idle" | "walk" | "run" | "still";
export type MotionVariant = "moving" | "still";
export interface SeatedActorV1 {
  readonly key: SeatedActorKey;
  readonly actorId: string;
  readonly name: string;
  readonly avatar: string;
  readonly lean: number;
  readonly headTilt: number;
  readonly gesture: number;
  readonly seed: number;
  readonly voiceKey: string;
  readonly position: Vec3;
  readonly facing: number;
  readonly kind: "subject" | "investigator" | "coach";
  readonly desk?: "question" | "flags" | "follow_up";
}
function seedV1(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
  return hash >>> 0;
}
const SUBJECTS_V1 = [
  ["jordan-pell", "Jordan Pell", "Male_Adult_05", 0.05, 0.03, 0.55],
  ["mara-quell", "Mara Quell", "Female_Adult_14", 0.02, -0.04, 0.35],
  ["avery-lindqvist", "Avery Lindqvist", "Male_Adult_08", 0.08, 0, 0.7],
  ["dana-okafor", "Dana Okafor", "Female_Adult_07", 0.04, 0.05, 0.6],
  ["rafael-strand", "Rafael Strand", "Male_Adult_12", 0, -0.02, 0.4],
  ["priya-halloran", "Priya Halloran", "Female_Adult_14", 0.03, 0.02, 0.45],
  ["glen-mattick", "Glen Mattick", "Male_Adult_12", 0.06, 0.03, 0.65],
  ["sami-varga", "Sami Varga", "Male_Adult_08", 0.02, -0.02, 0.4],
  ["elise-dunmore", "Elise Dunmore", "Female_Adult_07", 0.05, 0.04, 0.55],
] as const;
export const INVESTIGATOR_V1: SeatedActorV1 = Object.freeze({
  key: "investigator", actorId: "investigator:seated", name: "Investigator", avatar: "Business_Male_02",
  lean: 0.1, headTilt: 0, gesture: 0.45, seed: seedV1("Investigator"), voiceKey: "investigator",
  position: [8.65, 0, -12.22] as Vec3, facing: Math.PI, kind: "investigator",
});
export const SEATED_ACTORS_V1: readonly SeatedActorV1[] = Object.freeze([
  ...SUBJECTS_V1.map(([key, name, avatar, lean, headTilt, gesture]): SeatedActorV1 => Object.freeze({
    key, name, actorId: `subject:${key}`, avatar, lean, headTilt, gesture,
    seed: seedV1(name), voiceKey: `subject:${name}`, position: [8.65, 0, -14.18] as Vec3, facing: 0, kind: "subject",
  })),
  INVESTIGATOR_V1,
  ...([
    ["question", "Question desk", "Business_Female_01", 0.12, 0.02, 0.5, 6.2],
    ["flags", "Flags desk", "Business_Male_04", 0.06, -0.03, 0.35, 8.1],
    ["follow_up", "Follow-up desk", "Business_Female_02", 0.1, 0.04, 0.6, 10],
  ] as const).map(([desk, name, avatar, lean, headTilt, gesture, x]): SeatedActorV1 => Object.freeze({
    key: `coach-${desk}`, actorId: `coach:${desk}`, name, avatar, lean, headTilt, gesture, desk,
    seed: seedV1(name), voiceKey: `coach:${desk}`, position: [x, 0, -17.5] as Vec3, facing: 0, kind: "coach",
  })),
]);
export type SeatedActorKey = typeof SUBJECTS_V1[number][0] | "investigator" | "coach-question" | "coach-flags" | "coach-follow_up";
export type ProceduralClipId = ReviewerClipIdV2 | PatrolClipIdV2 | "precinct.actor.v1.absent"
  | `precinct.staff.v1.${StaffId}.${MotionVariant}`
  | `precinct.seated.v1.${SeatedActorKey}.${BodyPose}.${MotionVariant}`
  | `precinct.walking.v1.investigator.${WalkingCycle}`;
export const ABSENT_CLIP = "precinct.actor.v1.absent";
export type ProceduralClip =
  | ReviewerClipV2
  | { readonly family: "absent"; readonly actorId: string }
  | { readonly family: "staff"; readonly staff: StaffDefinition; readonly still: boolean }
  | { readonly family: "seated"; readonly actor: SeatedActorV1; readonly pose: BodyPose; readonly still: boolean }
  | { readonly family: "patrol-v2"; readonly staff: StaffDefinition; readonly cycle: PatrolCycleV2 }
  | { readonly family: "walking"; readonly cycle: WalkingCycle };
const clips = new Map<string, ProceduralClip>();
const actors = new Set<string>();
export function staffActorId(id: StaffId): string { return `staff:${id}`; }
export function staffClip(id: StaffId, still: boolean): ProceduralClipId { return `precinct.staff.v1.${id}.${still ? "still" : "moving"}`; }
export function seatedClip(actor: SeatedActorV1, pose: BodyPose, still: boolean): ProceduralClipId { return `precinct.seated.v1.${actor.key}.${pose}.${still ? "still" : "moving"}`; }
export function walkingClip(cycle: WalkingCycle): ProceduralClipId { return `precinct.walking.v1.investigator.${cycle}`; }
for (const staff of PRECINCT_STAFF) {
  actors.add(staffActorId(staff.id));
  for (const still of [false, true]) clips.set(staffClip(staff.id, still), { family: "staff", staff, still });
}
for (const actor of SEATED_ACTORS_V1) {
  actors.add(actor.actorId);
  for (const pose of ["idle", "listening", "speaking", "thinking", "typing"] as const) {
    for (const still of [false, true]) clips.set(seatedClip(actor, pose, still), { family: "seated", actor, pose, still });
  }
}
actors.add("investigator:walking");
for (const cycle of ["idle", "walk", "run", "still"] as const) clips.set(walkingClip(cycle), { family: "walking", cycle });
/** Finite registry for documentation/tests; never interpret arbitrary strings as filenames. */
export const PROCEDURAL_CLIPS_V1: readonly string[] = Object.freeze([ABSENT_CLIP, ...clips.keys()]);
export const PROCEDURAL_ACTOR_IDS_V1: readonly string[] = Object.freeze([...actors]);

export function proceduralClip(sample: PoseData): ProceduralClip | null {
  if (!isWorldEvent({ t_ms: 0, kind: "pose", data: sample })) return null;
  if (!actors.has(sample.actor_id) && sample.actor_id !== REVIEWER_ACTOR_ID_V2) return null;
  if (sample.animation.clip === ABSENT_CLIP) return { family: "absent", actorId: sample.actor_id };
  const reviewer = reviewerClipForV2(sample);
  if (reviewer !== null) return reviewer;
  const cycle = patrolCycleV2(sample.animation.clip);
  if (cycle !== null && sample.actor_id === "staff:patrol") {
    const staff = PRECINCT_STAFF.find((actor) => actor.id === "patrol");
    if (staff !== undefined) return { family: "patrol-v2", staff, cycle };
  }
  const clip = clips.get(sample.animation.clip);
  if (clip === undefined) return null;
  if (clip.family === "staff" && sample.actor_id === staffActorId(clip.staff.id)) return clip;
  if (clip.family === "seated" && sample.actor_id === clip.actor.actorId) return clip;
  if (clip.family === "walking" && sample.actor_id === "investigator:walking") return clip;
  return null;
}
export function isProceduralActorSample(sample: PoseData): boolean { return proceduralClip(sample) !== null; }
export function publicSubjectV1(name: string): SeatedActorV1 | undefined { return SEATED_ACTORS_V1.find((actor) => actor.kind === "subject" && actor.name === name); }
export function bodyPoseV1(pose: string): BodyPose {
  return pose === "listening" || pose === "speaking" || pose === "thinking" || pose === "typing" ? pose : "idle";
}
/** Fixed public gaze rules are part of the version, not derived from recorded outcomes. */
export function seatedGazeV1(actor: SeatedActorV1, pose: BodyPose): Vec3 {
  if (actor.kind === "subject") return [8.65, 1.41, -12.31];
  if (actor.kind === "coach" && (pose === "typing" || pose === "thinking")) return [actor.position[0], 0.9, -16.7];
  return [8.65, 1.36, -14.12];
}
