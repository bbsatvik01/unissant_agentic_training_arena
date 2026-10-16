import { describe, expect, it } from "vitest";
import { seatedLeg, seatedMotion } from "./proceduralSeatedV1";
describe("frozen seated body v1", () => {
  it("has deterministic body timing, closed still expressions and finite sanitized parameters", () => {
    expect(seatedMotion(2123, 42, "speaking", false, 0.7)).toEqual(seatedMotion(2123, 42, "speaking", false, 0.7));
    expect(seatedMotion(2123, 42, "typing", true, 0.7)).toEqual({ breath: 0, head: 0, hands: 0, blink: 0 });
    expect(seatedMotion(2123, 42, "typing", false, 0.7).hands).not.toBe(0);
    expect(seatedMotion(2123, 42, "idle", false, 0.7).head).toBe(0);
    expect(seatedMotion(80, 0, "idle", false, 0).blink).toBeCloseTo(1);
    expect(Object.values(seatedMotion(NaN, Infinity, "speaking", false, NaN)).every(Number.isFinite)).toBe(true);
  });
  it("preserves measured leg lengths and clamps impossible measurements", () => {
    const fitted = seatedLeg(0.399, 0.397, 0.62, 0.101);
    expect(Math.hypot(...fitted.knee)).toBeCloseTo(0.399);
    expect(Math.hypot(fitted.ankle[0] - fitted.knee[0], fitted.ankle[1] - fitted.knee[1])).toBeCloseTo(0.397);
    for (const args of [[NaN, Infinity, NaN, NaN, NaN], [0, -1, 20, -20, 0], [1, 0.05, 0, 0, 0.05]] as const) {
      const pose = seatedLeg(args[0], args[1], args[2], args[3], args[4]); expect([...pose.knee, ...pose.ankle].every(Number.isFinite)).toBe(true);
    }
  });
});
