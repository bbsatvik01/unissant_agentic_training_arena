import { describe, expect, it } from "vitest";
import { BASELINE_MINIMAP_FRAME, BASELINE_POINTER_FLOOR, precinctAsset, precinctMinimapFrame, precinctMinimapPoint, precinctPointerFloor } from "./worldVariant";

describe("known courtyard world metadata", () => {
  const courtyard = { asset: "precinct-courtyard.glb", worldVariant: { id: "northstar-courtyard-v1" },
    walkBounds: { min: [-13.7, 0, -35.74] as const, max: [13.7, 3.45, 19.7] as const } };
  it("preserves the exact original asset and pointer floor by default", () => {
    expect(precinctAsset({})).toBe("/world/precinct.glb");
    expect(precinctPointerFloor({})).toBe(BASELINE_POINTER_FLOOR);
    expect(precinctPointerFloor({ walkBounds: courtyard.walkBounds })).toBe(BASELINE_POINTER_FLOOR);
  });
  it("requires the named variant and matching local asset", () => {
    expect(precinctAsset(courtyard)).toBe("/world/precinct-courtyard.glb");
    expect(precinctAsset({ ...courtyard, asset: "https://example.invalid/world.glb" })).toBe("/world/precinct.glb");
    expect(precinctAsset({ ...courtyard, worldVariant: { id: "unknown" } })).toBe("/world/precinct.glb");
  });
  it("covers the new courtyard without moving the original world coordinates", () => {
    const floor = precinctPointerFloor(courtyard);
    expect(floor.center[0]).toBe(0);
    expect(floor.center[1]).toBe(0.015);
    expect(floor.center[2]).toBeCloseTo(-8.02);
    expect(floor.size[0]).toBeCloseTo(27.4);
    expect(floor.size[1]).toBeCloseTo(55.44);
  });
  it("rejects invalid bounds safely", () => {
    expect(precinctPointerFloor({ ...courtyard, walkBounds: { min: [0, 0, 0], max: [NaN, 1, 10] } })).toBe(BASELINE_POINTER_FLOOR);
    expect(precinctPointerFloor({ ...courtyard, walkBounds: { min: [1, 0, 1], max: [-1, 1, -1] } })).toBe(BASELINE_POINTER_FLOOR);
  });
});

describe("courtyard minimap footprint projection", () => {
  const courtyard = { asset: "precinct-courtyard.glb", worldVariant: { id: "northstar-courtyard-v1",
    footprintBounds: { min: [-14, 0, -36] as const, max: [14, 4.2, 20] as const } } };
  it("preserves the baseline SVG frame exactly", () => {
    expect(precinctMinimapFrame({})).toBe(BASELINE_MINIMAP_FRAME);
    expect(precinctMinimapFrame({ asset: "precinct-courtyard.glb" })).toBe(BASELINE_MINIMAP_FRAME);
  });
  it("includes every annex edge and the old module in one world-coordinate frame", () => {
    const frame = precinctMinimapFrame(courtyard);
    expect(frame).toEqual({ viewBox: "-15 -37 30 58", footprint: { x: -14, y: -36, width: 28, height: 56 } });
    for (const position of [[-14, 0, -36], [14, 0, -36], [-14, 0, 20], [14, 0, 20], [0, 0, 16.3]] as const) {
      const [x, y] = precinctMinimapPoint(position);
      expect(x).toBeGreaterThanOrEqual(frame.footprint.x);
      expect(x).toBeLessThanOrEqual(frame.footprint.x + frame.footprint.width);
      expect(y).toBeGreaterThanOrEqual(frame.footprint.y);
      expect(y).toBeLessThanOrEqual(frame.footprint.y + frame.footprint.height);
    }
  });
  it("never rescales or translates existing station and player coordinates", () => {
    expect(precinctMinimapPoint([8.65, 1.41, -12.31])).toEqual([8.65, -12.31]);
    expect(precinctMinimapPoint([-6.2, 0, -5.7])).toEqual([-6.2, -5.7]);
    expect(precinctMinimapPoint([0, 1.68, 16.3])).toEqual([0, 16.3]);
  });
  it("fails safely for nonfinite and inverted footprint bounds", () => {
    expect(precinctMinimapFrame({ ...courtyard, worldVariant: { ...courtyard.worldVariant,
      footprintBounds: { min: [-14, 0, -36], max: [Infinity, 4, 20] } } })).toBe(BASELINE_MINIMAP_FRAME);
    expect(precinctMinimapFrame({ ...courtyard, worldVariant: { ...courtyard.worldVariant,
      footprintBounds: { min: [14, 0, 20], max: [-14, 4, -36] } } })).toBe(BASELINE_MINIMAP_FRAME);
  });
});
