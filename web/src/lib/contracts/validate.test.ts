import { describe, expect, it } from "vitest";

import { NEUTRALITY_ISSUES, QUESTION_TYPES } from "./card";
import { WIRE_SCHEMAS } from "./generated/schemas";
import { isWire, wireErrors, wireSchemaNames, type WireSchemaName } from "./validate";

interface WireCase {
  readonly id: string;
  readonly schema: WireSchemaName;
  readonly value: unknown;
  readonly why?: string;
}

/** The shared wire fixtures (S6 12), read through Vite; the Python tests run the same file. */
const files = import.meta.glob<unknown>("../../../../contracts/fixtures/wire.json", { eager: true, import: "default" });

function fixture(): { readonly valid: readonly WireCase[]; readonly invalid: readonly WireCase[] } {
  const parsed = Object.values(files)[0] as { valid: readonly WireCase[]; invalid: readonly WireCase[] } | undefined;
  if (parsed === undefined) throw new Error("contracts/fixtures/wire.json not found");
  return parsed;
}

describe("wire fixtures against the exported schemas, through ajv (S6 12)", () => {
  const { valid, invalid } = fixture();

  it("compiles every wire schema and no stored or model-facing schema", () => {
    expect(new Set(wireSchemaNames())).toEqual(new Set(valid.map((c) => c.schema)));
    expect(wireSchemaNames()).not.toContain("stored-card");
    expect(wireSchemaNames()).not.toContain("card.v1");
  });

  it.each(valid.map((c) => [c.id, c] as const))("accepts %s", (_id, c) => {
    expect(wireErrors(c.schema, c.value)).toEqual([]);
    expect(isWire(c.schema, c.value)).toBe(true);
  });

  it.each(invalid.map((c) => [`${c.id}: ${c.why ?? ""}`, c] as const))("rejects %s", (_id, c) => {
    expect(isWire(c.schema, c.value)).toBe(false);
    expect(wireErrors(c.schema, c.value).length).toBeGreaterThan(0);
  });

  it("refuses an unknown schema name", () => {
    expect(() => isWire("no-such-schema" as WireSchemaName, {})).toThrow(/no wire schema/);
  });
});

describe("the hand-kept card constants match the exported card schema", () => {
  const defs = (WIRE_SCHEMAS["training-card"] as { $defs: Record<string, { properties: Record<string, unknown> }> })
    .$defs;
  const question = defs["Question"]?.properties as {
    question_type: { enum: readonly string[] };
    neutrality_issues: { items: { enum: readonly string[] } };
  };

  it("lists every question type and neutrality issue in schema order", () => {
    expect([...QUESTION_TYPES]).toEqual(question.question_type.enum);
    expect([...NEUTRALITY_ISSUES]).toEqual(question.neutrality_issues.items.enum);
  });
});
