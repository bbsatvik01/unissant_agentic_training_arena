import { describe, expect, it } from "vitest";
import { inputMovement, MAX_FRAME_SECONDS, WALK_SPEED } from "./movement";

describe("documented single collision-step timing contract", () => {
  it("matches wall-clock walking at 20, 30, 60 and 120 Hz", () => {
    for (const fps of [20, 30, 60, 120]) {
      let distance = 0;
      for (let frame = 0; frame < fps; frame += 1) distance += Math.abs(inputMovement(1, 0, 0, false, 1 / fps)[2]);
      expect(distance).toBeCloseTo(WALK_SPEED, 10);
    }
  });
  it("keeps the 50 ms helper bound; live Controls must substep longer elapsed time", () => {
    for (const fps of [5, 10]) {
      let distance = 0;
      for (let frame = 0; frame < fps; frame += 1) distance += Math.abs(inputMovement(1, 0, 0, false, 1 / fps)[2]);
      expect(distance).toBeCloseTo(WALK_SPEED * MAX_FRAME_SECONDS * fps, 10);
      expect(distance).toBeLessThan(WALK_SPEED);
    }
  });
});
