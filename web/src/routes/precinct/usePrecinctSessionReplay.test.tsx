// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { createLocalWorldCapture } from "../../lib/world/localWorldCapture";
import { parseRecording } from "../../lib/world/parseRecording";
import { MAX_RECORDING_FILE_BYTES } from "../../lib/world/recordingFiles";
import { usePrecinctSession } from "./usePrecinctSession";
const options = { reducedMotion: true, paused: false, audioInRoom: false };
const transport = vi.fn();
beforeEach(() => { transport.mockReset(); vi.stubGlobal("fetch", transport); vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn()); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function fileWith(text: () => Promise<string>, size = 0): File {
  const file = new File([], "recording.json", { type: "application/json" });
  Object.defineProperties(file, { text: { value: text }, size: { value: size } }); return file;
}
function localRecording() {
  const checked = parseRecording(raw); if (!checked.ok) throw new Error("fixture");
  let now = 10;
  const capture = createLocalWorldCapture({ packet: checked.recording.case, isActive: () => true, now: () => now, newId: () => "route-test" });
  capture.controller.start();
  now = 25; capture.advanceClock(); capture.controller.input({ action: "notebook", operation: "upsert", note_id: "n", text: "Explicit local note" });
  capture.controller.stop(); const result = capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; ")); return result.recording;
}
describe("canonical session replay extensions", () => {
  it("installs an explicit new local capture through the existing cursor without historical outcome or audio", () => {
    const { result } = renderHook(() => usePrecinctSession(options)); const recording = localRecording();
    act(() => { result.current.loadCaptureRecording(recording); });
    expect(result.current.recordingTrialId).toBe("local-world:route-test"); expect(result.current.recording?.events).toEqual([]);
    expect(result.current.clock.current).toBe(0); expect(result.current.playback.playing).toBe(false); expect(result.current.debrief).toBeNull();
    expect(result.current.view?.turns).toEqual([]); expect(result.current.sound).toBe(false);
    act(() => { result.current.playback.seekTo(15); }); expect(result.current.playback.capturedWorld.notes.get("n")?.text).toBe("Explicit local note");
    act(() => { result.current.playback.seekTo(0); }); expect(result.current.playback.capturedWorld.notes.size).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects declared oversized files before reading and retains the previous validated recording", async () => {
    const { result } = renderHook(() => usePrecinctSession(options)); act(() => { result.current.loadCaptureRecording(localRecording()); });
    const text = vi.fn(() => Promise.resolve("{}"));
    await act(async () => { await result.current.importRecording(fileWith(text, MAX_RECORDING_FILE_BYTES + 1)); });
    expect(text).not.toHaveBeenCalled(); expect(result.current.recordingError).toContain("32 MB"); expect(result.current.recordingTrialId).toBe("local-world:route-test");
    await act(async () => { await result.current.importRecording(fileWith(() => Promise.resolve(JSON.stringify({ ...raw, format: "arena.recording.v2", world_events: [{ t_ms: 0, kind: "microphone", data: {} }] })))); });
    expect(result.current.recordingState).toBe("error"); expect(result.current.recordingTrialId).toBe("local-world:route-test"); expect(transport).not.toHaveBeenCalled();
  });
  it("enforces actual UTF-8 size and malformed JSON bounds in the merged import path", async () => {
    const { result } = renderHook(() => usePrecinctSession(options)); act(() => { result.current.loadCaptureRecording(localRecording()); });
    const text = vi.fn(() => Promise.resolve("é".repeat(Math.floor(MAX_RECORDING_FILE_BYTES / 2) + 1)));
    await act(async () => { await result.current.importRecording(fileWith(text, 0)); });
    expect(text).toHaveBeenCalledOnce(); expect(result.current.recordingError).toContain("32 MB");
    expect(result.current.recordingTrialId).toBe("local-world:route-test");
    await act(async () => { await result.current.importRecording(fileWith(() => Promise.resolve("{malformed"))); });
    expect(result.current.recordingError).toContain("valid JSON"); expect(result.current.recordingTrialId).toBe("local-world:route-test");
    expect(transport).not.toHaveBeenCalled();
  });
  it("guards every direct replacement entry while assessment playback remains usable", async () => {
    const { result } = renderHook(() => usePrecinctSession(options));
    const assessment = { ...localRecording(), trial_id: "assessment-recording", snapshot: { ...localRecording().snapshot, mode: "assessment" as const } };
    act(() => { result.current.loadCaptureRecording(assessment); }); expect(result.current.assessmentActive).toBe(true);
    const text = vi.fn(() => Promise.resolve(JSON.stringify(raw)));
    await act(async () => { await result.current.importRecording(fileWith(text)); await result.current.loadBundledRecording(); await result.current.loadCoachedRecording(); await result.current.loadLocalRecording("other"); });
    act(() => { result.current.loadCaptureRecording(localRecording()); });
    expect(text).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    expect(result.current.recordingTrialId).toBe("assessment-recording"); expect(result.current.recordingError).toContain("Close the assessment view");
    act(() => { result.current.playback.seekTo(15); }); expect(result.current.clock.current).toBe(15);
    expect(result.current.playback.capturedWorld.notes.get("n")?.text).toBe("Explicit local note");
    act(() => { result.current.stopSession(); }); expect(result.current.assessmentActive).toBe(false);
    await act(async () => { await result.current.importRecording(fileWith(text)); });
    expect(text).toHaveBeenCalledOnce(); expect(result.current.recordingTrialId).toBe(raw.trial_id);
  });
  it("ignores an older malformed upload after the latest valid file wins", async () => {
    let resolve: (value: string) => void = () => undefined;
    const { result } = renderHook(() => usePrecinctSession(options)); let prior = Promise.resolve();
    act(() => { prior = result.current.importRecording(fileWith(() => new Promise<string>((done) => { resolve = done; }))); });
    await act(async () => { await result.current.importRecording(fileWith(() => Promise.resolve(JSON.stringify(raw)))); });
    await act(async () => { resolve("{broken"); await prior; });
    expect(result.current.recordingState).toBe("ready"); expect(result.current.recordingError).toBeNull(); expect(result.current.recordingTrialId).toBe(raw.trial_id);
  });
  it("makes the explicit capture install supersede a slow earlier file read", async () => {
    let resolve: (value: string) => void = () => undefined;
    const { result } = renderHook(() => usePrecinctSession(options)); let pending = Promise.resolve();
    act(() => { pending = result.current.importRecording(fileWith(() => new Promise<string>((done) => { resolve = done; }))); });
    act(() => { result.current.loadCaptureRecording(localRecording()); });
    await act(async () => { resolve(JSON.stringify(raw)); await pending; });
    expect(result.current.recordingTrialId).toBe("local-world:route-test"); expect(result.current.recordingState).toBe("ready"); expect(result.current.debrief).toBeNull();
  });
});
