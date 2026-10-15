// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArenaApi } from "../../lib/api/arena";
import { parseTrialFrame, type TrialStreamOptions } from "../../lib/sse/trial-stream";
import { LogBuilder, SESSION_ID, TRIAL_ID, snapshot } from "../../test/trial-log";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { createFreshClientCapture } from "../../lib/world/freshClientCapture";
import { useLiveSession } from "./useLiveSession";

const stream = vi.hoisted((): { options: TrialStreamOptions | null } => ({ options: null }));
vi.mock("../../lib/sse/trial-stream", async (original) => ({ ...await original<typeof import("../../lib/sse/trial-stream")>(), openTrialStream: (options: TrialStreamOptions) => {
  stream.options = options; return { lastSeq: 0, dropped: 0, current: null, lastEventId: null, close: () => undefined, finish: () => undefined, reconnect: () => undefined };
} }));
const started = { trial_id: TRIAL_ID, session_id: SESSION_ID, mode: "practice" as const, case_id: raw.case.case_id };
function api(): ArenaApi {
  const refuse = () => Promise.reject(new Error("unused capability"));
  return { trialSnapshot: () => Promise.resolve(snapshot()), mintStreamTicket: refuse, mintVoiceTicket: refuse,
    readDebrief: refuse, requestDebrief: refuse, ackCard: () => Promise.resolve(), reportContractViolation: () => Promise.resolve(),
    submitTurn: refuse, requestEvidence: refuse, commitFinding: refuse, listCases: refuse, caseBrief: refuse,
    startSession: () => Promise.resolve(started), leaderboard: refuse, tournaments: refuse, tournament: refuse,
    tournamentEvents: refuse, me: refuse, ackEx4: refuse, progress: refuse, recording: refuse, speak: refuse };
}
let now = 0;
const callbacks = new Map<number, FrameRequestCallback>();
let next = 0;
beforeEach(() => {
  now = 100; next = 0; callbacks.clear(); stream.options = null; sessionStorage.clear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { const id = ++next; callbacks.set(id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });
const options = { caseId: raw.case.case_id, subjectName: "Subject", reducedMotion: true, paused: false };

describe("fresh capture shares the live presentation clock", () => {
  it("uses the accepted opening as zero and gives frames, arrivals and inputs the same clock", async () => {
    const capture = createFreshClientCapture(); capture.arm(raw.case, "id"); const arena = api();
    const { result } = renderHook(() => useLiveSession({ ...options, api: arena, capture }));
    await act(async () => { await result.current.start("practice"); });
    expect(capture.getSnapshot().phase).toBe("recording"); expect(result.current.clock.current).toBe(0);
    expect(callbacks.size).toBe(1);
    const frame = new LogBuilder().ask().frames[0]; if (frame === undefined) throw new Error("missing frame");
    const parsed = parseTrialFrame(JSON.stringify(frame), TRIAL_ID); if (typeof parsed === "string") throw new Error(parsed);
    act(() => { now = 275; stream.options?.onFrame(parsed); });
    expect(result.current.arrivals.get("question.accepted:1")).toBe(175);
    expect(result.current.clock.current).toBe(175);
    act(() => { now = 300; result.current.captureBinding?.input({ action: "text", field_id: "question-draft", value: "Actual draft" }); });
    expect(result.current.clock.current).toBe(200); expect(callbacks.size).toBe(1);
    capture.stop(); const saved = capture.exportRecording(); if (!saved.ok) throw new Error(saved.errors.join("; "));
    expect(saved.recording.events[0]?.at_ms).toBe(175); expect(saved.recording.world_events[0]?.t_ms).toBe(200);
    expect(saved.recording.world_events[0]?.data).toMatchObject({ action: "text", value: "Actual draft" });
  });
  it("leaves the unobserved flow intact and invalidates a captured scope on stop", async () => {
    const arena = api(); const { result, unmount } = renderHook(() => useLiveSession({ ...options, api: arena }));
    await act(async () => { await result.current.start("practice"); });
    expect(result.current.captureBinding).toBeNull(); expect(callbacks.size).toBe(1); unmount();
    const capture = createFreshClientCapture(); capture.arm(raw.case, "id");
    const second = renderHook(() => useLiveSession({ ...options, api: arena, capture }));
    await act(async () => { await second.result.current.start("practice"); });
    const old = second.result.current.captureBinding;
    act(() => { second.result.current.stop(); });
    expect(capture.getSnapshot().reason).toBe("scope-replaced");
    expect(old?.input({ action: "text", field_id: "question-draft", value: "stale" })).toBe(false);
  });
  it("refuses an armed voice start rather than claiming silent text coverage", async () => {
    const capture = createFreshClientCapture(); capture.arm(raw.case, "id"); const arena = api();
    const { result } = renderHook(() => useLiveSession({ ...options, api: arena, capture }));
    await act(async () => { await result.current.start("practice", true); });
    expect(capture.getSnapshot().reason).toBe("unsupported-channel"); expect(result.current.captureBinding).toBeNull();
  });
});
