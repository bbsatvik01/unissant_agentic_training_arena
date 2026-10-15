import { describe, expect, it, vi } from "vitest";
import { createWorldCapture } from "./worldCapture";
import { isWorldEvent } from "./worldEvents";
const context = () => ({ sessionKey: "session", trialId: "trial", clockMs: 0, writable: true, publicEvidenceIds: new Set<string>(), publicTextFields: new Set<string>() });
describe("UI-local finding event boundary", () => {
  it("cannot enter a sender-capable world capture even with a forged local action option", () => {
    const c = createWorldCapture({ context, localFindingActions: true }); c.start(); const send = vi.fn(() => Promise.resolve()); c.enableSender(send);
    expect(c.input({ action: "finding", operation: "submitted", after_frames: 0 })).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(c.exportEvents().events).toEqual([]);
  });
  it("only records finding actions when both offline-only and explicit local action capability are present", () => {
    const c = createWorldCapture({ context, localOnly: true, localFindingActions: true }); c.start();
    expect(c.enableSender(vi.fn(() => Promise.resolve()))).toBe(false);
    expect(c.input({ action: "finding", operation: "submitted", after_frames: 0 })).toBe(true);
    expect(c.exportEvents().events).toHaveLength(1);
    const ordinary = createWorldCapture({ context, localOnly: true }); ordinary.start();
    expect(ordinary.input({ action: "finding", operation: "submitted", after_frames: 0 })).toBe(false);
  });
  it("rejects unknown fields and unbounded/noninteger anchors", () => {
    for (const data of [{ action: "finding", operation: "submit", after_frames: 0 }, { action: "finding", operation: "failed", after_frames: -1 }, { action: "finding", operation: "failed", after_frames: 1.5 }, { action: "finding", operation: "submitted", after_frames: 20_001 }, { action: "finding", operation: "submitted", after_frames: 0, secret: "hidden" }]) expect(isWorldEvent({ t_ms: 0, kind: "input", data })).toBe(false);
  });
});
