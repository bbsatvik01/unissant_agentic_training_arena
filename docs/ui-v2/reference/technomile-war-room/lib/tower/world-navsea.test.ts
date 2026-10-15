/**
 * The Bid Tower's world functions over the recorded NAVSEA SSG run (eb3c3363) and small hand-made cases: the run's
 * bounds, the riser, the gates, the sky's phase, the step strip, the lane lines and the event log.
 */
import { describe, expect, it } from "vitest";

import type { RunHistory } from "@/lib/pipeline/rail";

import { navseaTower } from "../__fixtures__/tower-runs";

import { EMPTY_TOWER } from "./record";
import {
  buildLog,
  clockLabel,
  exactClock,
  gateSpans,
  laneLineAt,
  LEAD_MS,
  logAt,
  phaseAt,
  rackSlots,
  riserRows,
  runBounds,
  runningStep,
  seconds,
  stageName,
  stageRows,
  stepStripAt,
  timedVerdicts,
  type CallSpan,
  type GateSpan,
  type TowerInputs,
} from "./world";

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing value");
  return v;
}

const run = navseaTower();
const { model, inputs, layout, sched, inspection, raw } = run;
const NO_GATE: GateSpan = { park: null, approved: null, approvedTs: null, parkTs: null };

describe("the run's bounds", () => {
  it("runs from the first recorded moment to the decision, the inspector's own duration less the time before S0", () => {
    const b = must(runBounds(inputs));
    expect(b.end).toBe(Date.parse(must(raw.approvals.find((a) => a.gate === "h2")).createdAt));
    expect(b.start).toBeLessThanOrEqual(must(inputs.tower.first).ts);
    expect(b.start).toBeGreaterThanOrEqual(Date.parse(inspection.run.createdAt ?? ""));
  });

  it("runs on to a run error recorded after everything else", () => {
    const b = must(runBounds(inputs));
    const history = { ...must(inputs.history), errors: [{ seq: 99_999, ts: b.end + 5000, message: "late failure", code: "late" }] };
    expect(runBounds({ ...inputs, history })).toEqual({ start: b.start, end: b.end + 5000 });
  });

  it("is null before anything is recorded", () => {
    const empty: TowerInputs = {
      view: { ...inputs.view, messages: [], cardSeen: {}, boardSeen: null },
      record: { ...inputs.record, stages: [], fetches: [], verifies: [] },
      tower: EMPTY_TOWER,
      history: null,
      approvals: { h1: null, h2: null },
      calls: null,
    };
    expect(runBounds(empty)).toBeNull();
    // a call with no recorded time adds nothing
    expect(runBounds({ ...empty, calls: [{ ...must(inspection.calls[0]), createdAt: null }] })).toBeNull();
  });
});

describe("the riser and the machine room", () => {
  it("draws each stage's model time from its own floor", () => {
    expect(stageRows(layout, "S2")).toEqual([layout.ground]);
    expect(stageRows(layout, "S4")).toEqual([layout.basement]);
    expect(stageRows(layout, "S5")).toEqual([layout.basement]);
    expect(stageRows(layout, "S8")).toEqual([layout.ground]);
    expect(stageRows(layout, "S9")).toEqual([layout.upper, ...layout.rivalRows]);
    expect(stageRows(layout, "S10")).toEqual([layout.roof]);
    expect(stageRows(layout, "S13")).toEqual([layout.roof]);
    expect(stageRows(layout, "nope")).toEqual([layout.ground]);
  });

  it("lights the rows drawing model time now, top down, once each", () => {
    const span = (stage: string) => ({ stage }) as CallSpan;
    expect(riserRows(layout, [span("S10"), span("S4"), span("S4")])).toEqual([layout.roof, layout.basement]);
    expect(riserRows(layout, [])).toEqual([]);
  });

  it("puts the run's three endpoints on their own racks, first seen first", () => {
    expect(model.racks.endpoints).toEqual(["vertex", "jev", "nvidia"]);
    expect(model.racks.rackOf("nvidia")).toBe(2);
    // an endpoint never seen shares the first rack; past the last rack, the last
    expect(model.racks.rackOf("other")).toBe(0);
    const many = Array.from({ length: 8 }, (_, i) => ({ id: i, endpoint: `e${i}`, stage: "S4", start: i, end: i + 1, startTs: i, free: false, ok: true, usd: 0, model: "m" }));
    const plan = rackSlots(many);
    expect(plan.endpoints).toHaveLength(6);
    expect(plan.rackOf("e7")).toBe(5);
  });
});

