import { describe, expect, it } from "vitest";

import cases from "../../fixtures/cases.json";
import { AVATARS, COACHES, HUB_CREW, HUB_STAFF, INVESTIGATOR, seeded, seedOf, subjectPersona } from "./cast";

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

  it("gives every speaking persona its own voice catalogue key; the background staff keep distinct prebuilt voices", () => {
    // The server's catalogue (packages/core/src/arena_core/voice/personas.json) holds each key; a Python test reads
    // this file and checks that every key here is in it.
    const names = ["Jordan Pell", "Mara Quell", "Avery Lindqvist", "Dana Okafor", "Rafael Strand", "Priya Halloran", "Glen Mattick", "Sami Varga", "Elise Dunmore"];
    for (const n of names) expect(subjectPersona(n).voice.gemini).toBe(`subject:${n}`);
    expect(COACHES.map((c) => c.voice.gemini)).toEqual(["coach:question", "coach:flags", "coach:follow_up"]);
    expect(INVESTIGATOR.voice.gemini).toBe("investigator");
    const prebuilt = new Set(["Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi"]);
    const staff = [HUB_STAFF, ...HUB_CREW].map((p) => p.voice.gemini);
    for (const v of staff) expect(prebuilt.has(v)).toBe(true);
    expect(new Set(staff).size).toBe(staff.length);
  });
});
