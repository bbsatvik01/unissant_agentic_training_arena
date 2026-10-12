import { describe, expect, it } from "vitest";

import { FLIP_S, flipAt } from "./StandingsBoard";

describe("the standings board's reveal flip", () => {
  it("turns from edge-on to flat in FLIP_S seconds, eased out, and stays flat", () => {
    expect(flipAt(0)).toBeCloseTo(Math.PI / 2);
    expect(flipAt(-1)).toBeCloseTo(Math.PI / 2);
    expect(flipAt(FLIP_S / 2)).toBeLessThan(Math.PI / 4);
    expect(flipAt(FLIP_S / 2)).toBeGreaterThan(0);
    expect(flipAt(FLIP_S)).toBe(0);
    expect(flipAt(FLIP_S * 3)).toBe(0);
    expect(FLIP_S).toBeLessThanOrEqual(1);
  });
});
