import { describe, expect, it } from "vitest";
import { benchmarkOptions, evaluateRenderBudget, steadyStateOutcome } from "./precinct-performance";
import { PrecinctFrameMeasurements } from "../src/lib/precinct/renderMeasurements";
import { PRECINCT_RENDER_BUDGET } from "../src/lib/precinct/renderQuality";
import type { PrecinctPerformanceReport } from "../src/components/precinct/precinctPerformanceTypes";

function report(): PrecinctPerformanceReport {
  const measurements = new PrecinctFrameMeasurements(); measurements.start(0);
  for (let frame = 1; frame <= 3600; frame += 1) measurements.frame({ time: frame * 1000 / 60, cpuSubmissionMs: 5, calls: 100,
    triangles: 300_000, pixels: 2_025_000, dpr: 1.25, tier: "medium", continuous: true, visible: true });
  measurements.stop(60_000);
  return { ...measurements.report(60_000), schema: "arena.precinct-render-performance.v1", production: true, sceneAsset: "/world/precinct.glb",
    renderer: { renderer: "Test renderer", vendor: "Test", unmaskedAvailable: true, softwareRenderer: false, contextLost: false,
      webglVersion: "WebGL 2", shadowsEnabled: false, geometries: 50, textures: 10, programs: 8, actualGpuMemoryBytes: null,
      userAgent: "test", deviceDpr: 2, hardwareConcurrency: 8 },
    scene: { meshes: 80, uncullableMeshes: 30, shadowCastingMeshes: 0, uniqueMaterials: 50, transparentMaterials: 2,
      materialTextures: 10, unknownTextureDimensions: 0, textureDimensions: [], materialTextureRgba8MiBEstimate: 30, textureEstimateCaveat: "Estimate" },
    budgets: PRECINCT_RENDER_BUDGET, observers: { event: false, longtask: false }, measurementNotes: [] };
}
describe("production render benchmark", () => {
  it("defaults to a bounded hardware benchmark and pins only diagnostic quality", () => {
    const options = benchmarkOptions([]);
    expect(options.seconds).toBe(60); expect(options.warmup).toBe(15); expect(options.software).toBe(false); expect(options.readinessDiagnostics).toBe(false); expect(options.slowStartDiagnostic).toBe(false);
    expect(benchmarkOptions(["--readiness-diagnostics"]).readinessDiagnostics).toBe(true);
    expect(benchmarkOptions(["--slow-start-diagnostic"]).slowStartDiagnostic).toBe(true);
    expect(options.url.searchParams.get("precinctPerf")).toBe("1"); expect(options.url.searchParams.get("precinctPerfPinned")).toBe("1");
    const adaptive = benchmarkOptions(["--tier=adaptive", "--software", "--headed", "--scene=courtyard", "--camera=first", "--seconds=300", "--viewport=1728x1117"]);
    expect(adaptive.url.searchParams.has("precinctPerfPinned")).toBe(false); expect(adaptive.scene).toBe("courtyard"); expect(adaptive.headed).toBe(true);
  });
  it("refuses remote, credentialed, too-short, ambiguous or malformed runs", () => {
    for (const args of [["--url=https://example.org"], ["--url=http://user:password@localhost/"], ["--url=http://localhost/?token=x"], ["--url=http://localhost/#x"],
      ["--seconds=5"], ["--seconds=NaN"], ["--seconds=601"], ["--tier=ultra"], ["--camera=free"], ["--scene=outside"], ["--unknown"],
      ["--tier=high", "--tier=low"], ["--software=false"], ["--readiness-diagnostics=false"], ["--slow-start-diagnostic=false"], ["--slow-start-diagnostic", "--readiness-diagnostics"], ["wat"], ["--viewport=1x1"], ["--viewport=9999x9999"], ["--dpr=8"]]) expect(() => benchmarkOptions(args)).toThrow();
  });
  it("retains a failed cold gate and nonzero exit after an independently completed steady sample", () => {
    expect(steadyStateOutcome(false)).toEqual({ status: "steady-state-completed-cold-start-failed", exitCode: 1 });
    expect(steadyStateOutcome(true)).toEqual({ status: "completed", exitCode: 0 });
    expect(evaluateRenderBudget(report(), 60).complete).toBe(true);
  });
  it("accepts only real complete frame-pacing evidence and never implies target hardware", () => {
    const good = report(); expect(evaluateRenderBudget(good, 60)).toMatchObject({ complete: true, timingPassed: true });
    expect(evaluateRenderBudget(good, 60).targetHardwareAcceptance).toContain("Not inferred");
    expect(evaluateRenderBudget({ ...good, renderer: { ...good.renderer, softwareRenderer: true } }, 60).result).toContain("diagnostic only");
    for (const bad of [{ ...good, production: false }, { ...good, durationMs: 59_999 }, { ...good, demandFrames: 1 },
      { ...good, visibilityInterruptions: 1 }, { ...good, hiddenFrames: 1 }, { ...good, renderer: { ...good.renderer, contextLost: true } },
      { ...good, frameIntervalMs: { ...good.frameIntervalMs, dropped: 1 } }]) expect(evaluateRenderBudget(bad, 60).complete).toBe(false);
    expect(evaluateRenderBudget({ ...good, averageRenderedFps: 45 }, 60).timingPassed).toBe(false);
    expect(evaluateRenderBudget({ ...good, frameIntervalMs: { ...good.frameIntervalMs, p95: 30 } }, 60).timingPassed).toBe(false);
  });
});
