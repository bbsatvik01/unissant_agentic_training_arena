/** Original finite review-panel v2. No outcome, score, flags, dialogue or private inputs. */
import type { WorkFrame } from "../agent-work/model";
import type { PoseData } from "../world/worldEvents";
import type { Collider, Vec3 } from "./types";

export const REVIEWER_ACTOR_ID_V2 = "reviewer:observation-v2";
export const REVIEWER_V2 = Object.freeze({
  actorId: REVIEWER_ACTOR_ID_V2, name: "Review panel colleague", avatar: "Business_Male_06",
  position: [4.95, 0, -17.5] as Vec3, facing: 0,
});
/** Authored bench starts at x=4.7. Its three existing chairs belong to the coaches. */
export const REVIEWER_CHAIR_V2 = Object.freeze({
  position: REVIEWER_V2.position, seatTop: 0.52, seatSize: [0.5, 0.1, 0.49] as Vec3,
  backOffset: [0, 0.83, -0.22] as Vec3, backSize: [0.49, 0.54, 0.095] as Vec3,
});
/** One conservative footprint covers both new chair and seated colleague, including knees. */
export const REVIEWER_COLLIDER_V2: Collider = Object.freeze({
  id: "reviewer-chair-v2", min: [4.55, 0, -17.9] as Vec3, max: [5.35, 1.5, -16.99] as Vec3,
});
export function withReviewerColliderV2(colliders: readonly Collider[]): readonly Collider[] {
  return colliders.some((collider) => collider.id === REVIEWER_COLLIDER_V2.id) ? colliders : [...colliders, REVIEWER_COLLIDER_V2];
}

export interface ReviewerLifecycleV2 {
  readonly phase: "listening" | "working" | "published";
  /** Actual public debrief-ready arrival. Null means no honest handover timing exists. */
  readonly publishedAtMs: number | null;
}
/** Renderer-side defense, including an explicitly pending assessment with a stale practice frame. */
export function reviewerForSceneV2(lifecycle: ReviewerLifecycleV2 | null | undefined, assessmentActive: boolean, assessment: boolean): ReviewerLifecycleV2 | null {
  return assessmentActive || (assessment && lifecycle?.phase !== "published") ? null : lifecycle ?? null;
}
export function withheldObservationActorsV2(lifecycle: ReviewerLifecycleV2 | null | undefined, assessmentActive: boolean, assessment: boolean): ReadonlySet<string> {
  if (!assessmentActive && !assessment) return new Set<string>();
  const ids = new Set(["coach:question", "coach:flags", "coach:follow_up"]);
  if (reviewerForSceneV2(lifecycle, assessmentActive, assessment) === null) ids.add(REVIEWER_ACTOR_ID_V2);
  return ids;
}
/** A stale practice frame cannot override pending/current assessment intent. Publication is a
 * separate current-run gate supplied by the session owner, never inferred from elapsed time. */
export function projectReviewerV2(frame: WorkFrame, assessmentActive: boolean, published: boolean): ReviewerLifecycleV2 | null {
  if (assessmentActive || (frame.assessment && !published)) return null;
  if (published && (frame.refereeState === "ready" || frame.refereeState === "failed")) {
    const at = frame.items.find((item) => item.kind === "referee" && item.id === "referee:published")?.atMs;
    return { phase: "published", publishedAtMs: at !== undefined && at !== null && Number.isFinite(at) && at >= 0 ? at : null };
  }
  // Assessment remains empty unless a current ended, published debrief was explicitly supplied.
  if (frame.assessment) return null;
  return { phase: frame.available && frame.refereeState === "working" ? "working" : "listening", publishedAtMs: null };
}

export const REVIEWER_POSES_V2 = ["listening", "working", "handover"] as const;
export type ReviewerPoseV2 = typeof REVIEWER_POSES_V2[number];
export type ReviewerClipIdV2 = `precinct.reviewer.v2.${ReviewerPoseV2}.${"moving" | "still"}`;
export interface ReviewerClipV2 { readonly family: "reviewer-v2"; readonly pose: ReviewerPoseV2; readonly still: boolean }
export const REVIEWER_HANDOVER_SECONDS_V2 = 1.4;
export function reviewerClipV2(pose: ReviewerPoseV2, still: boolean): ReviewerClipIdV2 {
  return `precinct.reviewer.v2.${pose}.${still ? "still" : "moving"}`;
}
export const REVIEWER_CLIPS_V2: readonly ReviewerClipIdV2[] = Object.freeze(REVIEWER_POSES_V2.flatMap((pose) => [reviewerClipV2(pose, false), reviewerClipV2(pose, true)]));
/** Call only after the shared world-event validator; exact finite strings, never prefix parsing. */
export function reviewerClipForV2(sample: PoseData): ReviewerClipV2 | null {
  if (sample.actor_id !== REVIEWER_ACTOR_ID_V2) return null;
  for (const pose of REVIEWER_POSES_V2) for (const still of [false, true]) {
    if (sample.animation.clip === reviewerClipV2(pose, still)) return { family: "reviewer-v2", pose, still };
  }
  return null;
}
export function reviewerPlaybackV2(lifecycle: ReviewerLifecycleV2, nowMs: number, still: boolean) {
  const seconds = Number.isFinite(nowMs) ? Math.max(0, nowMs) / 1000 : 0;
  const elapsed = lifecycle.publishedAtMs === null || !Number.isFinite(nowMs) ? -1 : (Math.max(0, nowMs) - lifecycle.publishedAtMs) / 1000;
  const pose: ReviewerPoseV2 = lifecycle.phase === "working" ? "working"
    : lifecycle.phase === "published" && elapsed >= 0 && elapsed < REVIEWER_HANDOVER_SECONDS_V2 ? "handover" : "listening";
  return { pose, time: pose === "handover" ? elapsed : seconds, clip: reviewerClipV2(pose, still) };
}
/** Authored neutral motion. Handing a blank publication slip makes no claim about its result. */
export function reviewerMotionV2(pose: ReviewerPoseV2, seconds: number, still: boolean) {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const phase = (t + 1.7) % 4.3;
  const progress = Math.min(1, t / REVIEWER_HANDOVER_SECONDS_V2);
  const reach = pose === "handover" ? (still ? 0.5 : Math.sin(progress * Math.PI)) : 0;
  return {
    breath: still ? 0 : Math.sin(t * 1.3 + 0.4) * 0.003,
    blink: still || phase >= 0.16 ? 0 : Math.sin(phase / 0.16 * Math.PI),
    leftArm: pose === "working" ? -0.2 : 0,
    rightArm: pose === "working" ? -0.2 : -0.35 * reach,
    leftForearm: pose === "working" ? -0.14 + (still ? 0 : Math.sin(t * 7) * 0.012) : 0,
    rightForearm: pose === "working" ? -0.14 - (still ? 0 : Math.sin(t * 7) * 0.012) : -0.22 * reach,
    paper: pose === "handover",
  };
}
