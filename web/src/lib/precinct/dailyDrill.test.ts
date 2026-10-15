import { describe, expect, it } from "vitest";
import { dailyDrillReducer, DRILL_DURATION_MS, drillClock, drillElapsed, drillStage, INITIAL_DRILL, type DrillState } from "./dailyDrill";

describe("local daily drill", () => {
  it("starts only on demand and ignores repeated start actions", () => {
    const running = dailyDrillReducer(INITIAL_DRILL, { type: "start", nowMs: 1000 });
    expect(running).toEqual({ ...INITIAL_DRILL, status: "running", startedAtMs: 1000 });
    expect(dailyDrillReducer(running, { type: "start", nowMs: 2000 })).toBe(running);
    expect(drillElapsed(INITIAL_DRILL, 4000)).toBe(0);
    expect(drillElapsed(running, 500)).toBe(0);
    expect(drillElapsed(running, NaN)).toBe(0);
    expect(drillElapsed(running, 61_000)).toBe(60_000);
    expect(drillElapsed({ ...running, startedAtMs: null }, 61_000)).toBe(0);
  });
  it("pauses, resumes and excludes paused time", () => {
    const running = dailyDrillReducer(INITIAL_DRILL, { type: "start", nowMs: 1000 });
    const paused = dailyDrillReducer(running, { type: "pause", nowMs: 61_000 });
    expect(paused).toMatchObject({ status: "paused", elapsedMs: 60_000, startedAtMs: null });
    expect(drillElapsed(paused, 999_999)).toBe(60_000);
    const resumed = dailyDrillReducer(paused, { type: "start", nowMs: 200_000 });
    expect(drillElapsed(resumed, 201_000)).toBe(61_000);
    expect(dailyDrillReducer(paused, { type: "tick", nowMs: 999_999 })).toBe(paused);
  });
  it("completes at three elapsed minutes without creating a finding or a score", () => {
    const running = dailyDrillReducer(INITIAL_DRILL, { type: "start", nowMs: 1000 });
    expect(dailyDrillReducer(running, { type: "tick", nowMs: 180_999 })).toBe(running);
    const complete = dailyDrillReducer(running, { type: "tick", nowMs: 181_000 });
    expect(complete).toEqual({ ...INITIAL_DRILL, status: "complete", elapsedMs: DRILL_DURATION_MS, startedAtMs: null });
    expect(dailyDrillReducer(complete, { type: "start", nowMs: 200_000 })).toBe(complete);
    expect(drillElapsed(running, 999_999)).toBe(DRILL_DURATION_MS);
    expect(dailyDrillReducer(running, { type: "pause", nowMs: 999_999 }).status).toBe("complete");
  });
  it("keeps bounded editable notes after completion and resets only on request", () => {
    let state: DrillState = { ...INITIAL_DRILL, status: "complete" };
    state = dailyDrillReducer(state, { type: "write", field: "question", text: "What happened next?" });
    state = dailyDrillReducer(state, { type: "write", field: "corroboration", text: "x".repeat(2100) });
    expect(state.question).toBe("What happened next?");
    expect(state.corroboration).toHaveLength(2000);
    expect(state.status).toBe("complete");
    expect(dailyDrillReducer(state, { type: "reset" })).toEqual(INITIAL_DRILL);
    expect(INITIAL_DRILL.question).toBe("");
  });
  it("ignores invalid time and inactive timer actions", () => {
    expect(dailyDrillReducer(INITIAL_DRILL, { type: "start", nowMs: Infinity })).toBe(INITIAL_DRILL);
    expect(dailyDrillReducer(INITIAL_DRILL, { type: "pause", nowMs: 0 })).toBe(INITIAL_DRILL);
  });
  it("formats the three phases and a bounded countdown at exact boundaries", () => {
    expect([0, 59_999, 60_000, 119_999, 120_000, 180_000].map(drillStage)).toEqual(["read", "read", "question", "question", "closure", "closure"]);
    expect([0, 1, 60_000, 120_000, 179_999, 180_000, 999_999].map(drillClock)).toEqual(["3:00", "3:00", "2:00", "1:00", "0:01", "0:00", "0:00"]);
  });
});
