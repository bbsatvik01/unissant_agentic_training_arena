import { describe, expect, it } from "vitest";

import type { Study } from "../api/client";
import { allowedModes, nextStepText, stepLabel, studySteps } from "./study";

const at = (next: Study["next_phase"], pre: number, practice: number, post: number): Study => ({ counterbalance: "A", ended: { pre, practice, post }, next_phase: next });

describe("KPI-1 study steps (S6 3.2)", () => {
  it("labels the step the participant is on", () => {
    expect(stepLabel(at("pre", 0, 0, 0))).toBe("Pre-test 1 of 2");
    expect(stepLabel(at("pre", 1, 0, 0))).toBe("Pre-test 2 of 2");
    expect(stepLabel(at("practice", 2, 1, 0))).toBe("Practice 2 of 3");
    expect(stepLabel(at("post", 2, 3, 1))).toBe("Post-test 2 of 2");
    expect(stepLabel(at("done", 2, 3, 2))).toBe("Study complete");
  });

  it("offers assessment for tests, practice for practice steps, either outside the study or after it", () => {
    expect(allowedModes(at("pre", 0, 0, 0))).toEqual(["assessment"]);
    expect(allowedModes(at("practice", 2, 0, 0))).toEqual(["practice"]);
    expect(allowedModes(at("post", 2, 3, 0))).toEqual(["assessment"]);
    expect(allowedModes(at("done", 2, 3, 2))).toEqual(["practice", "assessment"]);
    expect(allowedModes(null)).toEqual(["practice", "assessment"]);
  });

  it("lists the seven steps with done, current and upcoming", () => {
    const steps = studySteps(at("practice", 2, 1, 0));
    expect(steps.map((s) => s.label)).toEqual(["Pre-test 1 of 2", "Pre-test 2 of 2", "Practice 1 of 3", "Practice 2 of 3", "Practice 3 of 3", "Post-test 1 of 2", "Post-test 2 of 2"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(studySteps(at("done", 2, 3, 2)).every((s) => s.state === "done")).toBe(true);
  });

  it("says what to do next without retention mechanics (FE-PRG-2)", () => {
    for (const phase of ["pre", "practice", "post", "done"] as const) {
      expect(nextStepText(at(phase, 0, 0, 0))).not.toMatch(/streak|don't lose|caught|liars/i);
    }
    expect(nextStepText(at("pre", 0, 0, 0))).toMatch(/without coaching/);
  });
});
