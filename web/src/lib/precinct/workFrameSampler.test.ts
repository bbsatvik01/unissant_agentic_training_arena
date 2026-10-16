import { describe, expect, it, vi } from "vitest";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { LogBuilder, snapshot } from "../../test/trial-log";
import { createWorkFrameSampler, type WorkFrameSampleInput } from "./workFrameSampler";

function input(overrides: Partial<WorkFrameSampleInput> = {}): WorkFrameSampleInput {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
  for (const frame of new LogBuilder().ask().frames) state = trialReducer(state, { type: "frame", frame });
  return { view: state.view, arrivals: new Map(), clock: { current: 400 }, paused: false, reducedMotion: false, assessment: false, recorded: false, ...overrides };
}

describe("one canonical work-frame sampler", () => {
  it("does not advance a clock or create timers and deduplicates unchanged snapshots", () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    const sampler = createWorkFrameSampler();
    sampler.sample(); expect(sampler.getSnapshot().available).toBe(false);
    const notify = vi.fn(), unsubscribe = sampler.subscribe(notify);
    const source = input(); sampler.configure(source);
    expect(notify).toHaveBeenCalledOnce();
    expect(sampler.getSnapshot().phase).toBe(.25);
    sampler.sample(); sampler.configure(source);
    expect(notify).toHaveBeenCalledOnce();
    source.clock.current = 800; sampler.sample();
    expect(sampler.getSnapshot().phase).toBe(.5);
    expect(source.clock.current).toBe(800);
    unsubscribe(); source.clock.current = 1200; sampler.sample();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(timer).not.toHaveBeenCalled(); timer.mockRestore();
  });
  it("holds live decorative phase across global pause even if public state keeps arriving", () => {
    const sampler = createWorkFrameSampler(); const source = input(); sampler.configure(source);
    source.clock.current = 500; sampler.configure({ ...source, paused: true });
    expect(sampler.getSnapshot().phase).toBe(500 / 1600);
    source.clock.current = 1500; sampler.sample(); sampler.configure({ ...source, paused: true, arrivals: new Map([["new-event", 1400]]) });
    expect(sampler.getSnapshot().phase).toBe(500 / 1600);
    sampler.configure({ ...source, paused: false });
    expect(sampler.getSnapshot().phase).toBe(1500 / 1600);
  });
  it("refreshes paused recorded seeks from the exact cursor and respects reduced motion", () => {
    const sampler = createWorkFrameSampler(); const source = input({ recorded: true, paused: true }); sampler.configure(source);
    source.clock.current = 900; sampler.sample(); expect(sampler.getSnapshot().phase).toBe(.25);
    sampler.sample(true); expect(sampler.getSnapshot().phase).toBe(900 / 1600);
    source.clock.current = 200; sampler.configure({ ...source, arrivals: new Map() });
    expect(sampler.getSnapshot().phase).toBe(200 / 1600);
    sampler.configure({ ...source, reducedMotion: true }); expect(sampler.getSnapshot().phase).toBe(0);
  });
  it("withholds stale practice work before an assessment snapshot and supports narrow referee progress", () => {
    const sampler = createWorkFrameSampler(); sampler.configure(input({ assessment: true, referee: { status: "scoring" } }));
    expect(sampler.getSnapshot().assessment).toBe(true);
    expect(sampler.getSnapshot().cards).toBe(0);
    expect(sampler.getSnapshot().agents.find((agent) => agent.id === "coach")?.status).toBe("withheld");
    sampler.configure(input({ view: null, assessment: true }));
    expect(sampler.getSnapshot().assessment).toBe(true);
    expect(sampler.getSnapshot().available).toBe(false);
  });
});
