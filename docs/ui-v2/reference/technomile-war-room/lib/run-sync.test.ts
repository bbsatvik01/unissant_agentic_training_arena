import { describe, expect, it } from "vitest";

import { canSubmit, clockInterval, impliedRunState, runStateMismatch, seedRetryDelay, submitNext, type SubmitEvent, type SubmitState } from "./run-sync";

describe("seedRetryDelay (a failed first read retries on its own)", () => {
  it("backs off from 2 s and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(seedRetryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(seedRetryDelay(0)).toBe(2_000);
  });
});

describe("runStateMismatch (the view follows every run status transition)", () => {
  it("says what the store implies", () => {
    expect(impliedRunState("running", null)).toBe("active");
    expect(impliedRunState("finished", "decided")).toBe("decided");
    expect(impliedRunState("error", null)).toBe("failed");
    expect(impliedRunState("idle", null)).toBeNull();
  });

  it("asks for a re-read after H2 is recorded while the view still waits at H2", () => {
    expect(runStateMismatch("decided", "finished", "awaiting_decision")).toBe(true);
  });

  it("asks for a re-read when a parked run works again, or a working view's run parked or ended", () => {
    expect(runStateMismatch("running", "finished", "awaiting_plan_approval")).toBe(true);
    expect(runStateMismatch("awaiting_decision", "running", null)).toBe(true);
    expect(runStateMismatch("cancelled", "running", null)).toBe(true);
    expect(runStateMismatch("interrupted", "error", null)).toBe(true);
  });

  it("is quiet when the view already agrees, or has not had its first read", () => {
    expect(runStateMismatch("running", "running", null)).toBe(false);
    expect(runStateMismatch("degraded", "running", null)).toBe(false);
    expect(runStateMismatch("decided", "finished", "decided")).toBe(false);
    expect(runStateMismatch("failed", "error", null)).toBe(false);
    expect(runStateMismatch(null, "finished", "awaiting_decision")).toBe(false);
    expect(runStateMismatch("decided", "idle", null)).toBe(false);
  });
});

describe("clockInterval (gate waits keep counting)", () => {
  it("ticks while a stage runs and while a gate waits, and stops once the run ended", () => {
    expect(clockInterval("running")).toBe(1_000);
    expect(clockInterval("awaiting_plan_approval")).toBe(1_000);
    expect(clockInterval("awaiting_decision")).toBe(1_000);
    expect(clockInterval("awaiting_review")).toBe(1_000);
    expect(clockInterval(null)).toBe(1_000);
    expect(clockInterval("decided")).toBeNull();
    expect(clockInterval("cancelled")).toBeNull();
  });
});

describe("submitNext (a recorded action locks its form)", () => {
  const run = (events: SubmitEvent[]): SubmitState[] => {
    const out: SubmitState[] = [];
    let s: SubmitState = "idle";
    for (const e of events) out.push((s = submitNext(s, e)));
    return out;
  };

  it("allows one submission in flight and none after success", () => {
    // a double click while the first POST is in flight does not start a second one; success stays locked
    expect(run(["submit", "submit", "ok", "submit"])).toEqual(["busy", "busy", "done", "done"]);
    expect(canSubmit("busy")).toBe(false);
    expect(canSubmit("done")).toBe(false);
  });

  it("lets a person try again after a failure", () => {
    expect(run(["submit", "fail", "submit", "ok"])).toEqual(["busy", "error", "busy", "done"]);
    expect(canSubmit("idle")).toBe(true);
    expect(canSubmit("error")).toBe(true);
    // a stray answer without a submission changes nothing
    expect(submitNext("idle", "ok")).toBe("idle");
    expect(submitNext("done", "fail")).toBe("done");
  });
});
