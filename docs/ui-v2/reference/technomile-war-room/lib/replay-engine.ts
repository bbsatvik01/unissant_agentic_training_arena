/**
 * The replay transport: a player (lib/war-room/player.ts) over a run's timeline, paced on the playback map, with
 * the War Room store kept as of the cursor. Framework-free, so the transport, its keyboard map and its pacing are
 * tested on an injected clock; React subscribes through `subscribe` / `getState`.
 *
 * Seeking anywhere rebuilds the store from the run's base view and the envelopes up to the cursor (`player.seekTo`
 * returns that prefix); playing folds each batch on. The recorded clock (`r`) is always the run's own time; the
 * playback map only changes how long a span takes to play.
 */
import { createPlayer, DEFAULT_TICK_MS, type Player, type Scheduler } from "./player";
import { advance, jumpFrom, playbackMap, replayStart, type PlaybackMap, type ReplayCursor, type Timeline } from "./replay";

export interface ReplayState {
  /** Envelopes delivered. */
  k: number;
  /** Recorded time at the cursor (ms since epoch). */
  r: number;
  /** Playback position (ms from the start, at 1x). */
  p: number;
  playing: boolean;
  speed: number;
  includeWaits: boolean;
  /** The cursor is at the end of the record. */
  ended: boolean;
  cursor: ReplayCursor;
  /** The playback map in use (it changes when gate waits are included or collapsed). */
  map: PlaybackMap;
}

export interface ReplayEngine {
  readonly timeline: Timeline;
  /** The current playback map (it changes when gate waits are included or collapsed). */
  readonly map: PlaybackMap;
  getState(): ReplayState;
  subscribe(listener: () => void): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Move to a recorded time (clamped to the record). */
  seek(r: number): void;
  seekBy(deltaMs: number): void;
  /** The previous or next stage or gate. */
  jump(dir: 1 | -1): void;
  setSpeed(speed: number): void;
  setIncludeWaits(on: boolean): void;
  /** Recorded time now, between ticks too (for animation frames). */
  recordedNow(): number;
  /** Playback position now (ms at 1x), between ticks too. */
  playbackNow(): number;
  dispose(): void;
}

export interface ReplayEngineOptions {
  /** Where to start (recorded ms since epoch); the run's start by default. */
  at?: number;
  speed?: number;
  includeWaits?: boolean;
  gateMs?: number;
  tickMs?: number;
  scheduler?: Scheduler;
}

