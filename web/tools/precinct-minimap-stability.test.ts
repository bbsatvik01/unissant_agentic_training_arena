import { describe, expect, it } from "vitest";
import { collectMinimapStability, minimapStabilityEvidence, type MinimapSamplerClock } from "./precinct-minimap-stability";

const options = { startedEpochMs: 1000, durationMs: 1500, intervalMs: 150 };
const origin = { x: 0, z: -4.2 };
const stationary = "translate(0 -4.2) rotate(0)";

/** Pure fake time; no real timer, DOM, browser, application or worker process. */
function fakeClock(initialMs = 1000) {
  let now = initialMs, nextId = 0, reads = 0, cancellations = 0;
  const pending = new Map<number, { due: number; callback: () => void }>();
  const clock: MinimapSamplerClock = {
    now: () => now,
    read: () => { reads += 1; return stationary; },
    after: (delayMs, callback) => {
      const id = nextId++; pending.set(id, { due: now + delayMs, callback });
      return () => { cancellations += 1; pending.delete(id); };
    },
  };
  const step = (extraDelayMs = 0) => {
    const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (next === undefined) throw new Error("No scheduled observation.");
    pending.delete(next[0]); now = next[1].due + extraDelayMs; next[1].callback();
  };
  const drain = () => {
    for (let i = 0; pending.size > 0; i += 1) {
      if (i >= 20) throw new Error("Sampler extended its finite observation window.");
      step();
    }
  };
  return { clock, step, drain, pending, setNow: (value: number) => { now = value; },
    counts: () => ({ reads, cancellations }) };
}

