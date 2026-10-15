/** Live input/crowd integration only. Never use this to advance capture or recorded clip time. */
export const MAX_LIVE_NAVIGATION_SECONDS = 0.25;
export const MAX_LIVE_NAVIGATION_STEP_SECONDS = 0.05;
export const MAX_LIVE_NAVIGATION_STEPS = 5;

export interface LiveNavigationFrame {
  readonly steps: number;
  readonly stepSeconds: number;
  readonly elapsedSeconds: number;
  readonly droppedSeconds: number;
}

/** No accumulator: resumed/stalled time beyond 250 ms is dropped, not repaid in future frames. */
export function liveNavigationFrame(delta: number): LiveNavigationFrame {
  const safe = Number.isFinite(delta) ? Math.max(0, delta) : 0;
  const elapsedSeconds = Math.min(MAX_LIVE_NAVIGATION_SECONDS, safe);
  const steps = Math.min(MAX_LIVE_NAVIGATION_STEPS, Math.ceil(elapsedSeconds / MAX_LIVE_NAVIGATION_STEP_SECONDS));
  return { steps, stepSeconds: steps === 0 ? 0 : elapsedSeconds / steps, elapsedSeconds,
    droppedSeconds: safe - elapsedSeconds };
}
