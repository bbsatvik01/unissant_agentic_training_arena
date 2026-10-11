import { describe, expect, it } from "vitest";

import { LogBuilder, snapshot } from "../../test/trial-log";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { draftAfterSend, EMPTY_TRACKER, trackArrivals } from "./live";

describe("trackArrivals (the live seam)", () => {
  it("ignores a state without a snapshot", () => {
    expect(trackArrivals(EMPTY_TRACKER, initialTrialState(), 5)).toBe(EMPTY_TRACKER);
  });

  it("treats what the first snapshot already holds as history, then notes each new frame once at its time", () => {
    const log = new LogBuilder("practice").ask().ask();
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    const firstFrames = log.frames.slice(0, 3);
    for (const f of firstFrames) state = trialReducer(state, { type: "frame", frame: f });
    let t = trackArrivals(EMPTY_TRACKER, state, 100);
    expect([...t.arrivals.keys()]).toEqual(["snapshot"]);
    for (const f of log.frames.slice(3)) state = trialReducer(state, { type: "frame", frame: f });
    const next = trackArrivals(t, state, 2000);
    expect(next.arrivals.get("question.accepted:2")).toBe(2000);
    expect(next.arrivals.get("coach.card:2")).toBe(2000);
    expect(next.arrivals.has("question.accepted:1")).toBe(false);
    expect(trackArrivals(next, state, 3000)).toBe(next);
    t = next;
    expect(t.started).toBe(true);
  });
});

describe("draftAfterSend", () => {
  it("clears the draft that was sent, and keeps one typed while the request was in flight", () => {
    expect(draftAfterSend("Where were you?", "Where were you?")).toBe("");
    expect(draftAfterSend("And after that?", "Where were you?")).toBe("And after that?");
    expect(draftAfterSend("", "Where were you?")).toBe("");
  });
});
