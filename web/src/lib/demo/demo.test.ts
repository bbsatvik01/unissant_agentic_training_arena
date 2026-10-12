import { describe, expect, it } from "vitest";

import { clockText, DEMO_COPY, DEMO_STEPS, DEMO_TARGET_MS, followRoom } from "./demo";

describe("judge demo steps", () => {
  it("walks precinct, interview, debrief, arena", () => {
    expect(DEMO_STEPS).toEqual(["precinct", "interview", "debrief", "arena"]);
  });

  it("moves from the interview to the debrief once the debrief is up, and only then", () => {
    expect(followRoom("interview", true)).toBe("debrief");
    expect(followRoom("interview", false)).toBe("interview");
    expect(followRoom("arena", true)).toBe("arena");
  });

  it("keeps time in m:ss against about four minutes", () => {
    expect(DEMO_TARGET_MS).toBe(240_000);
    expect(clockText(0)).toBe("0:00");
    expect(clockText(65_400)).toBe("1:05");
    expect(clockText(-5)).toBe("0:00");
  });

  it("uses none of the words the copy rules forbid", () => {
    for (const c of Object.values(DEMO_COPY)) expect(`${c.title} ${c.body} ${c.look}`).not.toMatch(/\bAI\b|\bagents?\b|interrogation|liars|caught/i);
  });
});
