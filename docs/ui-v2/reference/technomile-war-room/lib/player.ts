/**
 * Replay player for a recorded event list. It paces envelopes by their recorded offsets, delivers
 * them in batches on a fixed tick (~10 Hz, REQ-UI-02), and supports pause, speed and seek.
 *
 * Time is measured as a delta of an injectable `now()`, never by counting ticks, so a throttled
 * background tab catches up correctly instead of drifting.
 */
import type { RunEventEnvelope } from "@/lib/contracts/run-events";

export interface Scheduler {
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  now: () => number;
}

export interface PlayerOptions {
  events: readonly RunEventEnvelope[];
  offsets: readonly number[];
  /** Receives every envelope due since the previous tick, in order. */
  onBatch: (batch: RunEventEnvelope[], cursor: number) => void;
  /** Called on every tick while playing, after any batch, with the position reached. */
  onTick?: (positionMs: number, cursor: number) => void;
  onEnd?: () => void;
  /**
   * Where the timeline ends, when it runs on past its last event (a run that waited at a gate after its last
   * event). Never shorter than the last offset.
   */
  durationMs?: number;
  tickMs?: number;
  scheduler?: Scheduler;
}

export interface Player {
  play(): void;
  pause(): void;
  /** Jump so that exactly `count` envelopes have been delivered; returns them for a rebuild. */
  seek(count: number): RunEventEnvelope[];
  /** Jump to a position on the timeline; every envelope due by then counts as delivered and is returned. */
  seekTo(positionMs: number): RunEventEnvelope[];
  setSpeed(speed: number): void;
  readonly cursor: number;
  /** Number of recorded envelopes. */
  readonly total: number;
  readonly playing: boolean;
  readonly speed: number;
  readonly durationMs: number;
  /** Recorded time position of the cursor, in ms from the first event. */
  readonly positionMs: number;
  dispose(): void;
}

export const DEFAULT_TICK_MS = 100;
export const SPEEDS = [1, 2, 4, 8] as const;
/** Speeds of a full-run replay (a live run's record, minutes long). */
export const RUN_SPEEDS = [1, 2, 4, 8, 16] as const;

const browserScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (h) => clearInterval(h),
  now: () => Date.now(),
};

export function createPlayer(options: PlayerOptions): Player {
  const { events, offsets, onBatch, onTick, onEnd, tickMs = DEFAULT_TICK_MS, scheduler = browserScheduler } = options;
  if (offsets.length !== events.length) throw new Error("offsets and events differ in length");
  let cursor = 0;
  let playing = false;
  let speed = 1;
  let handle: number | null = null;
  // Recorded-time origin: position = basePosition + (now - baseWall) * speed.
  let basePosition = 0;
  let baseWall = 0;

  const lastOffset = offsets.length > 0 ? (offsets[offsets.length - 1] ?? 0) : 0;
  const durationMs = Math.max(lastOffset, options.durationMs ?? 0);
  const position = () => (playing ? basePosition + (scheduler.now() - baseWall) * speed : basePosition);

  const stopTimer = () => {
    if (handle !== null) {
      scheduler.clearInterval(handle);
      handle = null;
    }
  };

  const tick = () => {
    const pos = position();
    const batch: RunEventEnvelope[] = [];
    while (cursor < events.length && (offsets[cursor] ?? Infinity) <= pos) {
      const env = events[cursor];
      if (env) batch.push(env);
      cursor += 1;
    }
    if (batch.length > 0) onBatch(batch, cursor);
    const ended = cursor >= events.length && pos >= durationMs;
    if (ended) {
      basePosition = durationMs;
      playing = false;
      stopTimer();
    }
    onTick?.(Math.min(durationMs, pos), cursor);
    if (ended) onEnd?.();
  };

  /** The number of envelopes due at `pos`: the prefix up to the first one that is not (delivery is in order). */
  const dueAt = (pos: number) => {
    let n = 0;
    while (n < events.length && (offsets[n] ?? Infinity) <= pos) n += 1;
    return n;
  };

  return {
    play() {
      if (playing) return;
      if (cursor >= events.length && basePosition >= durationMs) {
        cursor = 0;
        basePosition = 0;
      }
      playing = true;
      baseWall = scheduler.now();
      handle = scheduler.setInterval(tick, tickMs);
    },
    pause() {
      if (!playing) return;
      basePosition = Math.min(durationMs, position());
      playing = false;
      stopTimer();
      // deliver what is due at the paused position, so a paused player has applied everything up to it (as a seek
      // to the same position would)
      const batch: RunEventEnvelope[] = [];
      while (cursor < events.length && (offsets[cursor] ?? Infinity) <= basePosition) {
        const env = events[cursor];
        if (env) batch.push(env);
        cursor += 1;
      }
      if (batch.length > 0) onBatch(batch, cursor);
    },
    seek(count) {
      const target = Math.max(0, Math.min(events.length, Math.floor(count)));
      cursor = target;
      basePosition = target === 0 ? 0 : (offsets[target - 1] ?? 0);
      baseWall = scheduler.now();
      return events.slice(0, target);
    },
    seekTo(positionMs) {
      const pos = Number.isFinite(positionMs) ? Math.max(0, Math.min(durationMs, positionMs)) : 0;
      cursor = dueAt(pos);
      basePosition = pos;
      baseWall = scheduler.now();
      return events.slice(0, cursor);
    },
    setSpeed(next) {
      if (!Number.isFinite(next) || next <= 0) return;
      basePosition = position();
      baseWall = scheduler.now();
      speed = next;
    },
    get cursor() {
      return cursor;
    },
    get total() {
      return events.length;
    },
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get durationMs() {
      return durationMs;
    },
    get positionMs() {
      return Math.min(durationMs, position());
    },
    dispose() {
      playing = false;
      stopTimer();
    },
  };
}
