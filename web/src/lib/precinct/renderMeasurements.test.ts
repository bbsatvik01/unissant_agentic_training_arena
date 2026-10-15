import { describe, expect, it } from "vitest";
import { BoundedMetric, PrecinctFrameMeasurements, type RenderFrame } from "./renderMeasurements";

const frame = (time: number, changes: Partial<RenderFrame> = {}): RenderFrame => ({ time, cpuSubmissionMs: 2, calls: 70, triangles: 250_000,
  dpr: 1.25, pixels: 2_025_000, tier: "medium", visible: true, continuous: true, ...changes });
describe("bounded render measurements", () => {
  it("does not invent samples, bounds retention, and reports dropped samples", () => {
    expect(() => new BoundedMetric(0)).toThrow("capacity");
    const metric = new BoundedMetric(3);
    expect(metric.report()).toEqual({ samples: 0, retained: 0, dropped: 0, p50: null, p95: null, p99: null, max: null });
    for (const value of [-1, Infinity, NaN, 1, 2, 3, 9]) metric.add(value);
    expect(metric.report()).toEqual({ samples: 4, retained: 3, dropped: 1, p50: 3, p95: 9, p99: 9, max: 9 });
    metric.reset(); expect(metric.report().samples).toBe(0);
  });
  it("records real intervals including long stalls and counts all rendered calls", () => {
    const sample = new PrecinctFrameMeasurements();
    sample.frame(frame(0)); expect(sample.report(0).framesRendered).toBe(0);
    sample.start(0); sample.frame(frame(10)); sample.frame(frame(30)); sample.frame(frame(90)); sample.frame(frame(130, { tier: "low" }));
    const report = sample.report(200);
    expect(report.frameIntervalMs).toMatchObject({ samples: 3, p50: 40, p95: 60, p99: 60 });
    expect(report.intervalsOver20Ms).toBe(2); expect(report.intervalsOver33_34Ms).toBe(2); expect(report.intervalsOver50Ms).toBe(1);
    expect(report.averageRenderedFps).toBe(20); expect(report.drawCalls.p50).toBe(70);
    expect(report.tierFrames).toEqual({ low: 1, medium: 3, high: 0 });
    expect(report.gpuFrameMs).toBeNull(); expect(report.actualInputToPhotonMs).toBeNull();
    sample.stop(220); sample.stop(300); sample.frame(frame(400));
    expect(sample.report(1000).durationMs).toBe(220); expect(sample.report(1000).framesRendered).toBe(4);
  });
  it("makes hidden/demand contamination explicit and resets between phases", () => {
    const sample = new PrecinctFrameMeasurements();
    sample.visibilityChanged(); sample.start(0); sample.frame(frame(10)); sample.visibilityChanged();
    sample.frame(frame(2000, { visible: false })); sample.frame(frame(2100, { continuous: false }));
    sample.inputToRenderSubmission.add(12); sample.eventTimingDuration.add(24); sample.longTaskDuration.add(65);
    const report = sample.report(2200);
    expect(report.frameIntervalMs.samples).toBe(0); expect(report.hiddenFrames).toBe(1);
    expect(report.demandFrames).toBe(1); expect(report.visibilityInterruptions).toBe(1);
    expect(report.inputToRenderSubmissionMs.p50).toBe(12); expect(report.eventTimingDurationMs.p50).toBe(24); expect(report.longTaskMs.p50).toBe(65);
    sample.start(3000); expect(sample.report(3000).averageRenderedFps).toBeNull();
    expect(sample.report(3000).inputToRenderSubmissionMs.samples).toBe(0);
    expect(sample.report(3000).visibilityInterruptions).toBe(0);
  });
});
