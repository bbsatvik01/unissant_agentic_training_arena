import { describe, expect, it } from "vitest";

import { createLiveMouth, MOUTH_FLOOR, MOUTH_FULL, mouthFromLevel } from "./liveMouth";

describe("liveMouth", () => {
  it("reads null until a source is attached, then its clamped level, and detaches only its own source", () => {
    const mouth = createLiveMouth();
    expect(mouth.level("subject")).toBe(null);
    const detach = mouth.attach("subject", () => 2);
    expect(mouth.level("subject")).toBe(1);
    expect(mouth.level("investigator")).toBe(null);
    const second = mouth.attach("subject", () => Number.NaN);
    detach();
    expect(mouth.level("subject")).toBe(0);
    second();
    expect(mouth.level("subject")).toBe(null);
  });

  it("closes under the floor and opens fully at the full level", () => {
    expect(mouthFromLevel(MOUTH_FLOOR / 2, 0)).toEqual({ jaw: 0, aa: 0, O: 0 });
    const full = mouthFromLevel(MOUTH_FULL, 0);
    expect(full.jaw).toBeCloseTo(0.6);
    expect(full.aa + full.O).toBeGreaterThan(0.5);
    const later = mouthFromLevel(MOUTH_FULL, 0.2);
    expect(later.O).not.toBeCloseTo(full.O);
  });
});
