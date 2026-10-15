// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { createArenaApi, type ArenaApi } from "../../lib/api/arena";
import { createApiClient } from "../../lib/api/client";
import { createSessionController, type SessionController, type SessionState } from "../../lib/trial/sessionController";
import { initialTrialState, trialReducer } from "../../lib/trial/trialReducer";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor } from "../../lib/world/recording";
import { frame, snapshot } from "../../test/trial-log";
import { useLiveSession } from "./useLiveSession";
import { usePlayback, type PlaybackControls } from "./usePlayback";

vi.mock("../../lib/trial/sessionController", () => ({ createSessionController: vi.fn() }));
const parsed = parseRecording(raw);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const recording = parsed.recording;
const options = { subjectName: recording.case.subject.display_name, reducedMotion: true, paused: false };
beforeEach(() => { vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn()); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("read-only exact session arrivals", () => {
  it("exposes the playback cursor's arrival map through forward/backward scrubs and replacement", () => {
    const { result, rerender } = renderHook<PlaybackControls, typeof recording | null>((value) => usePlayback(value, options), { initialProps: recording });
    expect([...result.current.arrivals]).toEqual([...startCursor(recording).arrivals]);
    const first = recording.events[0];
    if (first === undefined) throw new Error("fixture has no events");
    act(() => { result.current.seekTo(recording.durationMs); });
    expect([...result.current.arrivals]).toEqual([...seek(recording, startCursor(recording), recording.durationMs).arrivals]);
    act(() => { result.current.seekTo(first.at_ms); });
    expect([...result.current.arrivals]).toEqual([...seek(recording, startCursor(recording), first.at_ms).arrivals]);
    act(() => { result.current.seekTo(0); });
    expect([...result.current.arrivals]).toEqual([...seek(recording, startCursor(recording), 0).arrivals]);
    rerender(null); expect(result.current.arrivals.size).toBe(0);
    rerender({ ...recording, trial_id: "another-recording" });
    expect([...result.current.arrivals]).toEqual([...startCursor(recording).arrivals]);
  });

  it("publishes the existing live tracker's exact times and clears on stop", async () => {
    const time = vi.spyOn(performance, "now").mockReturnValue(100);
    let state: SessionState = { trial: initialTrialState(), connection: "live", debrief: null, dropped: 0, error: null };
    let notify: () => void = () => undefined;
    const controller: SessionController = {
      getState: () => state,
      subscribe: (listener) => { notify = listener; return () => undefined; },
      start: () => { state = { ...state, trial: trialReducer(state.trial, { type: "snapshot", snapshot: snapshot() }) }; notify(); return Promise.resolve(); },
      submitTurn: () => Promise.resolve(), requestEvidence: () => Promise.reject(new Error("unused")), submitFinding: () => Promise.resolve(),
      requestDebrief: () => Promise.resolve(), reconnect: () => undefined, dispose: () => undefined,
    };
    vi.mocked(createSessionController).mockReturnValue(controller);
    const api: ArenaApi = { ...createArenaApi(createApiClient({ fetch: () => Promise.reject(new Error("No network in this test")) })), startSession: () => Promise.resolve({ case_id: recording.case.case_id, trial_id: "11111111-1111-4111-8111-111111111111", session_id: "22222222-2222-4222-8222-222222222222", mode: "practice" as const }) };
    const { result } = renderHook(() => useLiveSession({ ...options, caseId: recording.case.case_id, api }));
    await act(async () => { await result.current.start("practice"); });
    expect(result.current.arrivals.get("snapshot")).toBe(0);
    time.mockReturnValue(350);
    act(() => { state = { ...state, trial: trialReducer(state.trial, { type: "frame", frame: frame("question.accepted", 1, 1, { turn_no: 1, text: "What happened?", source: "investigator", channel: "text" }) }) }; notify(); });
    expect(result.current.arrivals.get("question.accepted:1")).toBe(250);
    time.mockReturnValue(600);
    act(() => { notify(); });
    expect(result.current.arrivals.get("question.accepted:1")).toBe(250);
    act(() => { result.current.stop(); });
    expect(result.current.arrivals.size).toBe(0);
  });
});
