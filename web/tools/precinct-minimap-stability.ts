/** Acceptance-only public DOM observation. Never imported by production UI. */
import { parseMinimapPosition } from "./precinct-capture-position.ts";

export type MinimapReading = { transform: string | null; elapsedMs: number; scheduledMs: number; inWindow: boolean };
export type MinimapObservation = {
  readings: MinimapReading[]; durationMs: number; intervalMs: number;
  dispatchDelayMs: number | null; completedElapsedMs: number | null;
  starved: boolean; error: string | null;
};
export type MinimapSamplerClock = {
  now: () => number;
  read: () => string | null;
  after: (delayMs: number, callback: () => void) => () => void;
};

/** Self-contained for page.evaluate serialization. The optional clock is unit-test-only.
 * The host supplies its original epoch-relative monotonic start, so evaluation dispatch
 * cannot reset the 1500ms budget. Both processes must share the same system clock.
 * Only getAttribute is read; no app globals, state, callbacks, observers or input.
 */
export function collectMinimapStability(options: {
  startedEpochMs: number; durationMs: number; intervalMs: number;
}, clock?: MinimapSamplerClock): Promise<MinimapObservation> {
  const env = clock ?? {
    now: () => performance.timeOrigin + performance.now(),
    read: () => {
      const matches = document.querySelectorAll(".precinct-minimap g");
      if (matches.length !== 1) throw new Error(`Expected exactly one public minimap marker; found ${String(matches.length)}.`);
      return matches[0]?.getAttribute("transform") ?? null;
    },
    after: (delayMs: number, callback: () => void) => {
      const timer = globalThis.setTimeout(callback, delayMs);
      return () => { globalThis.clearTimeout(timer); };
    },
  };
  return new Promise((resolve) => {
    const result: MinimapObservation = { readings: [], durationMs: options.durationMs, intervalMs: options.intervalMs,
      dispatchDelayMs: null, completedElapsedMs: null, starved: false, error: null };
    let cancel: (() => void) | null = null, done = false, scheduledMs = 0, previousMs = -Infinity;
    const finish = (error: string | null) => {
      if (done) return;
      done = true; result.error = error;
      if (cancel !== null) {
        try { cancel(); }
        catch (failure) { result.error = `${error ?? "Sampler cleanup failed"}: ${failure instanceof Error ? failure.message : String(failure)}`; }
        cancel = null;
      }
      resolve(result);
    };
    const tick = () => {
      if (done) return;
      try {
        const beforeReadMs = env.now() - options.startedEpochMs;
        if (!Number.isFinite(beforeReadMs) || beforeReadMs < 0 || beforeReadMs < previousMs) throw new Error("Sampler clock is nonfinite, precedes the host start, or moved backwards.");
        result.dispatchDelayMs ??= beforeReadMs;
        const transform = env.read(), elapsedMs = env.now() - options.startedEpochMs;
        if (!Number.isFinite(elapsedMs) || elapsedMs < beforeReadMs) throw new Error("Sampler clock changed during its read.");
        previousMs = elapsedMs; result.completedElapsedMs = elapsedMs;
        // Missing a whole additional 150ms interval is starvation. Never catch up
        // with synthetic/rapid duplicate samples after a delayed timer callback.
        if (elapsedMs - scheduledMs >= options.intervalMs) result.starved = true;
        result.readings.push({ transform, elapsedMs, scheduledMs, inWindow: elapsedMs < options.durationMs });
        if (elapsedMs >= options.durationMs) { finish(null); return; }
        scheduledMs = Math.min(options.durationMs, elapsedMs + options.intervalMs);
        cancel = env.after(scheduledMs - elapsedMs, tick);
      } catch (failure) { finish(failure instanceof Error ? failure.message : String(failure)); }
    };
    if (!Number.isFinite(options.startedEpochMs) || options.durationMs !== 1500 || options.intervalMs !== 150) {
      finish("Sampler requires the unchanged finite host start, 1500ms window and 150ms cadence."); return;
    }
    tick();
  });
}

/** Pure fail-closed evidence; late observations remain diagnostic and never count. */
export function minimapStabilityEvidence(observation: MinimapObservation, origin: { x: number; z: number }) {
  const samples: { x: number; z: number; elapsedMs: number }[] = [], lateSamples: typeof samples = [], errors: string[] = [];
  let maxDisplacement = 0, previousMs = -Infinity;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.z)) errors.push("Nonfinite stability origin.");
  if (observation.error !== null) errors.push(observation.error);
  if (observation.durationMs !== 1500 || observation.intervalMs !== 150) errors.push("Stability timing contract changed.");
  for (const reading of observation.readings) {
    if (!Number.isFinite(reading.elapsedMs) || reading.elapsedMs < 0 || reading.elapsedMs < previousMs || reading.inWindow !== (reading.elapsedMs < 1500)) {
      errors.push("Invalid or inconsistent sample timing."); continue;
    }
    previousMs = reading.elapsedMs;
    try {
      const actual = parseMinimapPosition(reading.transform), sample = { ...actual, elapsedMs: reading.elapsedMs };
      (reading.inWindow ? samples : lateSamples).push(sample);
      maxDisplacement = Math.max(maxDisplacement, Math.hypot(actual.x - origin.x, actual.z - origin.z));
    } catch (failure) { errors.push(failure instanceof Error ? failure.message : String(failure)); }
  }
  const completed = observation.completedElapsedMs !== null && Number.isFinite(observation.completedElapsedMs) && observation.completedElapsedMs >= 1500;
  return { samples, lateSamples, errors, maxDisplacement, completed,
    passed: completed && !observation.starved && errors.length === 0 && samples.length >= 3 && maxDisplacement <= 0.035 };
}
