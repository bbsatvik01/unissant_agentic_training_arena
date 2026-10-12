import { describe, expect, it } from "vitest";

import { FLIP_S, flipAt, flipOffset, STANDINGS_SIZE } from "./StandingsBoard";

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

  it("stands the turning board out from the wall far enough that its far edge never goes behind it", () => {
    for (let t = 0; t <= FLIP_S; t += FLIP_S / 20) {
      const a = flipAt(t);
      // The far edge's depth relative to the wall: offset minus half width times sin(angle).
      expect(flipOffset(a) - (STANDINGS_SIZE[0] / 2) * Math.sin(a)).toBeGreaterThan(0.01);
    }
    expect(flipOffset(0)).toBe(0);
  });
});
