import { describe, expect, it } from "vitest";
import { percentile, precinctDpr, PRECINCT_RENDER_BUDGET, PrecinctQualityWindow } from "./renderQuality";

describe("precinct render quality", () => {
  it("caps Retina DPR and total pixels without scaling twice", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      for (const [width, height] of [[1440, 900], [2560, 1664], [3840, 2160]] as const) {
        const dpr = precinctDpr(tier, 3, width, height);
        expect(dpr).toBeLessThanOrEqual(PRECINCT_RENDER_BUDGET[tier].dpr);
        expect(width * height * dpr * dpr).toBeLessThanOrEqual(PRECINCT_RENDER_BUDGET[tier].pixels + 1);
      }
    }
    expect(precinctDpr("high", 1, 100, 100)).toBe(1);
    expect(precinctDpr("medium", NaN, 0, Infinity)).toBe(1);
    expect(precinctDpr("low", -1, -2, 2)).toBe(0.75);
  });
  it("returns nearest-rank percentiles and no invented measurement for empty samples", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([NaN, -1, Infinity], 0.5)).toBeNull();
    expect(percentile([4, 1, 2, 3], 0.5)).toBe(2);
    expect(percentile([4, 1, 2, 3], 0.99)).toBe(4);
    expect(percentile([1], 0)).toBe(1);
  });
  it("requires warm-up and two sustained slow windows, and never steps up", () => {
    const sample = new PrecinctQualityWindow();
    for (let t = 0; t < 8000; t += 25) expect(sample.sample(t, "high", true, true)).toBe("high");
    expect(sample.sample(8000, "high", true, true)).toBe("medium");
    expect(sample.sample(8025, "medium", true, true)).toBe("medium");
    for (let t = 8050; t < 13000; t += 16) expect(sample.sample(t, "medium", true, true)).toBe("medium");
  });
  it("ignores demand, hidden and nonfinite samples and clears a slow-window strike", () => {
    const sample = new PrecinctQualityWindow();
    for (let t = 0; t < 6050; t += 25) sample.sample(t, "high", true, true);
    expect(sample.sample(7000, "high", false, true)).toBe("high");
    expect(sample.sample(50_000, "high", true, false)).toBe("high");
    expect(sample.sample(NaN, "high", true, true)).toBe("high");
    for (let t = 50_100; t < 56_000; t += 16) expect(sample.sample(t, "high", true, true)).toBe("high");
    expect(sample.sample(56_000, "high", true, true)).toBe("high");
    expect(sample.sample(56_000, "high", true, true)).toBe("high");
  });
  it("starts a fresh warm-up on resuming after a long demand or hidden gap", () => {
    for (const hidden of [false, true]) {
      const sample = new PrecinctQualityWindow();
      for (let t = 0; t < 6050; t += 25) sample.sample(t, "high", true, true);
      sample.sample(6100, "high", hidden, !hidden);
      for (let t = 60_000; t < 68_000; t += 25) expect(sample.sample(t, "high", true, true)).toBe("high");
      expect(sample.sample(68_000, "high", true, true)).toBe("medium");
    }
  });
  it("handles very slow and high-refresh windows with a bounded sample count", () => {
    const slow = new PrecinctQualityWindow();
    let result = "low";
    for (let t = 0; t < 20_000; t += 100) result = slow.sample(t, "low", true, true);
    expect(result).toBe("low");
    const fast = new PrecinctQualityWindow();
    for (let t = 0; t < 9000; t += 1) expect(fast.sample(t, "medium", true, true)).toBe("medium");
  });
});
