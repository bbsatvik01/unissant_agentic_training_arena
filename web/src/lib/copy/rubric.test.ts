import { describe, expect, it } from "vitest";

import spec from "../../../../docs/spec/S3-scoring-rubrics-metrics.md?raw";
import { anchorFor, checkName, RUBRIC } from "./rubric";

describe("the bundled rubric", () => {
  it("copies every check name and anchor verbatim from S3 section 2", () => {
    for (const dim of Object.values(RUBRIC)) {
      for (const [id, name] of Object.entries(dim.checks)) expect(spec).toContain(`| ${id} ${name} |`);
      for (const [score, text] of Object.entries(dim.anchors)) expect(spec).toContain(`| ${score} | ${text} |`);
    }
  });

  it("finds anchors and check names", () => {
    expect(anchorFor("D1", 4)).toContain("single neutral ask");
    expect(anchorFor("D9", 2)).toBe(null);
    expect(anchorFor("D1", 5)).toBe(null);
    expect(checkName("3e")).toBe("Raises contradictions");
    expect(checkName("9z")).toBe("9z");
  });
});