describe("the gates", () => {
  it("parks H1 at the first plan review park and H2 at the last decision park", () => {
    const parks = must(inputs.history).parks;
    const g = gateSpans(inputs.history, inputs.approvals, run.clock);
    expect(g.h1.parkTs).toBe(parks.filter((p) => p.state === "awaiting_plan_approval")[0]?.ts);
    expect(g.h2.parkTs).toBe(parks.filter((p) => p.state === "awaiting_decision").at(-1)?.ts);
    expect(g.h1.park).toBe(run.clock.at(must(g.h1.parkTs)));
  });

  it("has no park and no approval with no history and nothing approved", () => {
    expect(gateSpans(null, { h1: null, h2: { at: null } }, run.clock)).toEqual({ h1: NO_GATE, h2: NO_GATE });
    expect(gateSpans(null, { h1: { at: "not a time" }, h2: null }, run.clock).h1.approved).toBeNull();
  });
});

describe("the sky and the step strip", () => {
  it("follows the phase of the latest stage started", () => {
    const at = (stage: string) => must(sched.stages.find((s) => s.stage === stage && s.edge === "started")).at;
    expect(phaseAt(sched.stages, 0)).toBe("intake");
    expect(phaseAt(sched.stages, at("S4"))).toBe("research");
    expect(phaseAt(sched.stages, at("S9"))).toBe("wargame");
    expect(phaseAt(sched.stages, at("S12"))).toBe("decide");
    expect(phaseAt([], 1e12)).toBe("intake");
  });

  it("shows a running stage's elapsed time and a finished one's recorded duration", () => {
    const s4 = must(sched.stages.find((s) => s.stage === "S4" && s.edge === "started")).at;
    const strip = stepStripAt(sched.stages, inputs.history, model.gates, s4 + 5000, run.back);
    expect(strip.find((c) => c.id === "S4")).toEqual({ id: "S4", status: "running", label: expect.any(String), ms: 5000 });
    const edge = must(inputs.history?.edges.S3);
    expect(strip.find((c) => c.id === "S3")?.ms).toBe(must(edge.end) - must(edge.start));
    expect(strip.find((c) => c.id === "S5")?.status).toBe("not_started");
    expect(strip.find((c) => c.id === "H1")).toMatchObject({ status: "approved", ms: must(model.gates.h1.approvedTs) - must(model.gates.h1.parkTs) });
    expect(strip.find((c) => c.id === "H2")).toMatchObject({ status: "not_started", ms: null });
    expect(runningStep(strip)).toBe("S4");
  });

  it("without history, a finished stage reads done over its edges on the clock, and a running one with no time has no elapsed", () => {
    const stages = [
      { at: 1000, stage: "S0" as const, edge: "started" as const },
      { at: 3500, stage: "S0" as const, edge: "finished" as const },
      { at: 4000, stage: "S1" as const, edge: "started" as const },
    ];
    const strip = stepStripAt(stages, null, { h1: NO_GATE, h2: NO_GATE }, 5000);
    expect(strip.find((c) => c.id === "S0")).toMatchObject({ status: "done", ms: 2500 });
    expect(strip.find((c) => c.id === "S1")).toMatchObject({ status: "running", ms: 1000 });
    expect(stepStripAt(stages, null, { h1: NO_GATE, h2: NO_GATE }, 5000, () => NaN).find((c) => c.id === "S1")?.ms).toBeNull();
    expect(runningStep(stepStripAt([], null, { h1: NO_GATE, h2: NO_GATE }, 0))).toBeNull();
  });
});

