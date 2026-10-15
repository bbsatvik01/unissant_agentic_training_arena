import { describe, expect, it } from "vitest";

import type { InspectCall } from "@/lib/live/inspect";
import type { RunHistory } from "@/lib/pipeline/rail";

import { EMPTY_TOWER } from "./record";
import { nearestFloor } from "./route";

import {
  APPROVED_SIGN_MS,
  callsAt,
  callSpans,
  exactClock,
  FAILED_LED_MS,
  gateAt,
  LEAD_MS,
  rackSlots,
  RESTAMP_MS,
  stampBeats,
  tallyAt,
  logRevealAt,
  towerWarpKeys,
  beatAt,
  finalBack,
  callLogRow,
  logAt,
  buildLog,
  type CallSpan,
  type TimedVerdict,
} from "./world";

const T0 = Date.parse("2026-10-05T04:42:34Z");
const clock = exactClock(T0);

function call(over: Partial<InspectCall>): InspectCall {
  return {
    createdAt: new Date(T0 + 10_000).toISOString(),
    stage: "S4",
    endpoint: "vertex",
    provider: "google",
    purpose: null,
    model: "m",
    status: "ok",
    free: false,
    usd: 0.01,
    latencyMs: 2000,
    ...over,
  } as InspectCall;
}

function span(over: Partial<CallSpan>): CallSpan {
  return { id: 0, endpoint: "a", stage: "S4", start: 0, end: 100, startTs: 0, free: false, ok: true, usd: 0.5, model: "m", ...over };
}

describe("model calls", () => {
  it("places each recorded call from its start (createdAt minus latency) to its return, skipping calls with no time", () => {
    const spans = callSpans([call({}), call({ createdAt: null }), call({ createdAt: new Date(T0 + 5000).toISOString(), latencyMs: null })], clock);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [5000 + LEAD_MS, 5000 + LEAD_MS],
      [8000 + LEAD_MS, 10_000 + LEAD_MS],
    ]);
  });

  it("gives each call a stable LED: the lowest slot free at its start, per endpoint rack", () => {
    const spans = [span({ id: 0, start: 0, end: 100 }), span({ id: 1, start: 50, end: 80 }), span({ id: 2, start: 100, end: 200 }), span({ id: 3, endpoint: "b", start: 10, end: 20 })];
    const plan = rackSlots(spans, 2);
    expect([0, 1, 2, 3].map((id) => plan.slotOf.get(id))).toEqual([0, 1, 0, 0]);
    expect(plan.rackOf("b")).toBe(1);
    // every slot busy: counted, not drawn
    expect(rackSlots([span({ id: 0 }), span({ id: 1 })], 1).slotOf.get(1)).toBe(-1);
  });

  it("counts calls started, in flight, failing and their spend at a time", () => {
    const spans = [span({ id: 0, start: 0, end: 100, usd: 1 }), span({ id: 1, start: 10, end: 50, ok: false, usd: 2 }), span({ id: 2, start: 500, end: 600 })];
    const now = callsAt(spans, 60);
    expect(now.started).toBe(2);
    expect(now.inFlight.map((s) => s.id)).toEqual([0]);
    expect(now.failing.map((s) => s.id)).toEqual([1]);
    expect(now.usd).toBe(2);
    expect(callsAt(spans, 50 + FAILED_LED_MS).failing).toEqual([]);
  });
});

describe("gates", () => {
  it("is closed before the park, waiting (with a skip to the recorded approval) until it, approved for a while, then open", () => {
    const g = { park: 1000, approved: 5000, approvedTs: T0 + 60_000, parkTs: T0 };
    expect(gateAt(g, 500).state).toBe("closed");
    // the wait is recorded time: a compressed replay (1 display ms = 10 recorded ms) still reads the true wait
    expect(gateAt(g, 3000, (d) => T0 + (d - 1000) * 10)).toEqual({ state: "waiting", waitedMs: 20_000, skipTo: 5000 });
    // a run still parked, drawn in its final frame (no finite time): no made-up wait
    expect(gateAt({ ...g, approved: null, approvedTs: null }, Infinity, () => Infinity).waitedMs).toBeNull();
    expect(gateAt(g, 5000 + APPROVED_SIGN_MS - 1).state).toBe("approved");
    expect(gateAt(g, 5000 + APPROVED_SIGN_MS).state).toBe("open");
    expect(gateAt({ park: 1000, approved: null, approvedTs: null, parkTs: null }, 9000)).toEqual({ state: "waiting", waitedMs: 8000, skipTo: null });
  });
});

