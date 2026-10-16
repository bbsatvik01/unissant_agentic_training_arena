// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { visibleRecordedDebrief } from "../../lib/precinct/session";
import { usePlayback } from "./usePlayback";

const callbacks = new Map<number, FrameRequestCallback>();
let nextId = 0;
let now = 0;
beforeEach(() => {
  callbacks.clear(); nextId = 0; now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { const id = ++nextId; callbacks.set(id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function tick(time: number) { act(() => { now = time; const all = [...callbacks.values()]; callbacks.clear(); all.forEach((fn) => { fn(time); }); }); }
const options = { subjectName: "Subject", reducedMotion: true, paused: false };

describe("actual publication arrival on the canonical replay clock", () => {
  it("withholds debrief/final snapshot until publication and removes them immediately on rewind", () => {
    const end = raw.events.at(-1)?.at_ms ?? 0;
    const parsed = parseRecording({ ...raw, format: "arena.recording.v2", world_events: [], published_at_ms: end + 10_000 });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const recording = parsed.recording;
    const { result } = renderHook(() => usePlayback(recording, options));
    act(() => { result.current.seekTo(end + 9_999); });
    expect(result.current.trial.view?.status).toBe("ended");
    expect(result.current.world?.debriefReady).toBe(false);
    expect(visibleRecordedDebrief(recording, result.current.trial.view, result.current.world)).toBeNull();
    act(() => { result.current.seekTo(end + 10_000); });
    expect(visibleRecordedDebrief(recording, result.current.trial.view, result.current.world)).toEqual(recording.debrief);
    act(() => { result.current.seekTo(end + 1); });
    expect(visibleRecordedDebrief(recording, result.current.trial.view, result.current.world)).toBeNull();
    act(() => { result.current.setSpeed(2); result.current.play(); });
    tick(2_000); expect(result.current.world?.debriefReady).toBe(false);
    act(() => { result.current.pause(); }); tick(50_000); expect(result.current.world?.debriefReady).toBe(false);
    act(() => { result.current.play(); }); tick(53_000); expect(result.current.world?.debriefReady).toBe(true);
    expect(result.current.duration).toBe(end + 13_000);
  });
  it("leaves legacy v1/v2 publication semantics untouched", () => {
    const parsed = parseRecording(raw); if (!parsed.ok) throw new Error("fixture refused");
    const { result } = renderHook(() => usePlayback(parsed.recording, options));
    act(() => { result.current.seekTo(Infinity); });
    expect(visibleRecordedDebrief(parsed.recording, result.current.trial.view, result.current.world)).toEqual(parsed.recording.debrief);
  });
});
