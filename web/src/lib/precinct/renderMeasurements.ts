import { percentile } from "./renderQuality";
import type { Tier } from "../world/quality";

export interface Distribution {
  readonly samples: number;
  readonly retained: number;
  readonly dropped: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** Bounded storage; sorting happens only when explicitly requesting a report. */
export class BoundedMetric {
  private readonly values: Float64Array;
  private count = 0;
  constructor(capacity = 36_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid metric capacity.");
    this.values = new Float64Array(capacity);
  }
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.values[this.count % this.values.length] = value; this.count += 1;
  }
  reset(): void { this.count = 0; }
  report(): Distribution {
    const values = Array.from(this.values.subarray(0, Math.min(this.count, this.values.length)));
    return { samples: this.count, retained: values.length, dropped: Math.max(0, this.count - values.length),
      p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: percentile(values, 1) };
  }
}

export interface RenderFrame {
  readonly time: number;
  readonly cpuSubmissionMs: number;
  readonly calls: number;
  readonly triangles: number;
  readonly dpr: number;
  readonly pixels: number;
  readonly tier: Tier;
  readonly visible: boolean;
  readonly continuous: boolean;
}

export class PrecinctFrameMeasurements {
  readonly interval = new BoundedMetric();
  readonly cpuSubmission = new BoundedMetric();
  readonly calls = new BoundedMetric();
  readonly triangles = new BoundedMetric();
  readonly dpr = new BoundedMetric();
  readonly pixels = new BoundedMetric();
  readonly inputToRenderSubmission = new BoundedMetric(2048);
  readonly eventTimingDuration = new BoundedMetric(2048);
  readonly longTaskDuration = new BoundedMetric(2048);
  private started = 0;
  private stopped: number | null = null;
  private last: number | null = null;
  private frames = 0;
  private hiddenFrames = 0;
  private demandFrames = 0;
  private visibilityInterruptions = 0;
  private over20 = 0;
  private over33 = 0;
  private over50 = 0;
  private tiers: Record<Tier, number> = { low: 0, medium: 0, high: 0 };
  active = false;

  start(now: number): void {
    for (const metric of [this.interval, this.cpuSubmission, this.calls, this.triangles, this.dpr, this.pixels,
      this.inputToRenderSubmission, this.eventTimingDuration, this.longTaskDuration]) metric.reset();
    this.started = now; this.stopped = null; this.last = null; this.frames = 0;
    this.hiddenFrames = 0; this.demandFrames = 0; this.visibilityInterruptions = 0;
    this.over20 = 0; this.over33 = 0; this.over50 = 0; this.tiers = { low: 0, medium: 0, high: 0 };
    this.active = true;
  }
  stop(now: number): void { if (this.active) { this.stopped = now; this.active = false; } }
  visibilityChanged(): void { if (this.active) { this.visibilityInterruptions += 1; this.last = null; } }
  frame(frame: RenderFrame): void {
    if (!this.active) return;
    if (!frame.visible) { this.hiddenFrames += 1; this.last = null; return; }
    if (!frame.continuous) this.demandFrames += 1;
    if (this.last !== null) {
      const delta = frame.time - this.last;
      this.interval.add(delta);
      if (delta > 20) this.over20 += 1;
      if (delta > 1000 / 30) this.over33 += 1;
      if (delta > 50) this.over50 += 1;
    }
    this.last = frame.time; this.frames += 1; this.tiers[frame.tier] += 1;
    this.cpuSubmission.add(frame.cpuSubmissionMs); this.calls.add(frame.calls); this.triangles.add(frame.triangles);
    this.dpr.add(frame.dpr); this.pixels.add(frame.pixels);
  }
  report(now: number) {
    const durationMs = Math.max(0, (this.stopped ?? now) - this.started);
    return { durationMs, framesRendered: this.frames, averageRenderedFps: durationMs > 0 ? this.frames * 1000 / durationMs : null,
      frameIntervalMs: this.interval.report(), cpuFrameAndRenderSubmissionMs: this.cpuSubmission.report(),
      drawCalls: this.calls.report(), triangles: this.triangles.report(), dpr: this.dpr.report(), drawingBufferPixels: this.pixels.report(),
      inputToRenderSubmissionMs: this.inputToRenderSubmission.report(), eventTimingDurationMs: this.eventTimingDuration.report(),
      longTaskMs: this.longTaskDuration.report(), intervalsOver20Ms: this.over20, intervalsOver33_34Ms: this.over33, intervalsOver50Ms: this.over50,
      hiddenFrames: this.hiddenFrames, demandFrames: this.demandFrames, visibilityInterruptions: this.visibilityInterruptions,
      tierFrames: { ...this.tiers }, gpuFrameMs: null, actualInputToPhotonMs: null };
  }
}