describe("verdicts", () => {
  const v = (at: number, verdict: TimedVerdict["verdict"], lane: string | null = "A", unreachable = false): TimedVerdict => ({ at, ts: T0 + at, verdict, lane, unreachable });

  it("re-stamps every RESTAMP_MS through a long burst, so a 5 s chain is several strikes, not one", () => {
    const chain = Array.from({ length: 20 }, (_, i) => v(i * 80, i % 7 === 3 ? "withheld" : "supported"));
    const beats = stampBeats(chain);
    expect(beats.length).toBe(Math.ceil((19 * 80 + 1) / RESTAMP_MS));
    expect(beats.reduce((n, b) => n + b.total, 0)).toBe(20);
    expect(beats[0]?.counts.withheld).toBe(1);
    // history (already in place) never strikes
    expect(stampBeats([v(-Infinity, "supported")])).toEqual([]);
  });

  it("tallies by a time, per rival, with unattributed verdicts only in the overall count", () => {
    const list = [v(0, "supported"), v(10, "withheld", "B", true), v(20, "partly", null), v(30, "supported")];
    expect(tallyAt(list, 25)).toEqual({ supported: 1, partly: 1, withheld: 1, unreachable: 1 });
    expect(tallyAt(list, 100, "A")).toEqual({ supported: 2, partly: 0, withheld: 0, unreachable: 0 });
    expect(tallyAt(list, 100, null)).toEqual({ supported: 0, partly: 1, withheld: 0, unreachable: 0 });
  });
});

describe("the replay anchors", () => {
  it("anchors gate parks and approvals, lane lines, verdicts and model calls, so a late decision keeps its recorded time", () => {
    const history = { edges: {}, fetches: [], verifies: [], parks: [{ seq: 9, ts: T0 + 1000, state: "awaiting_decision" }], errors: [], lastSeq: 9 } as RunHistory;
    const keys = towerWarpKeys({ ...EMPTY_TOWER, lines: { A: [{ seq: 1, ts: T0 + 10, text: "x" }] }, verdicts: [{ seq: 2, ts: T0 + 20, verdict: "supported", unreachable: false, lane: null }] }, [call({})], history, {
      h1: { at: new Date(T0 + 500).toISOString() },
      h2: { at: new Date(T0 + 30 * 60_000).toISOString() },
    }).map((k) => k.t);
    expect(keys).toEqual(expect.arrayContaining([T0 + 10, T0 + 20, T0 + 8000, T0 + 10_000, T0 + 1000, T0 + 500, T0 + 30 * 60_000]));
  });
});

describe("the log reveals each item at its own time", () => {
  it("a verdict batch counts only the verdicts recorded by the frame; a call batch only the calls started, failures only once ended", () => {
    const verdicts: TimedVerdict[] = [0, 80, 160].map((at, i) => ({ at, ts: T0 + at, verdict: i === 2 ? "withheld" : "supported", lane: null, unreachable: false }));
    const spans = [span({ id: 0, start: 0, end: 50, ok: true }), span({ id: 1, endpoint: "b", start: 30, end: 400, ok: false })];
    const at = (t: number) => logRevealAt({ verdicts, spans }, t);
    expect(at(90).verdicts).toEqual({ supported: 2, partly: 0, withheld: 0, unreachable: 0, total: 2 });
    expect(at(200).verdicts.total).toBe(3);
    expect(at(10).calls).toEqual({ started: 1, failed: 0, endpoints: ["a"] });
    expect(at(100).calls).toEqual({ started: 2, failed: 0, endpoints: ["a", "b"] });
    expect(at(400).calls).toEqual({ started: 2, failed: 1, endpoints: ["a", "b"] });
  });
});

describe("the lift under reduced motion", () => {
  it("stands at the floor nearest the cabin, whatever floor it starts from", () => {
    const rows = [{ floor: 100 }, { floor: 200 }, { floor: 300 }];
    expect(nearestFloor(rows, 140)).toBe(100);
    expect(nearestFloor(rows, 260)).toBe(300);
    expect(nearestFloor(rows, 199.9)).toBe(200);
    expect(nearestFloor([], 123)).toBe(123);
  });
});

