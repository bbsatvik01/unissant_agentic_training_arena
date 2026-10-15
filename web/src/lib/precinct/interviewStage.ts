/**
 * Presentation-only staging for assets-src/build_precinct.py. Authoring (x,y,z) maps to
 * runtime (x,z,-y). These anchors overlay the existing furniture; they do not spawn a room.
 * No answer category, evidence assessment, finding, score, or demeanor enters this model.
 */
import type { Weights } from "../world/audioLips";
import type { Tier } from "../world/quality";
import { VISEMES } from "../world/visemes";
import type { CoachDesk, FigurePose, Speech, WorldState } from "../world/worldState";
import type { CameraMode, Vec3 } from "./types";

export interface SeatAnchor {
  readonly position: Vec3;
  /** Rocketbox bind pose faces +Z, unlike the walking camera's -Z convention. */
  readonly facing: number;
}

export const INTERVIEW_TABLE = { center: [8.7, 0.76, -13.2] as Vec3, size: [2.45, 0.075, 1.05] as Vec3 };
export const SEAT_TOP = 0.52;
/** Pelvis joint sits above the cushion; IK plants each sole at its original standing floor. */
export const SEATED_PELVIS = SEAT_TOP + 0.1;
export const SUBJECT_SEAT: SeatAnchor = { position: [8.65, 0, -14.18], facing: 0 };
export const INVESTIGATOR_SEAT: SeatAnchor = { position: [8.65, 0, -12.22], facing: Math.PI };
export const SUBJECT_EYES: Vec3 = [8.65, 1.36, -14.12];
export const INVESTIGATOR_EYES: Vec3 = [8.65, 1.41, -12.31];
export const OBSERVATION_SEATS: Readonly<Record<CoachDesk, SeatAnchor>> = {
  question: { position: [6.2, 0, -17.5], facing: 0 },
  flags: { position: [8.1, 0, -17.5], facing: 0 },
  follow_up: { position: [10, 0, -17.5], facing: 0 },
};

export type ScreenStyle = "classic" | "case-board" | "playhouse" | "bid-tower";
export interface ScreenPlane {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly size: readonly [number, number];
}
/** The sole authored observation monitor; the plane is just ahead of its static lettering. */
export const OBSERVATION_MONITOR: ScreenPlane = {
  position: [11, 1.12, -16.787], rotation: [0, Math.PI, 0], size: [0.616, 0.352],
};
/** Four inset panes on that one physical screen. Full-screen expansion remains a DOM concern. */
export const OBSERVATION_SCREEN_PANES: readonly (ScreenPlane & { readonly style: ScreenStyle })[] = (
  [["classic", 1, 1], ["case-board", -1, 1], ["playhouse", 1, -1], ["bid-tower", -1, -1]] as const
).map(([style, x, y]) => ({
  style, position: [11 + x * 0.154, 1.12 + y * 0.088, -16.788] as Vec3,
  rotation: OBSERVATION_MONITOR.rotation, size: [0.298, 0.166] as const,
}));

export interface InterviewCastState {
  readonly mode: "practice" | "assessment";
  readonly subject: { readonly pose: FigurePose; readonly speech: Speech | null };
  readonly investigator: { readonly speech: Speech | null };
  /** Only work lifecycle. A citation or flag never makes a person point or react. */
  readonly coaches: readonly { readonly desk: CoachDesk; readonly pose: "idle" | "thinking" | "typing" }[];
}
export type CastWorldProjection = Pick<WorldState, "mode" | "subject" | "investigator" | "coaches">;

function speechCopy(speech: Speech | null): Speech | null {
  return speech === null ? null : { turn: speech.turn, text: speech.text, startedAt: speech.startedAt };
}

/** Copy an explicit allow-list, rather than handing the renderer the full WorldState. */
export function projectInterviewCast(world: CastWorldProjection | null): InterviewCastState | null {
  if (world === null) return null;
  return {
    mode: world.mode,
    subject: { pose: world.subject.pose, speech: speechCopy(world.subject.speech) },
    investigator: { speech: speechCopy(world.investigator.speech) },
    coaches: world.mode === "assessment" ? [] : world.coaches.filter((coach) => coach.pose !== "away").map((coach) => ({
      desk: coach.desk, pose: coach.pose === "typing" || coach.pose === "thinking" ? coach.pose : "idle",
    })),
  };
}