describe("verdicts and lane lines on the clock", () => {
  it("puts settled verdicts in place at once and the rest at their recorded time, in time order", () => {
    const v = timedVerdicts(inputs.tower, run.clock, 0);
    expect(v.every((x, i) => i === 0 || x.at >= (v[i - 1]?.at ?? -Infinity))).toBe(true);
    const mid = must(inputs.tower.verdicts[100]).seq;
    const settled = timedVerdicts(inputs.tower, run.clock, mid);
    expect(settled.filter((x) => x.at === -Infinity)).toHaveLength(inputs.tower.verdicts.filter((x) => x.seq <= mid).length);
  });

  it("shows a lane's latest activity line by the frame, history at once", () => {
    const lane = "LEIDOS, INC.";
    const lines = must(inputs.tower.lines[lane]);
    const first = must(lines[0]);
    expect(laneLineAt(inputs.tower, lane, run.clock.at, 0, run.clock.at(first.ts) - 1)).toBeNull();
    expect(laneLineAt(inputs.tower, lane, run.clock.at, 0, run.clock.at(first.ts))).toBe(first.text);
    expect(laneLineAt(inputs.tower, lane, run.clock.at, 0, Infinity)).toBe(must(lines.at(-1)).text);
    expect(laneLineAt(inputs.tower, lane, run.clock.at, Number.MAX_SAFE_INTEGER, -Infinity)).toBe(must(lines.at(-1)).text);
    expect(laneLineAt(inputs.tower, "nobody", run.clock.at, 0, Infinity)).toBeNull();
  });
});

