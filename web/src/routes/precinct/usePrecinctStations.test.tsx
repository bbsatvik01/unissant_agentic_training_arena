// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRILL_DURATION_MS } from "../../lib/precinct/dailyDrill";
import { usePrecinctStations, type PrecinctStationsOptions } from "./usePrecinctStations";

let now = 0;
const options: PrecinctStationsOptions = { caseId: "PUBLIC-A", panel: "drill", assessmentActive: false, paused: false };
function visibility(value: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { configurable: true, value }); }
beforeEach(() => { now = 0; vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => now); visibility("visible"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("route-owned training station memory", () => {
  it("never starts timing, storage, network or local mocks on mount", () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const get = vi.spyOn(Storage.prototype, "getItem"); const set = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => usePrecinctStations(options));
    expect(result.current.drill.status).toBe("ready"); expect(vi.getTimerCount()).toBe(0);
    expect(result.current.coachLab.kind).toBe("unavailable"); expect(result.current.instructorDemo).toBe(false);
    expect(network).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it("owns a monotonic three-minute timer, pauses on close, and resumes only explicitly with the draft intact", () => {
    const { result, rerender } = renderHook((props) => usePrecinctStations(props), { initialProps: options });
    act(() => { result.current.drillAction({ type: "write", field: "question", text: "What happened next?" }); result.current.drillAction({ type: "start", nowMs: 999999999 }); });
    expect(result.current.drill.startedAtMs).toBe(0);
    now = 1500; act(() => { vi.advanceTimersByTime(250); });
    rerender({ ...options, panel: null });
    expect(result.current.drill.status).toBe("paused"); expect(result.current.drill.elapsedMs).toBe(1500);
    expect(result.current.drill.question).toBe("What happened next?"); expect(vi.getTimerCount()).toBe(0);
    now = 20_000; act(() => { vi.advanceTimersByTime(10_000); }); rerender(options);
    expect(result.current.drill.status).toBe("paused"); expect(result.current.drill.elapsedMs).toBe(1500);
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); });
    now += DRILL_DURATION_MS - 1500; act(() => { vi.advanceTimersByTime(250); });
    expect(result.current.drill.status).toBe("complete"); expect(result.current.drill.elapsedMs).toBe(DRILL_DURATION_MS);
    act(() => { result.current.drillAction({ type: "write", field: "corroboration", text: "Check the log" }); });
    expect(result.current.drill.corroboration).toBe("Check the log");
    act(() => { result.current.drillAction({ type: "reset" }); }); expect(result.current.drill.status).toBe("ready"); expect(result.current.drill.question).toBe("");
  });
  it("pauses on hidden/pagehide and never auto-resumes when visible", () => {
    const { result } = renderHook(() => usePrecinctStations(options));
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); });
    now = 1000; visibility("hidden"); act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.drill.status).toBe("paused"); expect(result.current.drill.elapsedMs).toBe(1000);
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); }); expect(result.current.drill.status).toBe("paused");
    visibility("visible"); act(() => { document.dispatchEvent(new Event("visibilitychange")); }); expect(result.current.drill.status).toBe("paused");
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); }); now = 2000;
    act(() => { window.dispatchEvent(new Event("pagehide")); }); expect(result.current.drill.elapsedMs).toBe(2000);
  });
  it("catches hidden tabs at tick time even when no visibility event was delivered", () => {
    const { result } = renderHook(() => usePrecinctStations(options));
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); }); now = 500; visibility("hidden");
    act(() => { vi.advanceTimersByTime(250); }); expect(result.current.drill.status).toBe("paused");
  });
  it.each([{ ...options, panel: null }, { ...options, paused: true }, { ...options, assessmentActive: true }, { ...options, caseId: null }])("rejects timing/editing without an active allowed case panel", (closed) => {
    const { result } = renderHook(() => usePrecinctStations(closed));
    act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); result.current.drillAction({ type: "write", field: "question", text: "blocked" }); });
    expect(result.current.drill.status).toBe("ready"); expect(result.current.drill.question).toBe("");
  });
  it("pauses on assessment/global pause, and never carries drafts or time to another case", () => {
    const { result, rerender } = renderHook((props) => usePrecinctStations(props), { initialProps: options });
    act(() => { result.current.drillAction({ type: "write", field: "question", text: "Case A" }); result.current.drillAction({ type: "start", nowMs: 0 }); }); now = 1000;
    rerender({ ...options, assessmentActive: true }); expect(result.current.drill.status).toBe("paused");
    rerender(options); act(() => { result.current.drillAction({ type: "start", nowMs: 0 }); }); now = 2000;
    rerender({ ...options, paused: true }); expect(result.current.drill.elapsedMs).toBe(2000);
    rerender({ ...options, caseId: "PUBLIC-B" }); expect(result.current.drill.status).toBe("ready"); expect(result.current.drill.question).toBe("");
    rerender(options); expect(result.current.drill.question).toBe(""); expect(result.current.drill.elapsedMs).toBe(0);
  });
  it("requires explicit demo activation and keeps validated fictional drafts only in route memory", () => {
    const { result, rerender } = renderHook((props) => usePrecinctStations(props), { initialProps: options });
    const draft = { kind: "local-assignment-draft", traineeLabel: "Sample trainee A", caseId: "PUBLIC-A", note: " Ask neutrally " } as const;
    act(() => { result.current.addAssignment(draft); result.current.addAnnotation({ trialId: "LOCAL-DEMO-TRIAL", body: { t_ms: 1, text: "A note" } }); });
    expect(result.current.assignments).toEqual([]); expect(result.current.annotations).toEqual([]);
    act(() => { result.current.showCoachDemo(); result.current.enableInstructorDemo(); result.current.choosePrimer("D4"); });
    expect(result.current.coachLab.kind).toBe("local-demo"); expect(result.current.selectedPrimer).toBe("D4");
    act(() => { result.current.addAssignment(draft); result.current.addAssignment({ ...draft, traineeLabel: "Real person" }); result.current.addAssignment({ ...draft, note: "x".repeat(2001) }); result.current.addAnnotation({ trialId: "LOCAL-DEMO-TRIAL", body: { t_ms: 1000, text: " Check the record " } }); result.current.addAnnotation({ trialId: "LOCAL-DEMO-TRIAL", body: { t_ms: -1, text: "no" } }); });
    expect(result.current.assignments).toEqual([{ ...draft, note: "Ask neutrally" }]); expect(result.current.annotations).toEqual([{ trialId: "LOCAL-DEMO-TRIAL", body: { t_ms: 1000, text: "Check the record" } }]);
    rerender({ ...options, assessmentActive: true });
    act(() => { result.current.choosePrimer("D1"); result.current.showCoachDemo(); result.current.enableInstructorDemo(); result.current.addAssignment(draft); result.current.addAnnotation({ trialId: "LOCAL-DEMO-TRIAL", body: { t_ms: 2000, text: "Blocked" } }); });
    expect(result.current.selectedPrimer).toBe("D4"); expect(result.current.assignments).toHaveLength(1); expect(result.current.annotations).toHaveLength(1);
  });
});
