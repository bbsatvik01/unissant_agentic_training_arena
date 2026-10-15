import { describe, expect, it } from "vitest";
import { OBSERVATION_MIRROR, observationGlassFace } from "./observationGlazing";

describe("observation glazing finish", () => {
  it("faces the interview with an opaque mirror and leaves observation-side viewing open", () => {
    expect(observationGlassFace([8.65, 1.41, -12.31])).toBe("mirror");
    expect(observationGlassFace([10.4, 1.65, -18.6])).toBe("viewing");
    expect(observationGlassFace(OBSERVATION_MIRROR.position)).toBe("mirror");
    expect(OBSERVATION_MIRROR.normal).toEqual([0, 0, 1]);
  });
  it("fits only the original viewing opening without moving walls, furniture or colliders", () => {
    expect(OBSERVATION_MIRROR.position).toEqual([8.05, 1.87, -15.981]);
    expect(OBSERVATION_MIRROR.size).toEqual([6.1, 1.78]);
    // The original pane occupies z=-16±0.0125; offset avoids coincident surfaces.
    expect(OBSERVATION_MIRROR.position[2]).toBeGreaterThan(-16 + 0.0125);
    expect(OBSERVATION_MIRROR.position[1] - OBSERVATION_MIRROR.size[1] / 2).toBeCloseTo(0.98);
    expect(OBSERVATION_MIRROR.position[1] + OBSERVATION_MIRROR.size[1] / 2).toBeCloseTo(2.76);
  });
});