describe("the NAVSEA event log", () => {
  const log = model.log;

  it("is in time order, one row per stage edge, fetch, message, card team, stamp beat and gate event", () => {
    expect(log.every((r, i) => i === 0 || r.at >= (log[i - 1]?.at ?? -Infinity))).toBe(true);
    const count = (prefix: string) => log.filter((r) => r.id.startsWith(prefix)).length;
    expect(count("stage:")).toBe(inputs.record.stages.length);
    expect(count("fetch:")).toBe(inputs.record.fetches.length);
    expect(count("msg:")).toBe(inputs.view.messages.length);
    expect(count("cards:")).toBe(inputs.view.groups.length);
    expect(count("stamp:")).toBe(model.beats.length);
    expect(log.filter((r) => /^H[12]:/.test(r.id)).map((r) => r.id)).toEqual(["H1:park", "H1:approved", "H2:park", "H2:approved"]);
    expect(log.filter((r) => r.id.startsWith("calls:")).reduce((n, r) => n + Number(/^(\d+)/.exec(r.text)?.[1]), 0)).toBe(model.spans.length);
  });

  it("words each row from the record", () => {
    const row = (id: string) => must(log.find((r) => r.id === id));
    expect(row("stage:1")).toMatchObject({ step: "S0", text: "Intake started", tone: "plain" });
    expect(row("fetch:36")).toMatchObject({ step: "S4", text: "MANTECH ADVANCED researcher read api.sam.gov (ok)", tone: "plain" });
    expect(row("cards:board").text).toBe("Board joined (3 evaluators)");
    expect(row("cards:red_team").text).toBe("Red team joined (1 agent)");
    expect(row("board")).toMatchObject({ step: "S10", text: "Board scored: A 57%, B 18%, C 5%, D 13%, E 7%", tone: "signal" });
    expect(row("H1:approved").text).toBe("Plan approved");
    expect(row("H2:approved").text).toBe("Decision recorded");
    expect(row("H2:park").text).toBe("Decision: your call, waiting");
    expect(row("msg:s9-KZA5CX3J8KE8-r1-pricing-brief").text).toBe("MANTECH ADVANCED pricing to MANTECH ADVANCED capture lead: brief, 10.2 s model time");
    expect(row("msg:s10-board-management")).toMatchObject({ step: "S10", text: "Evaluator, management to the board: rating, 10.1 s model time" });
    // a finished stage says how long it took; one that finished degraded is a danger row
    const s14 = must(log.find((r) => r.step === "S14" && r.text.startsWith("Check degraded")));
    expect(s14.text).toBe(`Check degraded in ${seconds(must(inputs.history?.edges.S14?.end) - must(inputs.history?.edges.S14?.start))}`);
    expect(s14.tone).toBe("danger");
    const failedFetch = must(log.find((r) => r.id.startsWith("fetch:") && r.text.endsWith("(error)")));
    expect(failedFetch.tone).toBe("danger");
    expect(log.some((r) => r.id.startsWith("calls:") && r.text.endsWith(", 1 failed") && r.tone === "danger")).toBe(true);
  });

  it("grows a stamp row's count and a team's size as each is recorded", () => {
    const stamp = must(log.find((r) => r.id === "stamp:0"));
    expect(logAt([stamp], stamp.at)[0]?.text).toMatch(/^\d+ claims? checked: \d+ supported/);
    expect(logAt([stamp], Infinity)[0]?.text).toBe(stamp.text);
    expect(logAt([stamp], stamp.at - 1)).toEqual([]);
    const board = must(log.find((r) => r.id === "cards:board"));
    expect(logAt([board], board.at)[0]?.text).toBe("Board joined (1 evaluator)");
  });

  it("logs a run error with its code, a message not run for budget, a failed one, and an unreachable source", () => {
    const T0 = Date.parse("2026-10-05T04:00:00Z");
    const clock = exactClock(T0);
    const card = (agentId: string, group: string, role = "pricing") => ({ agentId, name: `${agentId} name`, role, group, groupLabel: "Acme Corp", stage: "S9", skills: [], reads: "" });
    const msg = (messageId: string, state: string, from: string, to: string[], round: number) => ({
      messageId,
      kind: "brief",
      state,
      from,
      to,
      round,
      seq: 5,
      ts: new Date(T0 + 1000).toISOString(),
      citations: [],
      dropped: 0,
      data: {},
      usage: { latencyMs: 0 },
    });
    const view = {
      ...inputs.view,
      cards: { p: card("p", "g"), r: card("r", "red_team", "red_team") },
      cardSeen: {},
      groups: [],
      messages: [msg("m1", "rejected", "p", ["r", "ghost"], 2), msg("m2", "failed", "r", ["board"], 4), { ...msg("m3", "completed", "p", ["r"], 1), ts: "not a time" }],
      board: null,
      boardSeen: null,
    };
    const history = { edges: {}, fetches: [], verifies: [], parks: [], errors: [{ seq: 7, ts: T0 + 2000, code: "E42" }, { seq: 8, ts: T0 + 3000, code: null }], lastSeq: 8 } as unknown as RunHistory;
    const verdicts = [
      { at: 100, ts: T0, verdict: "supported" as const, unreachable: true, lane: null },
      { at: 200, ts: T0, verdict: "withheld" as const, unreachable: false, lane: null },
    ];
    const beats = [{ id: "stamp:0", start: 100, counts: { supported: 1, partly: 0, withheld: 1 }, unreachable: 1, total: 2 }];
    const rows = buildLog({ ...inputs, view, history, tower: EMPTY_TOWER, record: { ...inputs.record, stages: [], fetches: [] } } as never, run.plan, clock, 0, [], beats, { h1: NO_GATE, h2: NO_GATE }, verdicts);
    const text = (id: string) => rows.find((r) => r.id === id)?.text;
    expect(text("msg:m1")).toBe("Acme Corp pricing to r name, ghost: brief (not run: budget spent)");
    expect(rows.find((r) => r.id === "msg:m2")).toMatchObject({ step: "S10", text: "R name to the board: brief (failed)", tone: "danger" });
    expect(rows.some((r) => r.id === "msg:m3")).toBe(false);
    expect(text("error:7")).toBe("Run error (E42)");
    expect(text("error:8")).toBe("Run error");
    const stamp = must(rows.find((r) => r.id === "stamp:0"));
    expect(stamp.text).toBe("2 claims checked: 1 supported, 1 withheld, 1 source unreachable");
    expect(stamp.tone).toBe("danger");
    expect(logAt([stamp], 150)[0]).toMatchObject({ text: "1 claim checked: 1 supported, 1 source unreachable", tone: "plain" });
  });
});

describe("words and times", () => {
  it("names the stages, and passes an unknown one through", () => {
    expect(["S0", "S4", "S8", "S15", "S99"].map(stageName)).toEqual(["Intake", "Evidence", "Price to win", "Export", "S99"]);
  });

  it("reads durations in seconds and display times as m:ss.s from the run's first moment", () => {
    expect(seconds(10_240)).toBe("10.2 s");
    expect(seconds(-5)).toBe("0.0 s");
    expect(clockLabel(LEAD_MS + 75_250, LEAD_MS)).toBe("1:15.3");
    expect(clockLabel(LEAD_MS + 4_000, LEAD_MS)).toBe("0:04.0");
    expect(clockLabel(0, LEAD_MS)).toBe("0:00.0");
    expect(clockLabel(Infinity, 0)).toBe("--:--");
  });
});
