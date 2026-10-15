/** Frozen procedural seated v1 geometry and body evaluation. No live catalogue dependencies. */
import type { FigurePose } from "../world/worldState";
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const SEATED_PELVIS = 0.62;
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
