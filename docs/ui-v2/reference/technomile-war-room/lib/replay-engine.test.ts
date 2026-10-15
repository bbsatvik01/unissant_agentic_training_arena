import { describe, expect, it } from "vitest";

import { SYNTH, T } from "./__fixtures__/replay-runs";
import type { Scheduler } from "./player";
import { advance, buildTimeline, cursorAt, replayStart, type Timeline } from "./replay";
import { createReplayEngine, createReplaySession, type ReplayEngineOptions } from "./replay-engine";

const s = (sec: number) => T + sec * 1000;

function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number; due: number }>();
  const sched: Scheduler & { advance: (ms: number) => void; active: () => number } = {
    now: () => now,
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms, due: now + ms });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        next[1].due += next[1].ms;
        next[1].fn();
      }
      now = end;
    },
    active: () => timers.size,
  };
  return sched;
}

function synth(): Timeline {
  const tl = buildTimeline(SYNTH);
  if (!tl) throw new Error("no timeline");
  return tl;
}

describe("createReplayEngine", () => {
  it("plays the run at its recorded pace and a two-hour gate wait in three seconds, the clock showing the true time", () => {
    const sched = fakeScheduler();
    const e = createReplayEngine(synth(), { scheduler: sched });
    const seen: number[] = [];
    e.subscribe(() => seen.push(e.getState().k));
    expect(e.getState()).toMatchObject({ k: 0, r: T, p: 0, playing: false, speed: 1, includeWaits: false, ended: false });
    e.play();
    expect(e.getState().playing).toBe(true);
    sched.advance(10_500);
    // the park at H1 is delivered at its recorded time
    expect(e.getState()).toMatchObject({ k: 6, r: s(10.5) });
    sched.advance(1_500);
    // half way through the collapsed wait: half of the two hours has passed on the run's clock
    expect(e.getState().r).toBe(s(3610.5));
    expect(e.getState().k).toBe(6);
    sched.advance(1_500);
    expect(e.getState().r).toBe(s(7210.5));
    // the approved firms are in the view from the approval's recorded time
    expect(e.getState().cursor.store.view?.laneOrder).toEqual(["ACME", "BETA"]);
    sched.advance(2_400);
    expect(e.getState().k).toBe(6);
    sched.advance(100);
    expect(e.getState().k).toBe(7);
    sched.advance(11_000);
    expect(e.getState()).toMatchObject({ k: 13, r: s(7281), playing: false, ended: true });
    expect(sched.active()).toBe(0);
    expect(seen.length).toBeGreaterThan(200);
    expect(e.recordedNow()).toBe(s(7281));
    expect(e.playbackNow()).toBe(27_000);
  });

  it("plays the waits in real time when they are included, and keeps the cursor when the setting changes", () => {
    const sched = fakeScheduler();
    const e = createReplayEngine(synth(), { scheduler: sched, includeWaits: true });
    expect(e.map.duration).toBe(7_281_000);
    e.play();
    sched.advance(12_000);
    expect(e.getState().r).toBe(s(12));
    e.setIncludeWaits(true);
    e.setIncludeWaits(false);
    expect(e.map.duration).toBe(27_000);
    expect(e.getState()).toMatchObject({ r: s(12), playing: true, includeWaits: false });
    // in the collapsed wait now: 1.5 s of playback covers 3600 s of the run
    sched.advance(1_500);
    expect(e.getState().r).toBeCloseTo(s(12 + (1500 * 7200) / 3000), -2);
    e.pause();
    e.setIncludeWaits(true);
    expect(e.getState().playing).toBe(false);
    expect(e.getState().includeWaits).toBe(true);
  });

  it("runs faster at a higher speed and ignores a speed that is not one", () => {
    const sched = fakeScheduler();
    const e = createReplayEngine(synth(), { scheduler: sched, speed: 16 });
    e.setSpeed(0);
    e.setSpeed(Number.NaN);
    expect(e.getState().speed).toBe(16);
    e.play();
    sched.advance(27_000 / 16 + 100);
    expect(e.getState().ended).toBe(true);
    e.setSpeed(4);
    expect(e.getState().speed).toBe(4);
    expect(createReplayEngine(synth(), { speed: -2, scheduler: sched }).getState().speed).toBe(1);
  });

  it("seeks anywhere and rebuilds exactly the store a straight play reaches (seek correctness)", () => {
    const tl = synth();
    const sched = fakeScheduler();
    const e = createReplayEngine(tl, { scheduler: sched });
    for (const r of [s(7214), s(3), s(7281), s(10.5), T, s(7212)]) {
      e.seek(r);
      const st = e.getState();
      expect(st.r).toBe(r);
      expect(st.k).toBe(cursorAt(tl, r));
      expect(st.cursor).toEqual(advance(replayStart(tl), tl, cursorAt(tl, r), r));
    }
    // clamped to the record
    e.seek(s(-10));
    expect(e.getState().r).toBe(T);
    e.seek(s(99_999));
    expect(e.getState()).toMatchObject({ r: s(7281), ended: true });
    e.seek(Number.NaN);
    expect(e.getState().r).toBe(T);
    // played from the end, it starts over
    e.seek(s(99_999));
    e.play();
    expect(e.getState()).toMatchObject({ r: T, k: 0, playing: true });
    e.play();
    sched.advance(3_000);
    expect(e.getState().k).toBe(3);
    // a seek while playing keeps playing from there
    e.seek(s(7213));
    expect(e.getState()).toMatchObject({ k: 7, playing: true });
    sched.advance(100);
    expect(e.getState()).toMatchObject({ k: 8, r: s(7213.1), playing: true });
  });

  it("applies every envelope due when paused between ticks, so a seek to the paused moment changes nothing", () => {
    const tl = synth();
    let now = 0;
    const sched = { now: () => now, setInterval: () => 1, clearInterval: () => undefined };
    const e = createReplayEngine(tl, { scheduler: sched, at: T + 2050 });
    e.play();
    now = 75;
    e.pause();
    const paused = e.getState();
    expect(paused.k).toBe(cursorAt(tl, paused.r));
    e.seek(paused.r);
    expect(e.getState().k).toBe(paused.k);
    expect(e.getState().cursor.store).toEqual(paused.cursor.store);
    e.dispose();
  });

  it("steps five seconds and jumps between stages and gates", () => {
    const e = createReplayEngine(synth(), { scheduler: fakeScheduler(), at: s(3.6) });
    e.seekBy(5_000);
    expect(e.getState().r).toBe(s(8.6));
    e.seekBy(-5_000);
    expect(e.getState().r).toBe(s(3.6));
    e.jump(1);
    expect(e.getState().r).toBe(s(10.5));
    e.jump(1);
    expect(e.getState().r).toBe(s(7210.5));
    e.jump(-1);
    expect(e.getState().r).toBe(s(10.5));
    e.jump(-1);
    expect(e.getState().r).toBe(s(3.5));
  });

  it("opens paused at a deep link's moment, toggles, and stops for good once disposed", () => {
    const sched = fakeScheduler();
    const e = createReplayEngine(synth(), { scheduler: sched, at: s(7214.5) });
    expect(e.getState()).toMatchObject({ playing: false, k: 11, r: s(7214.5) });
    let calls = 0;
    const off = e.subscribe(() => (calls += 1));
    e.toggle();
    expect(e.getState().playing).toBe(true);
    e.toggle();
    expect(e.getState().playing).toBe(false);
    e.pause();
    off();
    e.toggle();
    expect(calls).toBe(2);
    e.dispose();
    expect(sched.active()).toBe(0);
    e.play();
    e.seek(T);
    e.seekBy(1000);
    e.jump(1);
    e.setSpeed(2);
    e.setIncludeWaits(true);
    expect(e.getState()).toMatchObject({ r: s(7214.5), speed: 1, includeWaits: false });
  });

  it("uses the browser clock by default", () => {
    const e = createReplayEngine(synth(), { gateMs: 1000, tickMs: 50 });
    expect(e.map.duration).toBe(10_500 + 1000 + 10_500 + 1000);
    e.play();
    expect(e.getState().playing).toBe(true);
    e.dispose();
  });
});

