import { describe, expect, it } from "vitest";

import { BUDGET_MS, nextTier, p90, TIERS, WINDOW } from "./quality";

const window = (ms: number) => Array.from({ length: WINDOW }, () => ms);

describe("quality tiers", () => {
  it("steps down one tier when a full window is over budget, never up, and not past low", () => {
    expect(nextTier("high", window(BUDGET_MS + 5))).toBe("medium");
    expect(nextTier("medium", window(BUDGET_MS + 5))).toBe("low");
    expect(nextTier("low", window(40))).toBe("low");
    expect(nextTier("medium", window(10))).toBe("medium");
  });

  it("waits for a full window", () => {
    expect(nextTier("high", window(40).slice(1))).toBe("high");
  });

  it("reads the 90th percentile, so a few slow frames do not trip it", () => {
    const mostlyFast = [...window(16.7).slice(0, WINDOW - 5), 40, 40, 40, 40, 40];
    expect(p90(mostlyFast)).toBeCloseTo(16.7);
    expect(nextTier("high", mostlyFast)).toBe("high");
    expect(p90([])).toBe(0);
  });

  it("keeps realism in every tier: only render cost changes", () => {
    expect(TIERS.low.shadowMap).toBeGreaterThan(0);
    expect(TIERS.high.ao && !TIERS.medium.ao).toBe(true);
    // The low tier keeps the precinct to its one detective.
    expect([TIERS.high.crowd, TIERS.medium.crowd, TIERS.low.crowd]).toEqual([true, true, false]);
  });
});
