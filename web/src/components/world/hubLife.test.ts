import { describe, expect, it } from "vitest";

import { PASS_EVERY_S, PASS_FOR_S, passAt } from "./hubLife";

describe("the corridor officer", () => {
  it("walks the corridor for a few seconds in every cycle, and is otherwise away", () => {
    expect(passAt(0)).toBe(0);
    expect(passAt(PASS_FOR_S / 2)).toBeCloseTo(0.5);
    expect(passAt(PASS_FOR_S + 0.01)).toBeNull();
    expect(passAt(PASS_EVERY_S + 1)).toBeCloseTo(1 / PASS_FOR_S);
    expect(PASS_FOR_S).toBeLessThan(PASS_EVERY_S / 3);
  });
});
