import { describe, expect, it, vi } from "vitest";
import { canStartInterview, startPreparedInterview, type InterviewStartSession } from "./interviewStart";

function ready(overrides: Partial<InterviewStartSession> = {}): InterviewStartSession {
  return { canStart: true, modes: ["practice", "assessment"], source: "idle", live: { phase: "idle", resumable: null }, startInterview: vi.fn(), ...overrides };
}
function notebook() { return { prepareForNewRun: vi.fn(() => true), discardPreparation: vi.fn() }; }
const resumable = { session_id: "old-session", trial_id: "old-trial", case_id: "same-case", mode: "practice" as const };

describe("explicit preparation-to-new-run adapter", () => {
  it.each(["practice", "assessment", "voice"] as const)("arms preparation immediately before allowed idle %s", (kind) => {
    const order: string[] = [];
    const session = ready({ startInterview: vi.fn(() => { order.push("start"); }) });
    const preparation = { prepareForNewRun: vi.fn(() => { order.push("prepare"); return true; }), discardPreparation: vi.fn() };
    expect(startPreparedInterview(session, preparation, kind)).toBe(true);
    expect(order).toEqual(["prepare", "start"]);
    expect(session.startInterview).toHaveBeenCalledWith(kind);
    expect(preparation.discardPreparation).not.toHaveBeenCalled();
  });
  it("starts a permitted new interview when there are no notes to carry", () => {
    const preparation = notebook(); preparation.prepareForNewRun.mockReturnValue(false);
    const session = ready();
    expect(startPreparedInterview(session, preparation, "practice")).toBe(true);
    expect(session.startInterview).toHaveBeenCalledOnce();
  });
  it("does not arm or discard anything for offline, denied modes, running or starting no-ops", () => {
    const blocked = [ready({ canStart: false }), ready({ modes: ["assessment"] }), ready({ source: "live", live: { phase: "starting", resumable: null } }), ready({ source: "live", live: { phase: "running", resumable: null } })];
    for (const session of blocked) {
      const preparation = notebook();
      expect(startPreparedInterview(session, preparation, "practice")).toBe(false);
      expect(session.startInterview).not.toHaveBeenCalled();
      expect(preparation.prepareForNewRun).not.toHaveBeenCalled();
      expect(preparation.discardPreparation).not.toHaveBeenCalled();
    }
    expect(canStartInterview(ready({ modes: ["assessment"] }), "voice")).toBe(false);
  });
  it("requires an actually resumable allowed mode and discards preparation before Resume", () => {
    const preparation = notebook();
    expect(startPreparedInterview(ready(), preparation, "resume")).toBe(false);
    const denied = ready({ modes: ["assessment"], live: { phase: "idle", resumable } });
    expect(startPreparedInterview(denied, preparation, "resume")).toBe(false);
    const order: string[] = [];
    const session = ready({ live: { phase: "idle", resumable }, startInterview: vi.fn(() => { order.push("resume"); }) });
    preparation.discardPreparation.mockImplementation(() => { order.push("discard"); });
    expect(startPreparedInterview(session, preparation, "resume")).toBe(true);
    expect(order).toEqual(["discard", "resume"]);
    expect(preparation.prepareForNewRun).not.toHaveBeenCalled();
  });
  it("discards any offer when explicitly starting from a recording", () => {
    const preparation = notebook();
    expect(startPreparedInterview(ready({ source: "recording" }), preparation, "assessment")).toBe(true);
    expect(preparation.discardPreparation).toHaveBeenCalledOnce();
    expect(preparation.prepareForNewRun).not.toHaveBeenCalled();
  });
  it("retains an already-armed offer on retry of the same live/error new start", () => {
    const preparation = notebook();
    const session = ready({ source: "live", live: { phase: "error", resumable: null } });
    expect(startPreparedInterview(session, preparation, "practice")).toBe(true);
    expect(session.startInterview).toHaveBeenCalledWith("practice");
    expect(preparation.prepareForNewRun).not.toHaveBeenCalled();
    expect(preparation.discardPreparation).not.toHaveBeenCalled();
  });
});
