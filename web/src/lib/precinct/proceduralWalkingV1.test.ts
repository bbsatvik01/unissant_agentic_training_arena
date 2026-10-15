import { describe, expect, it } from "vitest";
import { advanceWalkingV1, sampleWalkingV1 } from "./proceduralWalkingV1";
describe("one-clock versioned walking body", () => {
  it("uses actual distance, finite speed-selected cycles, and no independent breathing clock", () => {
    const start = { cycle: "idle", time: 0 } as const;
    const walk = advanceWalkingV1(start, { distance: 0.21, speed: 2.1 }, 0.1, false);
    expect(walk.cycle).toBe("walk");
    expect(walk.time).toBeCloseTo(0.1, 14);
    const run = advanceWalkingV1(walk, { distance: 0.42, speed: 4.2 }, 0.1, false);
    expect(run.cycle).toBe("run");
    const collision = advanceWalkingV1(run, { distance: 0, speed: 4.2 }, 0.1, false);
    expect(collision).toEqual({ cycle: "idle", time: 0.05 });
    expect(advanceWalkingV1(collision, { distance: 0, speed: 0 }, 10, false).time).toBe(0.1);
    expect(advanceWalkingV1(walk, { distance: 0.4, speed: 4 }, 10, true)).toEqual({ cycle: "still", time: 0 });
    expect(sampleWalkingV1("still", 999)).toEqual(sampleWalkingV1("still", 0));
    expect(sampleWalkingV1("idle", 2).spine).not.toBe(sampleWalkingV1("idle", 1).spine);
    expect(sampleWalkingV1("walk", 2).leftHip).not.toBe(sampleWalkingV1("run", 2).leftHip);
  });
  it("preserves traveled phase when switching walk/run and never catches up paused wall time", () => {
    const previous = { cycle: "run", time: 0.3 } as const;
    const next = advanceWalkingV1(previous, { distance: 0.02, speed: 1 }, 100, false);
    expect(next.time * 2.1 / 2.115).toBeCloseTo(previous.time * 4.2 / 2.43 + 0.02 / 2.115);
    for (const value of [NaN, Infinity, -1]) {
      expect(advanceWalkingV1({ cycle: "idle", time: value }, { distance: value, speed: value }, value, false)).toEqual({ cycle: "idle", time: 0 });
      expect(Object.values(sampleWalkingV1("walk", value)).every(Number.isFinite)).toBe(true);
    }
    expect(advanceWalkingV1({ cycle: "walk", time: NaN }, { distance: 0.1, speed: 0.001 }, 0, false).cycle).toBe("idle");
  });
});
