/**
 * Quality tiers (D-025: keep 60 fps on a laptop; drop quality before realism). The scene starts high and steps
 * down one tier when a sampling window's 90th-percentile frame interval is over budget; it never steps back up in a
 * session, so it cannot oscillate. Each tier keeps the same characters and animation; only render cost changes.
 */

export type Tier = "high" | "medium" | "low";

export interface TierSettings {
  /** Device pixel ratio cap. */
  readonly dpr: number;
  /** Shadow map size, 0 for no shadows. */
  readonly shadowMap: number;
  /** Ambient occlusion pass. */
  readonly ao: boolean;
  /** Bloom on the practical lights. */
  readonly bloom: boolean;
}

export const TIERS: Readonly<Record<Tier, TierSettings>> = {
  high: { dpr: 2, shadowMap: 2048, ao: true, bloom: true },
  medium: { dpr: 1.5, shadowMap: 1024, ao: false, bloom: true },
  low: { dpr: 1, shadowMap: 1024, ao: false, bloom: false },
};

const ORDER: readonly Tier[] = ["high", "medium", "low"];

/** A frame interval budget in ms: 60 fps with a little slack. */
export const BUDGET_MS = 18.5;

/** Frames per sampling window. */
export const WINDOW = 120;

/** The 90th percentile of the intervals (ms). */
export function p90(intervals: readonly number[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
}

/** The tier after a full window of frame intervals: one step down when over budget, else unchanged. */
export function nextTier(tier: Tier, intervals: readonly number[]): Tier {
  if (intervals.length < WINDOW || p90(intervals) <= BUDGET_MS) return tier;
  const i = ORDER.indexOf(tier);
  return ORDER[Math.min(ORDER.length - 1, i + 1)] ?? tier;
}
