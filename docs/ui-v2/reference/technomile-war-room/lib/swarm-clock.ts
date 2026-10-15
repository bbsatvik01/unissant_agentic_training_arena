/**
 * The graph's own replay clock, for a finished run when no run-level replay drives the page: recorded time moves at
 * 1-16x of wall time while it plays, and stops at the window's ends. Pure and immutable; `wall` is injected.
 */
export const GRAPH_SPEEDS = [1, 2, 4, 8, 16] as const;

export interface LocalClock {
  /** Recorded time at wall time `at`. */
  base: number;
  at: number;
  speed: number;
  playing: boolean;
  min: number;
  max: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function localClock(min: number, max: number, at: number): LocalClock {
  return { base: min, at, speed: 1, playing: false, min, max };
}

/** Recorded time at wall time `wall`. */
export function localNow(c: LocalClock, wall: number): number {
  return c.playing ? clamp(c.base + (wall - c.at) * c.speed, c.min, c.max) : c.base;
}

/** Plays from where it is (from the start if it had reached the end). */
export function play(c: LocalClock, wall: number): LocalClock {
  const now = localNow(c, wall);
  return { ...c, base: now >= c.max ? c.min : now, at: wall, playing: true };
}

export function pause(c: LocalClock, wall: number): LocalClock {
  return { ...c, base: localNow(c, wall), at: wall, playing: false };
}

export function setSpeed(c: LocalClock, speed: number, wall: number): LocalClock {
  return { ...c, base: localNow(c, wall), at: wall, speed: speed > 0 ? speed : 1 };
}

export function seek(c: LocalClock, ts: number, wall: number): LocalClock {
  return { ...c, base: clamp(ts, c.min, c.max), at: wall };
}

/** The next speed in the cycle (1, 2, 4, 8, 16, then 1). */
export function nextSpeed(speed: number): number {
  const i = GRAPH_SPEEDS.indexOf(speed as (typeof GRAPH_SPEEDS)[number]);
  return GRAPH_SPEEDS[(i + 1) % GRAPH_SPEEDS.length] ?? 1;
}

/** Whether a playing clock has reached its end at `wall`. */
export function ended(c: LocalClock, wall: number): boolean {
  return localNow(c, wall) >= c.max;
}
