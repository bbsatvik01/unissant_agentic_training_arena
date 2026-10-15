/**
 * Authored ambient staff. Inputs are elapsed visual time and graphics quality only.
 * These characters have no access to cases, answers, interview state, scores, or user records.
 */
import type { Tier } from "../world/quality";
import type { Vec3 } from "./types";

export type StaffId = "receptionist" | "sergeant" | "analyst" | "patrol";
export type StaffActivity = "counter" | "standing" | "desk" | "patrol";
export type StaffAvatar = "Business_Female_01" | "Business_Male_04" | "Business_Male_06" | "Business_Female_02";

export interface StaffDefinition {
  readonly id: StaffId;
  readonly label: string;
  readonly avatar: StaffAvatar;
  readonly activity: StaffActivity;
  readonly position: Vec3;
  /** Camera convention: yaw zero faces north (-Z). */
  readonly yaw: number;
  readonly phase: number;
}

export const PRECINCT_STAFF: readonly StaffDefinition[] = [
  { id: "receptionist", label: "Reception officer", avatar: "Business_Female_01", activity: "counter", position: [-6.3, 0.03, -8.42], yaw: Math.PI, phase: 0.7 },
  { id: "sergeant", label: "Training sergeant", avatar: "Business_Male_04", activity: "standing", position: [-4.3, 0.03, -27.2], yaw: 0, phase: 2.1 },
  // This position is the existing office chair, not a new obstruction in the walking aisle.
  { id: "analyst", label: "Office analyst", avatar: "Business_Male_06", activity: "desk", position: [-7.6, 0.03, -14.04], yaw: 0, phase: 3.4 },
  { id: "patrol", label: "Precinct colleague", avatar: "Business_Female_02", activity: "patrol", position: [1.15, 0.03, -14.6], yaw: Math.PI, phase: 4.6 },
];

/** Both people with dialogue remain present on every graphics tier. */
export function staffForTier(tier: Tier): readonly StaffDefinition[] {
  const count = tier === "high" ? 4 : tier === "medium" ? 3 : 2;
  return PRECINCT_STAFF.slice(0, count);
}

export interface PatrolStop {
  readonly position: Vec3;
  readonly waitSeconds: number;
}

/** A finite, reversible corridor route. No doors or rooms are crossed. */
export const PATROL_STOPS: readonly PatrolStop[] = [
  { position: [1.15, 0.03, -14.6], waitSeconds: 9 },
  { position: [1.15, 0.03, -23], waitSeconds: 4 },
  { position: [1.15, 0.03, -31.1], waitSeconds: 10 },
  { position: [1.15, 0.03, -23], waitSeconds: 4 },
];
export const PATROL_SPEED = 0.85;
export const STAFF_RADIUS = 0.34;

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Never catch up after a background tab, pause, or reduced-motion interval. */
export function advanceStaffClock(seconds: number, delta: number, paused: boolean, reducedMotion: boolean): number {
  const current = finiteNonnegative(seconds);
  return paused || reducedMotion ? current : current + Math.min(0.05, finiteNonnegative(delta));
}

function length(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}
function heading(a: Vec3, b: Vec3): number {
  return Math.atan2(a[0] - b[0], a[2] - b[2]);
}
function smooth(t: number): number {
  const value = Math.max(0, Math.min(1, t));
  return value * value * (3 - 2 * value);
}
function turnBetween(from: number, to: number, amount: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * smooth(amount);
}

export const PATROL_DISTANCE = PATROL_STOPS.reduce((sum, stop, index) => {
  const next = PATROL_STOPS[(index + 1) % PATROL_STOPS.length];
  return sum + (next === undefined ? 0 : length(stop.position, next.position));
}, 0);
export const PATROL_CYCLE_SECONDS = PATROL_DISTANCE / PATROL_SPEED
  + PATROL_STOPS.reduce((sum, stop) => sum + stop.waitSeconds, 0);

export interface StaffSample {
  readonly position: Vec3;
  readonly yaw: number;
  readonly speed: number;
  readonly walkedDistance: number;
}