describe("bounded public minimap stability observation", () => {
  it("keeps the original 1500ms/150ms contract and separates the boundary observation", async () => {
    const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock);
    fake.drain(); const observation = await promise, evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.passed).toBe(true);
    expect(evidence.samples.map((sample) => sample.elapsedMs)).toEqual([0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350]);
    expect(evidence.lateSamples.map((sample) => sample.elapsedMs)).toEqual([1500]);
    expect(observation).toMatchObject({ dispatchDelayMs: 0, completedElapsedMs: 1500, starved: false, error: null });
    expect(fake.pending.size).toBe(0); expect(fake.counts().cancellations).toBe(1);
  });
  it("charges initial dispatch delay to the existing host-start budget", async () => {
    const fake = fakeClock(1075), promise = collectMinimapStability(options, fake.clock);
    fake.drain(); const observation = await promise;
    expect(observation).toMatchObject({ dispatchDelayMs: 75, completedElapsedMs: 1500 });
    expect(minimapStabilityEvidence(observation, origin).passed).toBe(true);
  });
  it("retains the observed 2279ms late callback and cannot count it as stability", async () => {
    const fake = fakeClock(1014.725), promise = collectMinimapStability(options, fake.clock);
    fake.step(2114.744); const observation = await promise, evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.samples).toHaveLength(1); expect(evidence.lateSamples).toHaveLength(1);
    expect(evidence.lateSamples[0]?.elapsedMs).toBeCloseTo(2279.469);
    expect(observation.starved).toBe(true); expect(evidence.passed).toBe(false); expect(fake.pending.size).toBe(0);
  });
  it("fails timer starvation even with three or more otherwise valid samples", async () => {
    const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock);
    fake.step(); fake.step(150); fake.drain();
    const observation = await promise, evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.samples.length).toBeGreaterThanOrEqual(3);
    expect(observation.starved).toBe(true); expect(evidence.passed).toBe(false);
    expect(evidence.samples.map((sample) => sample.elapsedMs).slice(0, 4)).toEqual([0, 150, 450, 600]);
  });
  it("does not let a completed window and late sample satisfy the minimum three", async () => {
    const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock); fake.drain();
    const observation = await promise;
    observation.readings = observation.readings.filter((reading) => reading.elapsedMs === 0 || reading.elapsedMs === 150 || reading.elapsedMs === 1500);
    const evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.samples).toHaveLength(2); expect(evidence.lateSamples).toHaveLength(1);
    expect(evidence.completed).toBe(true); expect(evidence.passed).toBe(false);
  });
  it("rejects dispatch after the deadline without resetting the window or scheduling extra time", async () => {
    const fake = fakeClock(2600), observation = await collectMinimapStability(options, fake.clock);
    const evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.samples).toHaveLength(0); expect(evidence.lateSamples).toHaveLength(1);
    expect(evidence.passed).toBe(false); expect(fake.pending.size).toBe(0);
  });
  it("timestamps a slow DOM read after the read and excludes crossing-deadline observations", async () => {
    const fake = fakeClock(2499); fake.clock.read = () => { fake.setNow(2501); return stationary; };
    const observation = await collectMinimapStability(options, fake.clock), evidence = minimapStabilityEvidence(observation, origin);
    expect(evidence.samples).toHaveLength(0); expect(evidence.lateSamples[0]?.elapsedMs).toBe(1501);
    expect(evidence.passed).toBe(false); expect(fake.pending.size).toBe(0);
  });
  it("retains transient drift beyond 0.035m even after returning to the origin", async () => {
    const fake = fakeClock(); fake.clock.read = () => fake.clock.now() === 1300 ? "translate(0.036 -4.2) rotate(0)" : stationary;
    const promise = collectMinimapStability(options, fake.clock); fake.drain();
    const evidence = minimapStabilityEvidence(await promise, origin);
    expect(evidence.maxDisplacement).toBeCloseTo(0.036); expect(evidence.passed).toBe(false);
  });
  it("retains a late displacement as a failure diagnostic without using it for sample count", async () => {
    const fake = fakeClock(); fake.clock.read = () => fake.clock.now() >= 2500 ? "translate(0.1 -4.2) rotate(0)" : stationary;
    const promise = collectMinimapStability(options, fake.clock); fake.drain();
    const evidence = minimapStabilityEvidence(await promise, origin);
    expect(evidence.samples).toHaveLength(10); expect(evidence.lateSamples).toHaveLength(1);
    expect(evidence.maxDisplacement).toBe(0.1); expect(evidence.passed).toBe(false);
  });
  it("retains the inclusive 0.035m bound and scientific-notation parser", async () => {
    const fake = fakeClock(); fake.clock.read = () => "translate(3.5e-2 -4.2) rotate(-1e-8)";
    const promise = collectMinimapStability(options, fake.clock); fake.drain();
    expect(minimapStabilityEvidence(await promise, origin).passed).toBe(true);
  });
  it.each([null, "", "translate(NaN -4.2) rotate(0)", "translate(Infinity -4.2) rotate(0)",
    "translate(1e999 -4.2) rotate(0)", "translate(0 -4.2) rotate(NaN)", "translate(0 -4.2) rotate(0) extra"])("fails closed on missing/malformed/nonfinite transform %s", async (transform) => {
    const fake = fakeClock(); fake.clock.read = () => transform;
    const promise = collectMinimapStability(options, fake.clock); fake.drain();
    const evidence = minimapStabilityEvidence(await promise, origin);
    expect(evidence.errors.length).toBeGreaterThan(0); expect(evidence.passed).toBe(false); expect(fake.pending.size).toBe(0);
  });
  it("retains prior observations and cleans up when a public DOM read throws", async () => {
    const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock);
    fake.clock.read = () => { throw new Error("Minimap marker disappeared."); }; fake.step();
    const observation = await promise;
    expect(observation.readings).toHaveLength(1); expect(observation.error).toBe("Minimap marker disappeared.");
    expect(minimapStabilityEvidence(observation, origin).passed).toBe(false);
    expect(fake.pending.size).toBe(0); expect(fake.counts().cancellations).toBe(1);
  });
  it("fails closed if scheduling throws rather than leaving a promise or timer pending", async () => {
    const fake = fakeClock(); fake.clock.after = () => { throw new Error("Timer unavailable."); };
    const observation = await collectMinimapStability(options, fake.clock);
    expect(observation.error).toBe("Timer unavailable."); expect(observation.readings).toHaveLength(1);
    expect(minimapStabilityEvidence(observation, origin).passed).toBe(false); expect(fake.pending.size).toBe(0);
  });
  it("surfaces cleanup failure and cannot turn it into a pass", async () => {
    const fake = fakeClock(), after = fake.clock.after;
    fake.clock.after = (delayMs, callback) => {
      const cancel = after(delayMs, callback);
      return () => { cancel(); throw new Error("Cleanup rejected."); };
    };
    const promise = collectMinimapStability(options, fake.clock); fake.drain(); const observation = await promise;
    expect(observation.error).toContain("Cleanup rejected."); expect(minimapStabilityEvidence(observation, origin).passed).toBe(false);
    expect(fake.pending.size).toBe(0);
  });
  it("cleans up and fails when the deadline timer sees a nonfinite or backwards clock", async () => {
    for (const invalid of [NaN, Infinity, 999]) {
      const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock);
      fake.clock.now = () => invalid; fake.step(); const observation = await promise;
      expect(observation.error).toContain("Sampler clock"); expect(minimapStabilityEvidence(observation, origin).passed).toBe(false);
      expect(fake.pending.size).toBe(0); expect(fake.counts().cancellations).toBe(1);
    }
  });
  it("rejects changed windows, cadence, invalid starts and nonfinite origins", async () => {
    for (const changed of [{ ...options, durationMs: 1600 }, { ...options, intervalMs: 100 }, { ...options, startedEpochMs: NaN }]) {
      const fake = fakeClock(), observation = await collectMinimapStability(changed, fake.clock);
      expect(observation.error).toContain("unchanged"); expect(fake.counts().reads).toBe(0); expect(fake.pending.size).toBe(0);
    }
    const fake = fakeClock(), promise = collectMinimapStability(options, fake.clock); fake.drain();
    expect(minimapStabilityEvidence(await promise, { x: NaN, z: 0 }).passed).toBe(false);
  });
});
