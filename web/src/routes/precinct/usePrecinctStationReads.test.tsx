// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { CASES, RECORDED_CASE_ID } from "../../lib/world/cases";
import { parseRecording } from "../../lib/world/parseRecording";
import { initialTrialState, trialReducer } from "../../lib/trial/trialReducer";
import * as liveHooks from "../world/useLiveSession";
import { usePrecinctSession } from "./usePrecinctSession";

const transport = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
beforeEach(() => {
  transport.mockReset(); vi.stubGlobal("fetch", transport);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  transport.mockImplementation((path) => Promise.resolve(new Response(JSON.stringify(path === "/api/me"
    ? { user_id: "station-test-user", display_name: "Local trainee", roles: ["trainee"], csrf_token: "test-token", ex4_acknowledged: null }
    : path === "/api/cases" ? { cases: CASES } : { sessions: [], kpi1: null }), { status: 200 })));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("session-owned station facade integration", () => {
  it("exposes no readers before explicit connection and revokes the existing transport on disconnect", async () => {
    const { result } = renderHook(() => usePrecinctSession({ reducedMotion: true, paused: false, audioInRoom: false }));
    expect(result.current.stationReads).toBeNull(); expect(transport).not.toHaveBeenCalled();
    await act(async () => { await result.current.connectLocalBackend(); });
    expect(transport.mock.calls.map(([path]) => path)).toEqual(["/api/me", "/api/cases"]);
    const reads = result.current.stationReads; if (reads === null) throw new Error("Connected station readers unavailable");
    expect(reads).not.toHaveProperty("startSession"); expect(reads).not.toHaveProperty("speak"); expect(reads).not.toHaveProperty("requestDebrief");
    await reads.progress(); expect(transport).toHaveBeenCalledTimes(3);
    act(() => { result.current.disconnectLocalBackend(); });
    expect(result.current.stationReads).toBeNull(); await expect(reads.progress()).rejects.toThrow("Explicit local backend");
    expect(transport).toHaveBeenCalledTimes(3);
  });
});

const profile = { user_id: "station-test-user", display_name: "Local trainee", roles: ["trainee"], csrf_token: "test-token", ex4_acknowledged: "2026-10-15T09:00:00Z" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function ordinaryRead(path: string): Response {
  if (path === "/api/me") return response(profile);
  if (path === "/api/cases") return response({ cases: CASES });
  return response({ case: CASES.find((card) => card.case_id === RECORDED_CASE_ID), brief: { initial_documents: raw.case.initial_documents } });
}
const options = { reducedMotion: true, paused: false, audioInRoom: false };

describe("single assessment withholding authority", () => {
  it("withholds immediately for accepted assessment intent, remains closed before a snapshot, and clears a failed creation", async () => {
    let finish: (value: Response) => void = () => undefined;
    transport.mockImplementation((path) => path === "/api/sessions" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(ordinaryRead(path)));
    const { result } = renderHook(() => usePrecinctSession(options));
    expect(result.current.assessmentActive).toBe(false);
    act(() => { result.current.startInterview("assessment"); }); expect(result.current.assessmentActive).toBe(false);
    await act(async () => { await result.current.connectLocalBackend(); });
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    act(() => { result.current.startInterview("assessment"); });
    expect(result.current.assessmentActive).toBe(true); expect(result.current.view).toBeNull();
    await waitFor(() => { expect(result.current.live.phase).toBe("starting"); });
    expect(result.current.assessmentActive).toBe(true);
    act(() => { result.current.startInterview("practice"); }); expect(result.current.assessmentActive).toBe(true);
    await act(async () => { finish(response({ code: "failed" }, 500)); await Promise.resolve(); });
    await waitFor(() => { expect(result.current.live.phase).toBe("error"); }); expect(result.current.assessmentActive).toBe(false);
    act(() => { result.current.startInterview("practice"); }); expect(result.current.assessmentActive).toBe(false);
    act(() => { result.current.disconnectLocalBackend(); }); expect(result.current.assessmentActive).toBe(false);
  });

  it("protects an actual assessment even before its snapshot and if a stale practice snapshot arrives", async () => {
    let finish: (value: Response) => void = () => undefined;
    const trialId = "33333333-3333-4333-8333-333333333333";
    transport.mockImplementation((path) => {
      if (path === "/api/sessions") return Promise.resolve(response({ session_id: "22222222-2222-4222-8222-222222222222", trial_id: trialId, case_id: RECORDED_CASE_ID, mode: "assessment" }));
      if (path.endsWith("/snapshot")) return new Promise((resolve) => { finish = resolve; });
      if (path.endsWith("/stream-tickets")) return Promise.resolve(response({ ticket: "test-ticket" }));
      return Promise.resolve(ordinaryRead(path));
    });
    const { result } = renderHook(() => usePrecinctSession(options));
    await act(async () => { await result.current.connectLocalBackend(); }); act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    act(() => { result.current.startInterview("assessment"); });
    await waitFor(() => { expect(result.current.live.phase).toBe("running"); });
    expect(result.current.view).toBeNull(); expect(result.current.assessmentActive).toBe(true);
    await act(async () => { finish(response(raw.snapshot)); await Promise.resolve(); });
    await waitFor(() => { expect(result.current.view?.mode).toBe("practice"); });
    expect(result.current.assessmentActive).toBe(true);
    act(() => { result.current.stopSession(); }); expect(result.current.assessmentActive).toBe(false);
  });

  it("replaces an ended practice recording with assessment withholding in the same render and restores it on rewind", async () => {
    // A minimal wire-valid test recording, not a new runtime fixture or a changed bundled run.
    const ended = raw.events.find((event) => event.frame.type === "trial.status" && event.frame.data.status === "completed");
    const ready = raw.events.find((event) => event.frame.type === "debrief.ready");
    if (ended === undefined || ready === undefined) throw new Error("Fixture needs end and published readiness");
    const assessment = { ...raw, snapshot: { ...raw.snapshot, mode: "assessment" }, events: [
      { ...ended, at_ms: 1000, frame: { ...ended.frame, seq: 1 } },
      { ...ready, at_ms: 2000, frame: { ...ready.frame, seq: 2 } },
    ] };
    const observed: { readonly mode: string | undefined; readonly active: boolean; readonly ready: boolean }[] = [];
    const { result } = renderHook(() => {
      const session = usePrecinctSession(options);
      observed.push({ mode: session.view?.mode, active: session.assessmentActive, ready: session.debriefReady });
      return session;
    });
    await act(async () => { await result.current.loadBundledRecording(); });
    act(() => { result.current.playback.seekTo(result.current.playback.duration); });
    expect(result.current.debriefReady).toBe(true); expect(result.current.assessmentActive).toBe(false);
    observed.length = 0;
    const file = new File([], "assessment-test.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(JSON.stringify(assessment)) });
    await act(async () => { await result.current.importRecording(file); });
    expect(result.current.recordingError).toBeNull(); expect(result.current.view?.mode).toBe("assessment");
    expect(result.current.assessmentActive).toBe(true); expect(result.current.debriefReady).toBe(false);
    expect(observed.filter((entry) => entry.mode === "assessment").every((entry) => entry.active && !entry.ready)).toBe(true);
    act(() => { result.current.playback.seekTo(result.current.playback.duration); });
    expect(result.current.debriefReady).toBe(true); expect(result.current.assessmentActive).toBe(false);
    act(() => { result.current.playback.seekTo(0); }); expect(result.current.assessmentActive).toBe(true);
    act(() => { result.current.selectCase(RECORDED_CASE_ID); }); expect(result.current.assessmentActive).toBe(false);
  });
});


describe("assessment intent versus stale published feedback", () => {
  it("gives accepted pending intent priority over an old practice debrief, then releases only for the bound run", async () => {
    const checked = parseRecording(raw);
    if (!checked.ok || checked.recording.debrief === null) throw new Error("Expected validated published test debrief");
    const oldDebrief = checked.recording.debrief;
    const nextSessionId = "44444444-4444-4444-8444-444444444444";
    let held: liveHooks.LiveControls = {
      phase: "idle", session: { session_id: oldDebrief.session_id, trial_id: raw.trial_id, case_id: RECORDED_CASE_ID, mode: "practice" },
      connection: "idle", trial: trialReducer(initialTrialState(), { type: "snapshot", snapshot: checked.recording.snapshot }),
      world: null, debrief: oldDebrief, clock: { current: 0 }, arrivals: new Map(), error: null, resumable: null,
      start: () => { held = { ...held, phase: "starting" }; return Promise.resolve(); }, resume: () => Promise.resolve(),
      ask: () => Promise.resolve(false), failedQuestion: null, retryAsk: () => Promise.resolve(false), request: () => Promise.resolve(null), commit: () => Promise.resolve(false),
      retryDebrief: vi.fn(), debriefFailed: false, typing: vi.fn(), stop: vi.fn(), connectionError: null, reconnect: vi.fn(),
    };
    vi.spyOn(liveHooks, "useLiveSession").mockImplementation(() => held);
    transport.mockImplementation((path) => Promise.resolve(ordinaryRead(path)));
    const observations: { readonly source: string; readonly active: boolean; readonly debriefId: string | null }[] = [];
    const { result, rerender } = renderHook(() => {
      const session = usePrecinctSession(options);
      observations.push({ source: session.source, active: session.assessmentActive, debriefId: session.debrief?.session_id ?? null });
      return session;
    });
    await act(async () => { await result.current.connectLocalBackend(); });
    act(() => { result.current.selectCase(RECORDED_CASE_ID); });
    await waitFor(() => { expect(result.current.packetState).toBe("ready"); });
    observations.length = 0;
    act(() => { result.current.startInterview("assessment"); });
    expect(result.current.debrief?.session_id).toBe(oldDebrief.session_id);
    expect(result.current.assessmentActive).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.live.phase).toBe("starting"); expect(result.current.assessmentActive).toBe(true);
    expect(observations.filter((entry) => entry.source === "live").every((entry) => entry.active)).toBe(true);
    held = { ...held, phase: "running", session: { session_id: nextSessionId, trial_id: "55555555-5555-4555-8555-555555555555", case_id: RECORDED_CASE_ID, mode: "assessment" } };
    rerender(); expect(result.current.view?.mode).toBe("practice"); expect(result.current.assessmentActive).toBe(true);
    held = { ...held, debrief: { ...oldDebrief, session_id: nextSessionId } };
    rerender(); expect(result.current.assessmentActive).toBe(false);
  });
});
