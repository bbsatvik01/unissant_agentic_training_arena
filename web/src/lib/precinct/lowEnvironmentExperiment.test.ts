// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lowEnvironmentExperimentRequested, precinctEnvironmentEnabled, precinctQualityDescription } from "./lowEnvironmentExperiment";

describe("explicit Low environment experiment", () => {
  it("requires both diagnostics and the exact omission switch", () => {
    for (const query of ["", "?precinctPerf=1", "?precinctLowEnvironment=omit", "?precinctPerf=0&precinctLowEnvironment=omit", "?precinctPerf=1&precinctLowEnvironment=retain"]) {
      expect(lowEnvironmentExperimentRequested(query)).toBe(false);
    }
    expect(lowEnvironmentExperimentRequested("?precinctPerf=1&precinctLowEnvironment=omit")).toBe(true);
    expect(lowEnvironmentExperimentRequested()).toBe(false);
  });
  it("leaves default, Balanced, High and canonical capture/replay lighting enabled", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      expect(precinctEnvironmentEnabled(tier, false, false)).toBe(true);
      expect(precinctEnvironmentEnabled(tier, true, true)).toBe(true);
      expect(precinctEnvironmentEnabled(tier, true, false)).toBe(tier !== "low");
    }
  });
  it("discloses the visual tradeoff and unverified benefit only for the opt-in experiment", () => {
    expect(precinctQualityDescription("")).toBe("Rendering can step down automatically for smoother movement");
    expect(precinctQualityDescription("?precinctPerf=1&precinctLowEnvironment=omit")).toContain("flatter lighting and reduced reflections");
    expect(precinctQualityDescription("?precinctPerf=1&precinctLowEnvironment=omit")).toContain("Performance benefit is unverified");
  });
});
