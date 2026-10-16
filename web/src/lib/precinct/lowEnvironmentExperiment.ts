import type { Tier } from "../world/quality";

/** Temporary, explicit diagnostics only. Never persisted or inferred from the renderer. */
export function lowEnvironmentExperimentRequested(search = typeof window === "undefined" ? "" : window.location.search): boolean {
  const query = new URLSearchParams(search);
  return query.get("precinctPerf") === "1" && query.get("precinctLowEnvironment") === "omit";
}

export function precinctEnvironmentEnabled(tier: Tier, requested: boolean, canonicalCaptureOrReplay: boolean): boolean {
  return !requested || tier !== "low" || canonicalCaptureOrReplay;
}

export function precinctQualityDescription(search?: string): string {
  return lowEnvironmentExperimentRequested(search)
    ? "Experiment: Low uses flatter lighting and reduced reflections. Balanced, High, live sessions, capture and replay keep standard lighting. Performance benefit is unverified."
    : "Rendering can step down automatically for smoother movement";
}
