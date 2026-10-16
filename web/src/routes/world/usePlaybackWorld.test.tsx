// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor, type Recording } from "../../lib/world/recording";
import type { WorldEvent } from "../../lib/world/worldEvents";
import { usePlayback } from "./usePlayback";

const samples: WorldEvent[] = [
  { t_ms: 0, kind: "camera", data: { mode: "first", position: [0, 1.7, 0], quaternion: [0, 0, 0, 1], fov: 60 } },
  { t_ms: 100, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "Check source" } },
  { t_ms: 200, kind: "input", data: { action: "notebook", operation: "delete", note_id: "n" } },
  { t_ms: 300, kind: "pose", data: { actor_id: "subject", position: [1, 0, 1], rotation: [0, 0, 0, 1], animation: { clip: "listen", time: 0.3 } } },
];
function load(world = true): Recording {
  const parsed = parseRecording(world ? { ...raw, format: "arena.recording.v2", world_events: samples } : raw);
  if (!parsed.ok) throw new Error("fixture"); return parsed.recording;
}
let nextId = 0;
const callbacks = new Map<number, FrameRequestCallback>();
let now = 0;
beforeEach(() => {
  now = 0; nextId = 0; callbacks.clear(); vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: FrameRequestCallback) => { nextId += 1; callbacks.set(nextId, fn); return nextId; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { callbacks.delete(id); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function frame(time: number) { act(() => { now = time; const queued = [...callbacks.values()]; callbacks.clear(); for (const fn of queued) fn(time); }); }
const options = { subjectName: "Subject", reducedMotion: false, paused: false };

describe("canonical captured-world playback", () => {
  it("starts at exactly zero, restores notes on backward seek, and shares the existing arrival clock", () => {
    const recording = load(); const { result } = renderHook(() => usePlayback(recording, options));
    expect(result.current.capturedWorld.camera?.mode).toBe("first"); expect(result.current.clock.current).toBe(0);
    act(() => { result.current.seekTo(recording.durationMs); }); expect(result.current.capturedWorld.notes.size).toBe(0);
    act(() => { result.current.seekTo(100); }); expect(result.current.capturedWorld.notes.get("n")?.text).toBe("Check source");
    const expected = seek(recording, startCursor(recording), 100);
    expect(result.current.arrivals).toEqual(expected.arrivals); expect(result.current.trial).toEqual(expected.state);
    expect(result.current.clock.current).toBe(100); expect(result.current.capturedWorld).toEqual(expected.world);
    act(() => { result.current.seekTo(0); }); expect(result.current.capturedWorld.notes.size).toBe(0);
  });
  it("uses one clock for sampled animation, speed, pause and seek with no synthetic animation advance", () => {
    const recording = load(); const { result } = renderHook(() => usePlayback(recording, options));
    act(() => { result.current.play(); }); frame(100); expect(result.current.clock.current).toBe(100);
    act(() => { result.current.setSpeed(2); }); frame(200); expect(result.current.clock.current).toBe(300);
    expect(result.current.capturedWorld.actors.get("subject")?.animation.time).toBe(0.3);
    frame(300); expect(result.current.clock.current).toBe(500); expect(result.current.capturedWorld.actors.get("subject")?.animation.time).toBe(0.3);
    act(() => { result.current.pause(); }); frame(400); expect(result.current.clock.current).toBe(500);
    act(() => { result.current.seekTo(100); }); expect(result.current.clock.current).toBe(100);
    act(() => { result.current.play(); }); frame(500); expect(result.current.clock.current).toBe(300);
  });
  it("stops for global pause, refuses Play while paused, and does not autoplay on unpause", () => {
    const recording = load(); const { result, rerender } = renderHook((paused: boolean) => usePlayback(recording, { ...options, paused }), { initialProps: false });
    act(() => { result.current.play(); }); frame(100); rerender(true); expect(result.current.playing).toBe(false);
    act(() => { result.current.play(); }); frame(200); expect(result.current.clock.current).toBe(100);
    rerender(false); frame(300); expect(result.current.playing).toBe(false); expect(result.current.clock.current).toBe(100);
  });
  it("resets clock and captured samples on replacement and preserves v1 compatibility", () => {
    const { result, rerender } = renderHook<ReturnType<typeof usePlayback>, Recording | null>((recording) => usePlayback(recording, options), { initialProps: load() });
    act(() => { result.current.seekTo(300); result.current.play(); });
    rerender(load(false)); expect(result.current.clock.current).toBe(0); expect(result.current.capturedWorld.actors.size).toBe(0);
    expect(result.current.playing).toBe(false); expect(result.current.capturedWorld.camera).toBeNull();
    rerender(null); expect(result.current.clock.current).toBe(0); expect(result.current.duration).toBe(0); expect(result.current.arrivals.size).toBe(0);
    act(() => { result.current.play(); result.current.seekTo(100); }); expect(result.current.playing).toBe(false);
  });
  it("clamps terminal replay, rewinds on Play, and ignores malformed speed and backward wall-clock deltas", () => {
    const recording = load(); const { result } = renderHook(() => usePlayback(recording, options));
    act(() => { result.current.play(); }); frame(-5); expect(result.current.clock.current).toBe(0);
    act(() => { result.current.setSpeed(0 as never); }); expect(result.current.speed).toBe(1);
    frame(NaN); expect(result.current.clock.current).toBe(0); frame(10); expect(result.current.clock.current).toBe(0);
    frame(recording.durationMs + 100); expect(result.current.clock.current).toBe(recording.durationMs); expect(result.current.playing).toBe(false);
    act(() => { result.current.play(); }); expect(result.current.clock.current).toBe(0); expect(result.current.capturedWorld.camera?.mode).toBe("first");
    act(() => { result.current.seekTo(NaN); }); expect(result.current.clock.current).toBe(0);
  });
});