/** Smooth acceleration/deceleration, a stationary turn, and continuous distance-based foot phase. */
export function samplePatrol(seconds: number): StaffSample {
  const time = finiteNonnegative(seconds);
  let remaining = time % PATROL_CYCLE_SECONDS;
  let walkedDistance = Math.floor(time / PATROL_CYCLE_SECONDS) * PATROL_DISTANCE;
  for (let index = 0; index < PATROL_STOPS.length; index += 1) {
    const stop = PATROL_STOPS[index];
    const previous = PATROL_STOPS[(index + PATROL_STOPS.length - 1) % PATROL_STOPS.length];
    const next = PATROL_STOPS[(index + 1) % PATROL_STOPS.length];
    if (stop === undefined || previous === undefined || next === undefined) continue;
    const outgoing = heading(stop.position, next.position);
    if (remaining < stop.waitSeconds) {
      const turn = (remaining - Math.max(0, stop.waitSeconds - 2.4)) / 2.4;
      return { position: stop.position, yaw: turnBetween(heading(previous.position, stop.position), outgoing, turn), speed: 0, walkedDistance };
    }
    remaining -= stop.waitSeconds;
    const distance = length(stop.position, next.position);
    const duration = distance / PATROL_SPEED;
    if (remaining < duration) {
      const t = remaining / duration;
      const fraction = smooth(t);
      return {
        position: [stop.position[0] + (next.position[0] - stop.position[0]) * fraction, stop.position[1], stop.position[2] + (next.position[2] - stop.position[2]) * fraction],
        yaw: outgoing,
        speed: PATROL_SPEED * 6 * t * (1 - t),
        walkedDistance: walkedDistance + distance * fraction,
      };
    }
    remaining -= duration;
    walkedDistance += distance;
  }
  // Floating-point rounding at a cycle boundary has the same safe endpoint as a fresh cycle.
  return { position: [1.15, 0.03, -14.6], yaw: Math.PI, speed: 0, walkedDistance };
}

export function sampleStaff(staff: StaffDefinition, seconds: number): StaffSample {
  return staff.activity === "patrol" ? samplePatrol(seconds)
    : { position: staff.position, yaw: staff.yaw, speed: 0, walkedDistance: 0 };
}

export interface StaffPose {
  readonly leftHip: number;
  readonly rightHip: number;
  readonly leftKnee: number;
  readonly rightKnee: number;
  readonly leftFoot: number;
  readonly rightFoot: number;
  readonly leftArm: number;
  readonly rightArm: number;
  readonly leftElbow: number;
  readonly rightElbow: number;
  readonly spine: number;
  readonly headPitch: number;
  readonly headYaw: number;
  readonly blink: number;
}

/** Original neutral gestures. No expressive or diagnostic behavior is generated from application state. */
export function sampleStaffPose(activity: StaffActivity, seconds: number, walkedDistance: number, speed: number, still: boolean): StaffPose {
  const t = still ? 0 : finiteNonnegative(seconds);
  const velocity = still ? 0 : Math.min(1.5, finiteNonnegative(speed));
  const swing = Math.sin(finiteNonnegative(walkedDistance) * Math.PI * 2 / 1.4) * Math.min(1, velocity / 0.8);
  const leftHip = activity === "desk" ? -1.4 : -swing * 0.51;
  const rightHip = activity === "desk" ? -1.4 : swing * 0.51;
  const leftKnee = activity === "desk" ? 1.45 : Math.max(0, swing) * 0.6;
  const rightKnee = activity === "desk" ? 1.45 : Math.max(0, -swing) * 0.6;
  const desk = activity === "desk" || activity === "counter";
  const work = still ? 0 : Math.sin(t * 0.8) * 0.025;
  const breath = still ? 0 : Math.sin(t * 1.6) * 0.005;
  const intoBlink = t % 5.7;
  const blink = still || intoBlink < 5.48 ? 0 : Math.sin((intoBlink - 5.48) / 0.22 * Math.PI);
  return {
    leftHip, rightHip, leftKnee, rightKnee,
    leftFoot: -leftHip - leftKnee,
    rightFoot: -rightHip - rightKnee,
    leftArm: desk ? (activity === "desk" ? -0.54 : -0.28) + work : swing * 0.28,
    rightArm: desk ? (activity === "desk" ? -0.5 : -0.22) - work : -swing * 0.28,
    leftElbow: desk ? -0.95 + work : -0.06 - Math.max(0, -swing) * 0.12,
    rightElbow: desk ? -0.92 - work : -0.06 - Math.max(0, swing) * 0.12,
    spine: (activity === "desk" ? 0.07 : activity === "counter" ? 0.025 : 0) + breath,
    headPitch: (desk ? 0.08 : 0) - breath,
    headYaw: still || desk ? 0 : Math.sin(t * 0.22) * 0.035,
    blink: Math.max(0, Math.min(1, blink)),
  };
}
