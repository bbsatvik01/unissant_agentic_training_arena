import type { Tier } from "../world/quality";

/** Working budgets, not hardware guarantees. `medium` is the UI's Balanced tier. */
export const PRECINCT_RENDER_BUDGET = {
  low: { dpr: 0.75, pixels: 1_500_000, drawCalls: 140, triangles: 500_000, textureMiB: 192 },
  medium: { dpr: 1.25, pixels: 2_500_000, drawCalls: 200, triangles: 800_000, textureMiB: 256 },
  high: { dpr: 1.75, pixels: 4_000_000, drawCalls: 260, triangles: 1_100_000, textureMiB: 384 },
} as const;

/** Both Retina DPR and total fill cost are bounded; do not multiply device DPR twice. */
export function precinctDpr(tier: Tier, deviceDpr: number, width: number, height: number): number {
  const budget = PRECINCT_RENDER_BUDGET[tier];
  const device = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  const area = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width * height : 1;
  return Math.min(device, budget.dpr, Math.sqrt(budget.pixels / area));
}

export function percentile(values: readonly number[], quantile: number): number | null {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * quantile) - 1))] ?? null;
}

/** Sampling only: never changes simulation time, actors, reducers or replay samples. */
export class PrecinctQualityWindow {
  private last: number | null = null;
  private settleUntil = 0;
  private windowStart = 0;
  private samples: number[] = [];
  private strikes = 0;
  private tier: Tier | null = null;
  private running = false;

  sample(now: number, tier: Tier, continuous: boolean, visible: boolean): Tier {
    const running = Number.isFinite(now) && continuous && visible;
    if (!running || running !== this.running || tier !== this.tier) {
      this.last = null; this.samples = []; this.strikes = 0; this.tier = tier; this.running = running;
      this.settleUntil = Number.isFinite(now) ? now + 4000 : 0;
      this.windowStart = this.settleUntil;
      return tier;
    }
    if (this.last === null) { this.last = now; return tier; }
    const interval = now - this.last;
    this.last = now;
    if (now < this.settleUntil || interval <= 0) return tier;
    // A bounded window. At high refresh rates no unbounded allocation or per-frame sorting.
    if (this.samples.length < 512) this.samples.push(interval);
    if (now - this.windowStart < 2000 || this.samples.length < 30) return tier;
    this.strikes = (percentile(this.samples, 0.95) ?? 0) > 18.5 ? this.strikes + 1 : 0;
    this.samples = []; this.windowStart = now;
    if (this.strikes < 2) return tier;
    this.strikes = 0; this.last = null; this.settleUntil = now + 4000; this.windowStart = this.settleUntil;
    return tier === "high" ? "medium" : "low";
  }
}