describe("createReplaySession", () => {
  const make = (sched: ReturnType<typeof fakeScheduler>) => (tl: Timeline, opts: ReplayEngineOptions) => createReplayEngine(tl, { ...opts, scheduler: sched });

  it("starts a deep link paused at its moment, keeps the engine for the same record and stops on null", () => {
    const sched = fakeScheduler();
    const session = createReplaySession(make(sched));
    let notes = 0;
    const off = session.subscribe(() => (notes += 1));
    expect(session.getSnapshot()).toEqual({ engine: null, state: null });
    const tl = synth();
    session.configure({ key: "a", timeline: tl, at: s(7214.5) });
    const first = session.getSnapshot();
    expect(first.state).toMatchObject({ r: s(7214.5), playing: false });
    session.configure({ key: "a", timeline: synth(), at: null });
    expect(session.getSnapshot().engine).toBe(first.engine);
    first.engine?.seek(s(20));
    expect(session.getSnapshot().state?.r).toBe(s(20));
    session.configure(null);
    expect(session.getSnapshot()).toEqual({ engine: null, state: null });
    session.configure(null);
    expect(notes).toBeGreaterThan(2);
    off();
  });

  it("follows a new deep-link moment for the same record, and ignores the moment it already shows", () => {
    const sched = fakeScheduler();
    const session = createReplaySession(make(sched));
    const tl = synth();
    session.configure({ key: "a", timeline: tl, at: tl.t0 + 5_000 });
    const engine = session.getSnapshot().engine;
    session.configure({ key: "a", timeline: tl, at: tl.t0 + 60_000 });
    expect(session.getSnapshot().engine).toBe(engine);
    expect(session.getSnapshot().state?.r).toBe(tl.t0 + 60_000);
    // the transport wrote the moment it shows (rounded to a tenth of a second): nothing moves
    engine?.seek(tl.t0 + 61_234);
    session.configure({ key: "a", timeline: tl, at: tl.t0 + 61_200 });
    expect(session.getSnapshot().state?.r).toBe(tl.t0 + 61_234);
    session.configure(null);
  });

  it("plays when asked to before or after the record is ready", () => {
    const sched = fakeScheduler();
    const session = createReplaySession(make(sched));
    session.autoplay();
    // the record is still being read: the request waits for it
    session.configure(null);
    session.configure({ key: "a", timeline: synth(), at: null });
    expect(session.getSnapshot().state).toMatchObject({ r: T, playing: true });
    session.getSnapshot().engine?.pause();
    session.autoplay();
    expect(session.getSnapshot().state?.playing).toBe(true);
    // leaving the replay withdraws a pending request to play
    session.configure(null);
    session.autoplay();
    session.cancelAutoplay();
    session.configure({ key: "b", timeline: synth(), at: null });
    expect(session.getSnapshot().state?.playing).toBe(false);
  });

  it("rebuilds a grown record at the same moment, speed, wait choice and play state", () => {
    const sched = fakeScheduler();
    const session = createReplaySession(make(sched));
    session.configure({ key: "a", timeline: synth(), at: s(5) });
    const e = session.getSnapshot().engine;
    e?.setSpeed(4);
    e?.setIncludeWaits(true);
    e?.play();
    session.configure({ key: "b", timeline: synth(), at: null });
    const next = session.getSnapshot();
    expect(next.engine).not.toBe(e);
    expect(next.state).toMatchObject({ r: s(5), speed: 4, includeWaits: true, playing: true });
    // another run starts fresh, at its own start
    session.configure({ key: "c", timeline: { ...synth(), runId: "other" }, at: null });
    expect(session.getSnapshot().state).toMatchObject({ r: T, speed: 1, playing: false });
    session.dispose();
    expect(session.getSnapshot().engine).toBeNull();
    expect(sched.active()).toBe(0);
  });
});
