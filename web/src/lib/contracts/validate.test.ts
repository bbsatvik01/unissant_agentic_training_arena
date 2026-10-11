import { describe, expect, it } from "vitest";

import { parseTrialFrame } from "../sse/trial-stream";
import { NEUTRALITY_ISSUES, QUESTION_TYPES } from "./card";
import { WIRE_SCHEMAS } from "./generated/schemas";
import { invariantErrors, isWire, wireBytes, wireErrors, wireSchemaNames, type WireSchemaName } from "./validate";

interface WireCase {
  readonly id: string;
  readonly schema: WireSchemaName;
  readonly value: unknown;
  readonly why?: string;
  readonly layer?: "schema" | "invariant";
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
    expect(invariantErrors(c.schema, c.value)).toEqual([]);
    expect(isWire(c.schema, c.value)).toBe(true);
  });

  it.each(invalid.map((c) => [`${c.id}: ${c.why ?? ""}`, c] as const))("rejects %s", (_id, c) => {
    expect(isWire(c.schema, c.value)).toBe(false);
    if (c.layer === "invariant") {
      expect(wireErrors(c.schema, c.value)).toEqual([]);
      expect(invariantErrors(c.schema, c.value).length).toBeGreaterThan(0);
    } else {
      expect(wireErrors(c.schema, c.value).length).toBeGreaterThan(0);
    }
  });

  it("has negative fixtures in both layers", () => {
    expect(new Set(invalid.map((c) => c.layer))).toEqual(new Set(["schema", "invariant"]));
  });

  it("passes every valid trial frame through the stream's own envelope parser unchanged", () => {
    const frames = valid.filter((c) => c.schema === "events");
    expect(frames.length).toBeGreaterThanOrEqual(13);
    for (const c of frames) {
      const value = c.value as { scope_id: string };
      const parsed = parseTrialFrame(JSON.stringify(c.value), value.scope_id);
      expect(typeof parsed, c.id).toBe("object");
      expect(parsed, c.id).toEqual(c.value);
      expect(isWire("events", parsed), c.id).toBe(true);
    }
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

describe("maxBytes counts wire bytes, as the server does (D-019)", () => {
  // The same table as packages/core/tests/contracts/test_common.py::test_wire_bytes_count_the_json_escapes.
  const cases: readonly (readonly [string, number])[] = [
    ["a", 1],
    ['"', 2],
    ["\\", 2],
    ["\n", 2],
    ["\t", 2],
    ["\u0001", 6],
    ["\u007f", 6],
    ["\u00e9", 6],
    ["\u20ac", 6],
    ["\u{1f600}", 12],
    ['ab\u20ac"', 10],
  ];

  it.each(cases)("%j is %i wire bytes", (text, bytes) => {
    expect(wireBytes(text)).toBe(bytes);
  });

  it("the compiled maxBytes keyword accepts a field at its wire cap and refuses one byte more", () => {
    const { valid } = fixture();
    const sample = valid.find((c) => c.schema === "training-card" && hasFinding(c.value));
    if (sample === undefined) throw new Error("no training-card fixture with a finding");
    const card = structuredClone(sample.value) as { finding: { rationale: string } };
    card.finding.rationale = "\u20ac".repeat(200); // 1,200 wire bytes: the cap
    expect(wireErrors("training-card", card)).toEqual([]);
    card.finding.rationale += "a";
    expect(wireErrors("training-card", card).map((e) => e.keyword)).toContain("maxBytes");
  });
});

function hasFinding(value: unknown): boolean {
  return typeof value === "object" && value !== null && "finding" in value && value.finding !== null;
}
