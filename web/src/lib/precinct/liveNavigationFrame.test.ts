import { describe, expect, it } from "vitest";
import { inputMovement, turn, WALK_SPEED } from "./movement";
import { liveNavigationFrame } from "./liveNavigationFrame";

describe("bounded live navigation integration", () => {
  it("covers elapsed time at 5–120 Hz with at most five <=50 ms steps", () => {
    for (const hz of [5, 10, 20, 30, 60, 120]) {
      const frame = liveNavigationFrame(1 / hz);
      expect(frame.steps).toBeGreaterThan(0); expect(frame.steps).toBeLessThanOrEqual(5);
      expect(frame.stepSeconds).toBeLessThanOrEqual(0.05); expect(frame.stepSeconds * frame.steps).toBeCloseTo(1 / hz, 12);
      expect(frame.droppedSeconds).toBe(0);
      let distance = 0, look = { yaw: 0, pitch: 0 };
      for (let i = 0; i < hz; i += 1) for (let step = 0; step < frame.steps; step += 1) {
        distance += Math.abs(inputMovement(1, 0, 0, false, frame.stepSeconds)[2]);
        look = turn(look, frame.stepSeconds * 1.7, frame.stepSeconds * 0.5);
      }
      expect(distance).toBeCloseTo(WALK_SPEED, 10); expect(look.yaw).toBeCloseTo(1.7, 10); expect(look.pitch).toBeCloseTo(0.5, 10);
    }
  });
  it("caps a stall at 250 ms and creates no future backlog", () => {
    expect(liveNavigationFrame(0.5)).toEqual({ steps: 5, stepSeconds: 0.05, elapsedSeconds: 0.25, droppedSeconds: 0.25 });
    expect(liveNavigationFrame(10).droppedSeconds).toBe(9.75);
    expect(liveNavigationFrame(0.01)).toEqual({ steps: 1, stepSeconds: 0.01, elapsedSeconds: 0.01, droppedSeconds: 0 });
    for (const value of [0, -1, NaN, Infinity]) expect(liveNavigationFrame(value)).toEqual({ steps: 0, stepSeconds: 0, elapsedSeconds: 0, droppedSeconds: 0 });
  });
});
