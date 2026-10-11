import { describe, expect, it } from "vitest";

import cases from "../../fixtures/cases.json";
import { AVATARS, COACHES, seeded, seedOf, subjectPersona } from "./cast";

describe("the cast", () => {
  it("gives every practice subject a distinct persona and avatar", () => {
    const personas = cases.cases.map((c) => subjectPersona(c.subject.display_name));
    expect(new Set(personas.map((p) => p.avatar)).size).toBe(cases.cases.length);
    expect(new Set(personas.map((p) => p.voice.timbre)).size).toBe(cases.cases.length);
  });

  it("falls back to a persona for an unknown subject", () => {
    expect(subjectPersona("Nobody Known").avatar).toBe(subjectPersona("Jordan Pell").avatar);
  });

  it("seats three distinct coaches, one per desk", () => {
    expect(COACHES.map((c) => c.desk)).toEqual(["question", "flags", "follow_up"]);
    expect(new Set(COACHES.map((c) => c.avatar)).size).toBe(3);
    expect(AVATARS).toHaveLength(10);
  });

  it("carries no role, style or content field in a persona (PRB-4)", () => {
    for (const p of [...cases.cases.map((c) => subjectPersona(c.subject.display_name)), ...COACHES]) {
      expect(Object.keys(p)).not.toEqual(expect.arrayContaining(["role"]));
      expect(JSON.stringify(p)).not.toMatch(/truthful|deceptive|nervous|stress|anxious/i);
    }
  });

  it("draws a reproducible sequence per name", () => {
    const a = seeded(seedOf("Jordan Pell"));
    const b = seeded(seedOf("Jordan Pell"));
    const c = seeded(seedOf("Mara Quell"));
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(c()).not.toBe(first[0]);
    for (const v of first) expect(v >= 0 && v < 1).toBe(true);
  });
});
