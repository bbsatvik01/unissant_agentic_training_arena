import { describe, expect, it } from "vitest";
import { parseMinimapPosition } from "./precinct-capture-position";

describe("actual minimap capture position", () => {
  it.each([
    ["translate(0 16.3) rotate(0)", { x: 0, z: 16.3 }],
    ["translate(-1.4695761589768238e-16 16.3) rotate(-360)", { x: -1.4695761589768238e-16, z: 16.3 }],
    ["translate(+.5 -2.4E+1) rotate(1e-8)", { x: 0.5, z: -24 }],
  ])("retains finite SVG coordinates in %s", (transform, expected) => { expect(parseMinimapPosition(transform)).toEqual(expected); });
  it.each([null, "", "translate(NaN 1) rotate(0)", "translate(0 Infinity) rotate(0)", "translate(0 1) rotate(NaN)",
    "translate(1e999 2) rotate(0)", "translate(0x10 2) rotate(0)", "translate(0 1)", "translate(0 1) rotate(0) extra"])("fails closed on %s", (transform) => { expect(() => parseMinimapPosition(transform)).toThrow(); });
});
