import { describe, expect, it } from "vitest";

import { advanceCadence } from "./cadence";

describe("advanceCadence", () => {
  it("accumulates short frames and resets when the tenth of a second is due", () => {
    const first = advanceCadence(0, 0.04);
    expect(first).toEqual({ elapsed: 0.04, due: false });
    const second = advanceCadence(first.elapsed, 0.03);
    expect(second.elapsed).toBeCloseTo(0.07);
    expect(second.due).toBe(false);
    expect(advanceCadence(second.elapsed, 0.03)).toEqual({ elapsed: 0, due: true });
  });

  it("handles rounding when ten hundredth-of-a-second frames reach the interval", () => {
    let elapsed = 0;
    for (let frame = 0; frame < 10; frame += 1) {
      const next = advanceCadence(elapsed, 0.01);
      expect(next.due).toBe(frame === 9);
      elapsed = next.elapsed;
    }
    expect(elapsed).toBe(0);
  });

  it("does not emit early or move the accumulator on zero delta", () => {
    expect(advanceCadence(0, 0)).toEqual({ elapsed: 0, due: false });
    expect(advanceCadence(0.099, 0)).toEqual({ elapsed: 0.099, due: false });
    expect(advanceCadence(0.1, 0)).toEqual({ elapsed: 0, due: true });
  });

  it.each([NaN, Infinity, -Infinity, -1, -0.01])("sanitizes invalid/negative delta %s without losing valid accumulated time", (delta) => {
    expect(advanceCadence(0.04, delta)).toEqual({ elapsed: 0.04, due: false });
  });

  it.each([NaN, Infinity, -Infinity, -1, -0.01])("sanitizes invalid/negative elapsed %s and still counts the current frame", (elapsed) => {
    expect(advanceCadence(elapsed, 0.04)).toEqual({ elapsed: 0.04, due: false });
  });

  it("sanitizes both inputs and negative zero", () => {
    expect(advanceCadence(NaN, Infinity)).toEqual({ elapsed: 0, due: false });
    expect(advanceCadence(-0, -0)).toEqual({ elapsed: 0, due: false });
  });

  it.each([0.1, 0.5, 30, Number.MAX_VALUE])("emits at most once for a long %s-second frame and discards its remainder", (delta) => {
    const due = advanceCadence(0.04, delta);
    expect(due).toEqual({ elapsed: 0, due: true });
    expect(advanceCadence(due.elapsed, 0)).toEqual({ elapsed: 0, due: false });
    expect(advanceCadence(due.elapsed, 0.04)).toEqual({ elapsed: 0.04, due: false });
  });

  it("handles overflow of finite inputs without retaining infinity", () => {
    expect(advanceCadence(Number.MAX_VALUE, Number.MAX_VALUE)).toEqual({ elapsed: 0, due: true });
  });

  it("continues promptly across a frame-loop clock reset instead of waiting for old uptime", () => {
    let elapsed = advanceCadence(0, 0.06).elapsed;
    // R3F can reset its total elapsedTime to zero when demand/always changes. A zero
    // transition delta must preserve our local cadence; the next normal frame finishes it.
    elapsed = advanceCadence(elapsed, 0).elapsed;
    expect(advanceCadence(elapsed, 0.04)).toEqual({ elapsed: 0, due: true });
    // A negative discontinuity is also harmless rather than delaying later updates.
    elapsed = advanceCadence(0.06, -60).elapsed;
    expect(advanceCadence(elapsed, 0.04)).toEqual({ elapsed: 0, due: true });
  });
});