export function createReplayEngine(tl: Timeline, opts: ReplayEngineOptions = {}): ReplayEngine {
  const listeners = new Set<() => void>();
  let includeWaits = opts.includeWaits ?? false;
  let speed = opts.speed && Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
  let map = playbackMap(tl, opts.gateMs === undefined ? { includeWaits } : { includeWaits, gateMs: opts.gateMs });
  let cursor = replayStart(tl);
  let state: ReplayState;
  let disposed = false;

  const clamp = (r: number) => (Number.isFinite(r) ? Math.min(tl.end, Math.max(tl.t0, r)) : tl.t0);

  /** Publish the state at playback position `p`; a seek passes the recorded time it asked for (`exact`). */
  const emit = (p: number, exact?: number) => {
    const r = exact ?? map.toRecorded(p);
    cursor = advance(cursor, tl, player.cursor, r);
    state = { k: cursor.k, r, p, playing: player.playing, speed, includeWaits, ended: p >= map.duration && cursor.k >= tl.envs.length, cursor, map };
    for (const l of listeners) l();
  };

  const make = (m: PlaybackMap): Player =>
    createPlayer({
      events: tl.envs,
      offsets: tl.times.map((t) => m.toPlay(t)),
      durationMs: m.duration,
      tickMs: opts.tickMs ?? DEFAULT_TICK_MS,
      ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
      // the store follows the cursor on every tick (a batch, or the clock moving through a quiet stretch)
      onBatch: () => undefined,
      onTick: (pos) => emit(pos),
    });

  let player = make(map);
  player.setSpeed(speed);

  /** Rebuild the store from the start of the record up to recorded time `r`. */
  const goto = (r: number) => {
    const at = clamp(r);
    player.seekTo(map.toPlay(at));
    cursor = advance(replayStart(tl), tl, player.cursor, at);
    emit(player.positionMs, at);
  };

  goto(opts.at ?? tl.t0);

  const engine: ReplayEngine = {
    timeline: tl,
    get map() {
      return map;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    play() {
      if (disposed || player.playing) return;
      // played from the end: start over from the run's start
      if (state.ended) goto(tl.t0);
      player.play();
      emit(player.positionMs);
    },
    pause() {
      if (!player.playing) return;
      player.pause();
      emit(player.positionMs);
    },
    toggle() {
      if (player.playing) engine.pause();
      else engine.play();
    },
    seek(r) {
      if (!disposed) goto(r);
    },
    seekBy(deltaMs) {
      if (!disposed) goto(map.toRecorded(player.positionMs) + deltaMs);
    },
    jump(dir) {
      if (!disposed) goto(jumpFrom(tl, map.toRecorded(player.positionMs), dir));
    },
    setSpeed(next) {
      if (disposed || !Number.isFinite(next) || next <= 0) return;
      speed = next;
      player.setSpeed(next);
      emit(player.positionMs);
    },
    setIncludeWaits(on) {
      if (disposed || on === includeWaits) return;
      const r = map.toRecorded(player.positionMs);
      const playing = player.playing;
      player.dispose();
      includeWaits = on;
      map = playbackMap(tl, opts.gateMs === undefined ? { includeWaits } : { includeWaits, gateMs: opts.gateMs });
      player = make(map);
      player.setSpeed(speed);
      goto(r);
      if (playing) {
        player.play();
        emit(player.positionMs);
      }
    },
    recordedNow: () => map.toRecorded(player.positionMs),
    playbackNow: () => player.positionMs,
    dispose() {
      disposed = true;
      player.dispose();
      listeners.clear();
    },
  };
  return engine;
}

/* ------------------------------------------------------------------------------------------------ session */

export interface ReplaySnapshot {
  engine: ReplayEngine | null;
  state: ReplayState | null;
}

export interface ReplayRequest {
  /** Names the timeline's content: the same key keeps the running engine, a new one rebuilds it. */
  key: string;
  timeline: Timeline;
  /** Where a fresh replay starts (recorded ms since epoch); the run's start when null. */
  at: number | null;
}

/**
 * The page's replay, as an external store React subscribes to: at most one engine at a time. A timeline with new
 * content (the record grew, an approval was read) rebuilds the engine at the same moment, speed, gate-wait choice
 * and play state; `configure(null)` stops it (the record is not ready yet, or the replay was left). `autoplay` asks
 * the current engine, or the next one once the record is ready, to play; `cancelAutoplay` withdraws that request.
 */
export interface ReplaySession {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ReplaySnapshot;
  configure(next: ReplayRequest | null): void;
  autoplay(): void;
  cancelAutoplay(): void;
  dispose(): void;
}

/** How far a requested deep-link moment may sit from the one shown and still be the same moment (per 1x of speed). */
const LINK_SLACK_MS = 250;

export function createReplaySession(make: (tl: Timeline, opts: ReplayEngineOptions) => ReplayEngine = createReplayEngine): ReplaySession {
  const listeners = new Set<() => void>();
  let snap: ReplaySnapshot = { engine: null, state: null };
  let key: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let wantPlay = false;
  /** The deep-link moment last asked for: a new one moves the replay, the same one again does not. */
  let askedAt: number | null = null;

  const publish = () => {
    const engine = snap.engine;
    snap = { engine, state: engine ? engine.getState() : null };
    for (const l of listeners) l();
  };
  const stop = () => {
    unsubscribe?.();
    unsubscribe = null;
    snap.engine?.dispose();
    snap = { engine: null, state: null };
    key = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snap,
    configure(next) {
      if (next === null) {
        if (snap.engine) {
          stop();
          publish();
        }
        return;
      }
      if (snap.engine && next.key === key) {
        const at = next.at ?? null;
        if (at !== null && at !== askedAt) {
          askedAt = at;
          // the transport writes the moment it shows (to a tenth of a second, a little behind while playing): only a
          // moment away from the one shown is a new request
          const st = snap.engine.getState();
          if (Math.abs(st.r - at) > LINK_SLACK_MS * Math.max(1, st.speed)) snap.engine.seek(at);
        }
        return;
      }
      askedAt = next.at ?? null;
      const prev = snap.engine && snap.engine.timeline.runId === next.timeline.runId ? snap.engine.getState() : null;
      stop();
      const engine = make(next.timeline, prev ? { at: prev.r, speed: prev.speed, includeWaits: prev.includeWaits } : { at: next.at ?? next.timeline.t0 });
      key = next.key;
      snap = { engine, state: engine.getState() };
      unsubscribe = engine.subscribe(publish);
      if (wantPlay || prev?.playing) {
        wantPlay = false;
        engine.play();
      }
      publish();
    },
    autoplay() {
      const engine = snap.engine;
      if (!engine) {
        wantPlay = true;
        return;
      }
      engine.play();
    },
    cancelAutoplay() {
      wantPlay = false;
    },
    dispose() {
      wantPlay = false;
      stop();
      publish();
    },
  };
}
