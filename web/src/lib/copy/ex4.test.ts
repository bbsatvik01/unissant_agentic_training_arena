import { describe, expect, it } from "vitest";

import { EX4_TEXT } from "./ex4";

describe("EX4_TEXT", () => {
  it("is the sponsor's ground rule, verbatim (REQUIREMENTS EX-4, slide 8)", () => {
    expect(EX4_TEXT).toBe(
      "All cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person.",
    );
  });

  it("holds the flag-adjacent sentence the room shows beside flags (S6 8)", () => {
    expect(EX4_TEXT).toContain("Evasive wording alone does not prove a violation");
  });
});
