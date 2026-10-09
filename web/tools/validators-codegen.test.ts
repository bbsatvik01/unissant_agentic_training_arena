/** The committed compiled validators equal a fresh generation from the committed schemas (no drift). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WIRE_SCHEMAS } from "../src/lib/contracts/generated/schemas.ts";
import { exportName, generateValidators } from "./validators-codegen.ts";

const dir = new URL("../src/lib/contracts/generated/", import.meta.url);

describe("compiled wire validators (S6 1.3: no run-time code generation)", () => {
  it("are exactly what the generator makes from the committed schemas", () => {
    const fresh = generateValidators();
    expect(readFileSync(new URL("validators.js", dir), "utf8")).toBe(fresh.js);
    expect(readFileSync(new URL("validators.d.ts", dir), "utf8")).toBe(fresh.dts);
  });

  it("cover every wire schema and load no module at run time", () => {
    const { js } = generateValidators();
    for (const stem of Object.keys(WIRE_SCHEMAS)) expect(js).toContain(`${JSON.stringify(stem)}: ${exportName(stem)},`);
    expect(js).not.toContain("require(");
    expect(js).not.toMatch(/new Function|\beval\(/);
  });

  it("refuses stems that collide on one export name", () => {
    expect(() => generateValidators({ "a-b": { type: "object" }, a_b: { type: "object" } })).toThrow(/one export name/);
  });
});