describe("a stamp beat as of a frame", () => {
  it("counts only the verdicts recorded by the frame's time, never the whole batch at its first verdict", () => {
    const verdicts: TimedVerdict[] = [0, 80, 160].map((at, i) => ({ at, ts: T0 + at, verdict: i === 2 ? "withheld" : "supported", lane: null, unreachable: false }));
    const [beat] = stampBeats(verdicts);
    expect(beat).toBeDefined();
    if (!beat) return;
    expect(beatAt(beat, verdicts, 0)).toMatchObject({ total: 1, counts: { supported: 1, partly: 0, withheld: 0 } });
    expect(beatAt(beat, verdicts, 100)).toMatchObject({ total: 2 });
    expect(beatAt(beat, verdicts, 500)).toMatchObject({ total: 3, counts: { supported: 2, partly: 0, withheld: 1 } });
  });
});

describe("the final frame of a run still parked", () => {
  it("measures an open wait to the wall clock since the recorded park, never to the replay's last key", () => {
    const replayBack = (d: number) => (Number.isFinite(d) ? T0 + d : T0 + 6000);
    const g = { park: 1000, approved: null, approvedTs: null, parkTs: T0 + 1000 };
    const wall = T0 + 1000 + 25 * 60_000;
    expect(gateAt(g, Infinity, finalBack(replayBack, wall)).waitedMs).toBe(25 * 60_000);
    // no wall clock yet: unknown, not a frozen 6 s
    expect(gateAt(g, Infinity, finalBack(replayBack, null)).waitedMs).toBeNull();
    // a finite frame time still reads the replay's own mapping
    expect(finalBack(replayBack, wall)(2000)).toBe(T0 + 2000);
  });
});

describe("a model-call log row as of a frame", () => {
  it("names only the endpoints of calls started by then, and turns red only once a call has failed", () => {
    const spans = [span({ id: 0, endpoint: "a", start: 0, end: 50 }), span({ id: 1, endpoint: "late", start: 300, end: 900, ok: false })];
    const rows = [callLogRow("S4|0", spans)];
    const early = logAt(rows, 10)[0];
    expect(early?.text).toBe("1 model call started (a)");
    expect(early?.tone).toBe("plain");
    expect(logAt(rows, 400)[0]?.text).toBe("2 model calls started (a, late)");
    expect(logAt(rows, 400)[0]?.tone).toBe("plain");
    expect(logAt(rows, 900)[0]).toMatchObject({ text: "2 model calls started (a, late), 1 failed", tone: "danger" });
  });
});

describe("a team's joined row as of a frame", () => {
  it("counts only the cards recorded by then, never the team's final size", () => {
    const card = (agentId: string) => ({ agentId, name: agentId, role: "pricing", group: "g", groupLabel: "Acme", stage: "S9", skills: [], reads: "" });
    const view = {
      cards: { a: card("a"), b: card("b"), c: card("c") },
      cardSeen: { a: { seq: 1, ts: new Date(T0 + 1000).toISOString() }, b: { seq: 2, ts: new Date(T0 + 2000).toISOString() }, c: { seq: 3, ts: new Date(T0 + 3000).toISOString() } },
      groups: [{ id: "g", label: "Acme", kind: "rival", agents: [card("a"), card("b"), card("c")] }],
      messages: [],
      board: null,
      boardSeen: null,
    };
    const inputs = { view, record: { lanes: [], fetches: [], verifies: [], stages: [], parks: [], notes: [], lastSeq: 3 }, tower: EMPTY_TOWER, history: null, approvals: { h1: null, h2: null }, calls: null };
    const plan = { pods: [], seats: {}, order: [], byAgent: {} };
    const rows = buildLog(inputs as never, plan as never, clock, 0, [], [], { h1: { park: null, approved: null, approvedTs: null, parkTs: null }, h2: { park: null, approved: null, approvedTs: null, parkTs: null } });
    expect(logAt(rows, clock.at(T0 + 1500))[0]?.text).toBe("Acme capture team joined (1 agent)");
    expect(logAt(rows, clock.at(T0 + 3000))[0]?.text).toBe("Acme capture team joined (3 agents)");
  });
});