export interface InterviewCameraAnchor {
  readonly mode: CameraMode;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  readonly showInvestigator: boolean;
}
export interface InterviewOrbit { readonly yaw: number; readonly pitch: number; readonly distance: number }
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Opt-in only: the owning controller applies this instead of walking while seated. No camera writes here. */
export function interviewCamera(mode: CameraMode, paused: boolean, orbit: InterviewOrbit = { yaw: 0, pitch: 0.22, distance: 2.5 }): InterviewCameraAnchor {
  const effective = mode === "free" && !paused ? "first" : mode;
  if (effective === "first") return { mode: effective, position: INVESTIGATOR_EYES, target: [8.65, 1.12, -14.12], fov: 52, showInvestigator: false };
  if (effective === "third") return {
    mode: effective, position: [7.64, 1.73, -11.02], target: [8.65, 1.12, -13.68], fov: 54, showInvestigator: true,
  };
  const target: Vec3 = [8.65, 1.05, -13.2];
  const yaw = finite(orbit.yaw, 0);
  const pitch = clamp(finite(orbit.pitch, 0.22), -0.15, 0.65);
  const distance = clamp(finite(orbit.distance, 2.5), 1.2, 3.2);
  const horizontal = Math.cos(pitch) * distance;
  return {
    mode: effective,
    // Stay inside the authored interview walls and above the table when inspecting.
    position: [clamp(target[0] + Math.sin(yaw) * horizontal, 3.05, 13.25), clamp(target[1] + Math.sin(pitch) * distance, 1.0, 2.7), clamp(target[2] + Math.cos(yaw) * horizontal, -15.45, -10.55)],
    target, fov: 58, showInvestigator: true,
  };
}

/** Keep all people at every tier; lower procedural update rate and shadows, never semantic presence. */
export function castBudget(tier: Tier): { readonly frameSeconds: number; readonly shadows: boolean } {
  return { frameSeconds: tier === "low" ? 1 / 15 : tier === "medium" ? 1 / 30 : 1 / 60, shadows: tier === "high" };
}

/** Actual decoded-audio weights only. No audio means a closed mouth, even with text on the subtitle clock. */
export function audibleMouth(weights: Weights | null, still: boolean): Weights {
  if (weights === null || still) return {};
  const clean: Weights = {};
  for (const key of VISEMES) {
    const value = weights[key];
    if (key !== "sil" && value !== undefined && Number.isFinite(value) && value > 0) clean[key] = Math.min(1, value);
  }
  return clean;
}

export interface SeatedLeg {
  /** Relative to the hip in the vertical/forward plane (height, forward). */
  readonly knee: readonly [number, number];
  readonly ankle: readonly [number, number];
}
/** Two-link IK with a forward knee. Rigid bone lengths and standing ankle height are preserved. */
export function seatedLeg(upperLength: number, lowerLength: number, hipHeight: number, ankleHeight: number, forward = 0.43): SeatedLeg {
  const upper = clamp(finite(upperLength, 0.4), 0.05, 1);
  const lower = clamp(finite(lowerLength, 0.4), 0.05, 1);
  const down = finite(ankleHeight, 0.1) - finite(hipHeight, SEATED_PELVIS);
  const ahead = clamp(finite(forward, 0.43), 0.05, 1);
  const desired = Math.hypot(down, ahead);
  const distance = clamp(desired, Math.abs(upper - lower) + 0.00001, upper + lower - 0.00001);
  const y = down / desired;
  const z = ahead / desired;
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
  return { knee: [y * along + z * bend, z * along - y * bend], ankle: [y * distance, z * distance] };
}

/** Calm deterministic original motion, driven solely by presentation time and work lifecycle. */
export function seatedMotion(nowMs: number, seed: number, pose: FigurePose | "typing", still: boolean, gesture: number) {
  if (still) return { breath: 0, head: 0, hands: 0, blink: 0 };
  const t = Math.max(0, finite(nowMs, 0)) / 1000;
  const phase = (finite(seed, 0) >>> 0) % 97 / 97;
  const blinkAt = (t + phase * 4.3) % 4.3;
  const blink = blinkAt < 0.16 ? Math.sin(blinkAt / 0.16 * Math.PI) : 0;
  const energy = clamp(finite(gesture, 0.5), 0, 1);
  return {
    breath: Math.sin(t * 1.3 + phase) * 0.004,
    head: pose === "speaking" ? Math.sin(t * 2.1 + phase) * 0.013 * energy : 0,
    hands: pose === "typing" ? Math.sin(t * 8 + phase) * 0.016 : 0,
    blink,
  };
}
