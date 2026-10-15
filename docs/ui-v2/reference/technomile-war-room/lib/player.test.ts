import { describe, expect, it } from "vitest";

import type { RunEventEnvelope } from "@/lib/contracts/run-events";

import { createPlayer, type Scheduler } from "./player";

function fakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number; due: number }>();
  const s: Scheduler & { advance: (ms: number) => void; active: () => number } = {
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
  return s;
}

const events: RunEventEnvelope[] = [0, 50, 250, 1000].map((_, i) => ({
  seq: i + 1,
  runId: "r",
  idemKey: `k${i + 1}`,
  ts: "2026-09-25T13:00:00Z",
  event: { type: "STEP_STARTED", stepName: "S4" },
}));
const offsets = [0, 50, 250, 1000];

describe("createPlayer", () => {
  it("delivers due events in ~100 ms batches and ends", () => {
    const sched = fakeScheduler();
    const batches: number[][] = [];
    let ended = 0;
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: (b) => batches.push(b.map((e) => e.seq)), onEnd: () => (ended += 1) });
    expect(p.durationMs).toBe(1000);
    expect(p.total).toBe(4);
    p.play();
    expect(p.playing).toBe(true);
    sched.advance(100);
    expect(batches).toEqual([[1, 2]]);
    sched.advance(200);
    expect(batches).toEqual([[1, 2], [3]]);
    sched.advance(800);
    expect(batches).toEqual([[1, 2], [3], [4]]);
    expect(ended).toBe(1);
    expect(p.playing).toBe(false);
    expect(sched.active()).toBe(0);
    expect(p.positionMs).toBe(1000);
  });

  it("pauses, changes speed and resumes from the same recorded position", () => {
    const sched = fakeScheduler();
    const seen: number[] = [];
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: (b) => seen.push(...b.map((e) => e.seq)) });
    p.play();
    p.play();
    sched.advance(100);
    p.pause();
    p.pause();
    const pos = p.positionMs;
    sched.advance(5000);
    expect(p.positionMs).toBe(pos);
    expect(seen).toEqual([1, 2]);
    p.setSpeed(4);
    p.setSpeed(-1);
    p.setSpeed(Number.NaN);
    expect(p.speed).toBe(4);
    p.play();
    sched.advance(100);
    expect(seen).toEqual([1, 2, 3]);
    sched.advance(200);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("changes speed while playing without jumping", () => {
    const sched = fakeScheduler();
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: () => undefined });
    p.play();
    sched.advance(100);
    p.setSpeed(2);
    expect(p.positionMs).toBe(100);
    sched.advance(100);
    expect(p.positionMs).toBe(300);
    p.dispose();
    expect(p.playing).toBe(false);
  });

  it("seeks and returns the prefix to rebuild state, clamping the target", () => {
    const sched = fakeScheduler();
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: () => undefined });
    expect(p.seek(2).map((e) => e.seq)).toEqual([1, 2]);
    expect(p.cursor).toBe(2);
    expect(p.positionMs).toBe(50);
    expect(p.seek(99)).toHaveLength(4);
    expect(p.seek(-3)).toHaveLength(0);
    expect(p.positionMs).toBe(0);
  });

  it("delivers what is due when paused between ticks, as a seek to the same position would", () => {
    const sched = fakeScheduler();
    const seen: number[] = [];
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: (b) => seen.push(...b.map((e) => e.seq)) });
    p.play();
    sched.advance(75);
    expect(seen).toEqual([]);
    p.pause();
    expect(seen).toEqual([1, 2]);
    expect(p.cursor).toBe(2);
    expect(p.positionMs).toBe(75);
  });

  it("restarts from the beginning when played after the end", () => {
    const sched = fakeScheduler();
    const seen: number[] = [];
    const p = createPlayer({ events, offsets, scheduler: sched, onBatch: (b) => seen.push(...b.map((e) => e.seq)) });
    p.seek(4);
    p.play();
    sched.advance(100);
    expect(seen).toEqual([1, 2]);
  });

  it("refuses mismatched offsets and handles an empty list", () => {
    expect(() => createPlayer({ events, offsets: [0], onBatch: () => undefined })).toThrow("differ in length");
    const p = createPlayer({ events: [], offsets: [], onBatch: () => undefined, scheduler: fakeScheduler() });
    expect(p.durationMs).toBe(0);
  });

  it("uses the global timers by default", () => {
    const p = createPlayer({ events, offsets, onBatch: () => undefined });
    p.play();
    expect(p.playing).toBe(true);
    p.dispose();
  });

  it("plays on past the last event to the timeline's end, ticking every 100 ms", () => {
    const sched = fakeScheduler();
    const ticks: [number, number][] = [];
    let ended = 0;
    const p = createPlayer({
      events,
      offsets,
      durationMs: 1500,
      scheduler: sched,
      onBatch: () => undefined,
      onTick: (pos, cursor) => ticks.push([pos, cursor]),
      onEnd: () => (ended += 1),
    });
    expect(p.durationMs).toBe(1500);
    p.play();
    sched.advance(1000);
    expect(ticks.at(-1)).toEqual([1000, 4]);
    expect(p.playing).toBe(true);
    expect(ended).toBe(0);
    sched.advance(500);
    expect(ticks.at(-1)).toEqual([1500, 4]);
    expect(ticks).toHaveLength(15);
    expect(ended).toBe(1);
    expect(p.playing).toBe(false);
    expect(p.positionMs).toBe(1500);
    // a shorter durationMs never cuts the record
    expect(createPlayer({ events, offsets, durationMs: 10, onBatch: () => undefined, scheduler: fakeScheduler() }).durationMs).toBe(1000);
  });

  it("seeks to a time: every envelope due by then is delivered, the position is the time asked", () => {
    const sched = fakeScheduler();
    const seen: number[] = [];
    const p = createPlayer({ events, offsets, durationMs: 2000, scheduler: sched, onBatch: (b) => seen.push(...b.map((e) => e.seq)) });
    expect(p.seekTo(260).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(p.cursor).toBe(3);
    expect(p.positionMs).toBe(260);
    expect(p.seekTo(1700)).toHaveLength(4);
    expect(p.positionMs).toBe(1700);
    // the start of the timeline: an event recorded at offset 0 is already due
    expect(p.seekTo(-5).map((e) => e.seq)).toEqual([1]);
    expect(p.positionMs).toBe(0);
    expect(p.seekTo(99_999)).toHaveLength(4);
    expect(p.positionMs).toBe(2000);
    expect(p.seekTo(Number.NaN)).toHaveLength(1);
    // paused in the tail after the last event: play resumes there, it does not restart
    p.seekTo(1200);
    p.play();
    sched.advance(100);
    expect(p.positionMs).toBe(1300);
    expect(seen).toEqual([]);
    p.pause();
    expect(p.seekTo(950)).toHaveLength(3);
    p.play();
    sched.advance(100);
    expect(seen).toEqual([4]);
  });

  it("pauses at most at the end of the timeline", () => {
    const sched = fakeScheduler();
    const p = createPlayer({ events: [], offsets: [], durationMs: 300, scheduler: sched, tickMs: 1000, onBatch: () => undefined });
    p.play();
    sched.advance(500);
    p.pause();
    expect(p.positionMs).toBe(300);
  });
});
