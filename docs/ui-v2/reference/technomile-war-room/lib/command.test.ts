import { describe, expect, it } from "vitest";

import type { JsonPatchOp, RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";

import {
  fetchesAt,
  foldCommand,
  formatHeld,
  formatTime,
  formatTPlus,
  formatWall,
  gatesAt,
  holdsOf,
  isCommandEvent,
  lineAt,
  linesAt,
  notableAt,
  runClock,
  shownAt,
  stageStatesAt,
  stampBeats,
  stampCountAt,
  tallyAt,
  unescapePointer,
  type DisplayCtx,
} from "./command";
import { liveClock, replayClock, STAMP_GAP_MS, STAMP_MS, type BeatClock } from "./office";

const T0 = Date.parse("2026-10-04T02:48:10.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Envelopes with explicit idem keys (the verdict pairing reads them). */
function env(seq: number, at: number, event: RunEvent, idemKey = `k${seq}`): RunEventEnvelope {
  return { seq, runId: "r", idemKey, ts: iso(at), event };
}
const delta = (ops: JsonPatchOp[]): RunEvent => ({ type: "STATE_DELTA", delta: ops });
const act = (activityType: string, content: unknown) => ({ type: "ACTIVITY_SNAPSHOT", messageId: "m", activityType, content }) as unknown as RunEvent;
const fetchEv = (subject: string, host: string, status: "ok" | "blocked" | "error" = "ok", tier = "other") =>
  act("fetch", { subject, evidenceId: `${host}#1`, host, sourceType: "web.page", tier, status, column: "corporate" });
const verifyEv = (claimId: string, verdict: "supported" | "partially_supported" | "unsupported", claim = `claim ${claimId}`) =>
  act("verify", { claimId, claim, verdict, sourceUnreachable: false });
const cell = (subject: string, column: string) => ({ subject, column, state: "verified", rows: 3, supported: 1, partial: 0, unsupported: 0 });
const started = (stage: string): RunEvent => ({ type: "STEP_STARTED", stepName: stage }) as RunEvent;
const finished = (stage: string, status?: string): RunEvent => ({ type: "STEP_FINISHED", stepName: stage, ...(status ? { status } : {}) }) as RunEvent;
const parked = (state: string): RunEvent => ({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { state } });
const snapshot = (opportunity: string): RunEvent => ({
  type: "STATE_SNAPSHOT",
  snapshot: {
    runId: "r",
    opportunity,
    lanes: {},
    laneOrder: [],
    columns: [],
    cells: {},
    cost: { usd: 0, capUsd: 1 },
    counters: { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 },
    stages: {},
  } satisfies WarRoomSnapshot,
});

const VKEY = (lane: string, claim: string) => `g0:execute:S7:${lane}:verdict:${claim}`;

/** A small run: S0, the H1 park (recorded twice), S4 with fetches, S6 lines, an S7 burst, the H2 park. */
function run(): RunEventEnvelope[] {
  return [
    env(1, T0, started("S0")),
    env(2, T0 + 300, finished("S0")),
    env(3, T0 + 27_000, parked("awaiting_plan_approval")),
    env(4, T0 + 27_200, parked("awaiting_plan_approval")),
    env(5, T0 + 42_000, started("S4")),
    env(6, T0 + 42_100, snapshot("Passport Printers Support")),
    env(7, T0 + 42_200, fetchEv("CGI FEDERAL INC.", "api.sam.gov", "error", "federal_primary")),
    env(8, T0 + 42_300, fetchEv("AKUMEN, INC.", "api.sam.gov")),
    env(9, T0 + 43_000, fetchEv("CGI FEDERAL INC.", "www.cgi.com", "ok", "company_owned")),
    env(10, T0 + 44_000, fetchEv("CGI FEDERAL INC.", "www.gao.gov", "blocked", "federal_primary")),
    env(11, T0 + 60_000, finished("S4")),
    env(12, T0 + 61_000, started("S6")),
    env(13, T0 + 61_100, delta([{ op: "replace", path: "/lanes/CGI FEDERAL INC./activity", value: "Drafting the dossier (attempt 1 of 3) for CGI FEDERAL INC." }])),
    env(14, T0 + 70_000, delta([{ op: "replace", path: "/lanes/CGI FEDERAL INC./activity", value: "Gate answered REJECT; redrafting for CGI FEDERAL INC." }, { op: "replace", path: "/cost/usd", value: 0.1 }])),
    env(15, T0 + 80_000, finished("S6", "degraded")),
    env(16, T0 + 80_100, started("S7")),
    env(17, T0 + 80_200, verifyEv("c1", "supported"), VKEY("TRK", "c1")),
    env(18, T0 + 80_210, delta([{ op: "replace", path: "/cells/CGI FEDERAL INC.:labor_rates", value: cell("CGI FEDERAL INC.", "labor_rates") }, { op: "replace", path: "/counters/supported", value: 1 }]), `${VKEY("TRK", "c1")}:delta`),
    env(19, T0 + 80_220, verifyEv("a1", "supported"), VKEY("L48", "a1")),
    env(20, T0 + 80_230, delta([{ op: "replace", path: "/cells/AKUMEN, INC.:corporate", value: cell("AKUMEN, INC.", "corporate") }]), `${VKEY("L48", "a1")}:delta`),
    env(21, T0 + 80_240, verifyEv("c2", "supported"), VKEY("TRK", "c2")),
    env(22, T0 + 80_250, delta([{ op: "replace", path: "/cells/CGI FEDERAL INC.:past_performance", value: cell("CGI FEDERAL INC.", "past_performance") }]), `${VKEY("TRK", "c2")}:delta`),
    env(23, T0 + 80_300, verifyEv("c3", "unsupported", "CGI holds award X."), VKEY("TRK", "c3")),
    env(24, T0 + 80_310, delta([{ op: "replace", path: "/cells/CGI FEDERAL INC.:past_performance", value: cell("CGI FEDERAL INC.", "past_performance") }, { op: "replace", path: "/cells/CGI FEDERAL INC.:vehicles", value: cell("CGI FEDERAL INC.", "vehicles") }]), `${VKEY("TRK", "c3")}:delta`),
    // a verdict whose delta carries counters only: never guessed
    env(25, T0 + 80_400, verifyEv("x1", "partially_supported"), VKEY("ZZZ", "x1")),
    env(26, T0 + 80_410, delta([{ op: "replace", path: "/counters/partial", value: 1 }]), `${VKEY("ZZZ", "x1")}:delta`),
    // a verdict with no delta at all
    env(27, T0 + 80_500, verifyEv("x2", "supported"), VKEY("ZZZ", "x2")),
    env(28, T0 + 86_000, finished("S7")),
    env(29, T0 + 594_635, parked("awaiting_decision")),
  ];
}

const exact: BeatClock = { at: (t) => t, typingStart: (t, l) => t - l };
const FINAL: DisplayCtx = { clock: exact, settledSeq: 0 };

describe("foldCommand", () => {
  it("keeps the run start, the opportunity, fetches, lines, stages, parks and errors", () => {
    const cmd = foldCommand(run());
    expect(cmd.runStart).toBe(T0);
    expect(cmd.opportunity).toBe("Passport Printers Support");
    expect(cmd.snapshot).toEqual({ seq: 6, ts: T0 + 42_100 });
    expect(cmd.lastSeq).toBe(29);
    expect(cmd.fetches.map((f) => [f.lane, f.host, f.status, f.tier])).toEqual([
      ["CGI FEDERAL INC.", "api.sam.gov", "error", "federal_primary"],
      ["AKUMEN, INC.", "api.sam.gov", "ok", "other"],
      ["CGI FEDERAL INC.", "www.cgi.com", "ok", "company_owned"],
      ["CGI FEDERAL INC.", "www.gao.gov", "blocked", "federal_primary"],
    ]);
    expect(cmd.fetches[0]).toMatchObject({ label: "CGI FEDERAL INC.", evidenceId: "api.sam.gov#1", sourceType: "web.page", column: "corporate" });
    expect(cmd.lines.map((l) => [l.lane, l.text])).toEqual([
      ["CGI FEDERAL INC.", "Drafting the dossier (attempt 1 of 3) for CGI FEDERAL INC."],
      ["CGI FEDERAL INC.", "Gate answered REJECT; redrafting for CGI FEDERAL INC."],
    ]);
    expect(cmd.stages.map((s) => `${s.stage}:${s.edge}:${s.status ?? "-"}`)).toEqual([
      "S0:started:-",
      "S0:finished:done",
      "S4:started:-",
      "S4:finished:done",
      "S6:started:-",
      "S6:finished:degraded",
      "S7:started:-",
      "S7:finished:done",
    ]);
    expect(cmd.errors).toEqual([]);
  });

  it("pairs each verdict with its ':delta' frame and never guesses a rival", () => {
    const cmd = foldCommand(run());
    const by = Object.fromEntries(cmd.verdicts.map((v) => [v.claimId, v]));
    expect(by.c1).toMatchObject({ lane: "CGI FEDERAL INC.", verdict: "supported", columns: ["labor_rates"] });
    expect(by.a1).toMatchObject({ lane: "AKUMEN, INC.", columns: ["corporate"] });
    expect(by.c3).toMatchObject({ lane: "CGI FEDERAL INC.", verdict: "withheld", claim: "CGI holds award X.", columns: ["past_performance", "vehicles"] });
    // counters only, and no delta at all: unattributed
    expect(by.x1).toMatchObject({ lane: null, verdict: "partly", columns: [] });
    expect(by.x2).toMatchObject({ lane: null, columns: [] });
  });

  it("collapses consecutive parks at the same gate and keeps the first time", () => {
    const cmd = foldCommand(run());
    expect(cmd.parks).toEqual([
      { seq: 3, ts: T0 + 27_000, gate: "H1" },
      { seq: 29, ts: T0 + 594_635, gate: "H2" },
    ]);
  });

  it("keeps a second park at a gate the run worked after", () => {
    const cmd = foldCommand([env(1, T0, parked("awaiting_plan_approval")), env(2, T0 + 10, started("S4")), env(3, T0 + 20, parked("awaiting_plan_approval")), env(4, T0 + 30, parked("awaiting_review"))]);
    expect(cmd.parks.map((p) => `${p.gate}@${p.seq}`)).toEqual(["H1@1", "H1@3", "H2@4"]);
  });

  it("ignores other run states, records errors, drops duplicates and unreadable times, reads any order", () => {
    const envs = [
      env(3, T0 + 3, { type: "RUN_ERROR", message: "phase failed (worker_lost)", code: "worker_lost" }),
      env(2, T0 + 2, parked("decided")),
      env(1, T0, started("S0")),
      env(1, T0, started("S0")),
      { ...env(4, T0, started("S1")), ts: "not a time" },
      env(5, T0 + 5, { type: "RUN_ERROR", message: "phase failed" }),
    ];
    const cmd = foldCommand(envs);
    expect(cmd.parks).toEqual([]);
    expect(cmd.errors).toEqual([
      { seq: 3, ts: T0 + 3, code: "worker_lost", message: "phase failed (worker_lost)" },
      { seq: 5, ts: T0 + 5, code: "unrecorded", message: "phase failed" },
    ]);
    expect(cmd.stages).toHaveLength(1);
    expect(cmd.lastSeq).toBe(5);
  });

  it("is empty before any event", () => {
    const cmd = foldCommand([]);
    expect(cmd).toMatchObject({ runStart: null, opportunity: null, snapshot: null, fetches: [], verdicts: [], lines: [], stages: [], parks: [], errors: [], lastSeq: 0 });
  });

  it("unescapes the lane token (RFC 6901) before folding its key", () => {
    expect(unescapePointer("A~1B~0C")).toBe("A/B~C");
    expect(unescapePointer("~01")).toBe("~1");
    const cmd = foldCommand([env(1, T0, delta([{ op: "replace", path: "/lanes/Smith~1Jones  co/activity", value: "Reading" }, { op: "replace", path: "/lanes/X/status", value: "running" }, { op: "replace", path: "/lanes/Y/activity", value: 3 }]))]);
    expect(cmd.lines).toEqual([{ seq: 1, ts: T0, lane: "SMITH/JONES CO", label: "Smith/Jones  co", text: "Reading" }]);
  });
});

describe("isCommandEvent", () => {
  const e = (event: RunEvent, idemKey = "k") => env(1, T0, event, idemKey);
  it("keeps verdict deltas, lane activity lines, phase ends and errors only", () => {
    expect(isCommandEvent(e(delta([{ op: "replace", path: "/counters/supported", value: 1 }]), "g0:execute:S7:TRK:verdict:c1:delta"))).toBe(true);
    expect(isCommandEvent(e(delta([{ op: "replace", path: "/counters/supported", value: 1 }]), "g0:execute:S4:TRK:fetch:1:delta"))).toBe(false);
    expect(isCommandEvent(e(delta([{ op: "replace", path: "/lanes/A/activity", value: "x" }]), "g0:execute:S4:TRK:fetch:1:delta"))).toBe(true);
    expect(isCommandEvent(e(delta([{ op: "replace", path: "/lanes/A/status", value: "running" }])))).toBe(false);
    expect(isCommandEvent(e(delta([{ op: "replace", path: "/stages/S4", value: "running" }])))).toBe(false);
    expect(isCommandEvent(e(parked("awaiting_decision")))).toBe(true);
    expect(isCommandEvent(e({ type: "RUN_ERROR", message: "x" }))).toBe(true);
    expect(isCommandEvent(e(started("S4")))).toBe(false);
  });
});

describe("values at a display time", () => {
  const cmd = foldCommand(run());
  it("counts an item once its display time passes, or at once when it is history", () => {
    const item = { seq: 9, ts: 100 };
    expect(shownAt(item, 99, { clock: exact, settledSeq: 0 })).toBe(false);
    expect(shownAt(item, 100, { clock: exact, settledSeq: 0 })).toBe(true);
    expect(shownAt(item, 0, { clock: exact, settledSeq: 9 })).toBe(true);
  });

  it("files a lane's fetches newest first with counts by status and tier", () => {
    const f = fetchesAt(cmd, "CGI FEDERAL INC.", T0 + 43_500, FINAL);
    expect(f.cards.map((c) => c.host)).toEqual(["www.cgi.com", "api.sam.gov"]);
    expect(f.counts).toEqual({ total: 2, ok: 1, blocked: 0, error: 1 });
    expect(f.tiers).toEqual({ federal_primary: 1, company_owned: 1 });
    const all = fetchesAt(cmd, "CGI FEDERAL INC.", Infinity, FINAL);
    expect(all.counts).toEqual({ total: 3, ok: 1, blocked: 1, error: 1 });
    expect(fetchesAt(cmd, "NOBODY", Infinity, FINAL).counts.total).toBe(0);
  });

  it("tallies verdicts per rival plus the unattributed ones", () => {
    const tally = tallyAt(cmd, Infinity, FINAL);
    expect(tally.lanes["CGI FEDERAL INC."]).toEqual({ supported: 2, partly: 0, withheld: 1 });
    expect(tally.lanes["AKUMEN, INC."]).toEqual({ supported: 1, partly: 0, withheld: 0 });
    expect(tally.unattributed).toBe(2);
    expect(tally.total).toEqual({ supported: 4, partly: 1, withheld: 1 });
    const early = tallyAt(cmd, T0 + 80_225, FINAL);
    expect(early.lanes["CGI FEDERAL INC."]).toEqual({ supported: 1, partly: 0, withheld: 0 });
    expect(early.total.supported).toBe(2);
  });

  it("names the latest withheld or partly claim of a rival, changing at most every step", () => {
    expect(notableAt(cmd, "CGI FEDERAL INC.", T0 + 80_250, FINAL)).toBeNull();
    expect(notableAt(cmd, "CGI FEDERAL INC.", Infinity, FINAL)?.claim).toBe("CGI holds award X.");
    // quantized to 500 ms steps: the 80 300 verdict shows from the 80 500 step on
    expect(notableAt(cmd, "CGI FEDERAL INC.", T0 + 80_400, FINAL, 500)).toBeNull();
    expect(notableAt(cmd, "CGI FEDERAL INC.", T0 + 80_500, FINAL, 500)?.claimId).toBe("c3");
  });

  it("reads a lane's latest recorded line", () => {
    expect(lineAt(cmd, "CGI FEDERAL INC.", T0 + 61_000, FINAL)).toBeNull();
    expect(lineAt(cmd, "CGI FEDERAL INC.", T0 + 65_000, FINAL)?.text).toMatch(/^Drafting/);
    expect(lineAt(cmd, "CGI FEDERAL INC.", Infinity, FINAL)?.text).toMatch(/^Gate answered REJECT/);
    expect(linesAt(cmd, Infinity, FINAL)["CGI FEDERAL INC."]?.seq).toBe(14);
  });

  it("groups each rival's verdicts into stamp beats on the display clock", () => {
    const beats = stampBeats(cmd, FINAL);
    const cgi = beats.filter((b) => b.lane === "CGI FEDERAL INC.");
    // c1 and c2 are 40 ms apart: one beat; c3 changes the verdict: a second stamp
    expect(cgi.map((b) => [b.verdict, b.count])).toEqual([
      ["supported", 2],
      ["withheld", 1],
    ]);
    expect(cgi[0]).toMatchObject({ start: T0 + 80_200, last: T0 + 80_240, end: T0 + 80_200 + STAMP_MS, fresh: true });
    expect(stampCountAt(cgi[0]!, T0 + 80_220)).toBe(1);
    expect(stampCountAt(cgi[0]!, T0 + 80_240)).toBe(2);
    expect(beats.some((b) => b.lane === null)).toBe(false);
    // further apart than the gap: separate beats
    const spaced = foldCommand([
      env(1, T0, verifyEv("c1", "supported"), VKEY("TRK", "c1")),
      env(2, T0 + 1, delta([{ op: "replace", path: "/cells/A:x", value: cell("A", "x") }]), `${VKEY("TRK", "c1")}:delta`),
      env(3, T0 + STAMP_GAP_MS + 5, verifyEv("c2", "supported"), VKEY("TRK", "c2")),
      env(4, T0 + STAMP_GAP_MS + 6, delta([{ op: "replace", path: "/cells/A:x", value: cell("A", "x") }]), `${VKEY("TRK", "c2")}:delta`),
    ]);
    expect(stampBeats(spaced, FINAL).map((b) => b.count)).toEqual([1, 1]);
    // history does not animate
    expect(stampBeats(spaced, { clock: exact, settledSeq: 4 }).every((b) => !b.fresh)).toBe(true);
  });

  it("states each stage at a display time", () => {
    const s = stageStatesAt(cmd, T0 + 70_000, FINAL);
    expect(s.S0).toMatchObject({ state: "done" });
    expect(s.S4).toMatchObject({ state: "done", start: T0 + 42_000, end: T0 + 60_000 });
    expect(s.S6).toMatchObject({ state: "running", start: T0 + 61_000, end: null });
    expect(s.S7).toBeUndefined();
    expect(stageStatesAt(cmd, Infinity, FINAL).S6).toMatchObject({ state: "degraded" });
  });
});

describe("a run error ends the running stages", () => {
  it("marks a stage still running at a recorded RUN_ERROR as failed, and leaves a stage restarted after it running", () => {
    const err: RunEvent = { type: "RUN_ERROR", message: "boom", code: "x" } as RunEvent;
    const cmd = foldCommand([env(1, T0, started("S5")), env(2, T0 + 1000, err), env(3, T0 + 2000, started("S6"))]);
    expect(stageStatesAt(cmd, T0 + 500, FINAL).S5).toMatchObject({ state: "running", end: null });
    const after = stageStatesAt(cmd, Infinity, FINAL);
    expect(after.S5).toMatchObject({ state: "failed", end: T0 + 1000 });
    expect(after.S6).toMatchObject({ state: "running" });
  });
});

describe("gates and the run clock", () => {
  const cmd = foldCommand(run());
  const approvals = { h1: { at: iso(T0 + 39_926) }, h2: { at: iso(T0 + 663_600) } };

  it("holds the H1 gate from its park to its approval, and H2 to its decision", () => {
    expect(holdsOf(cmd, approvals)).toEqual([
      { gate: "H1", start: T0 + 27_000, end: T0 + 39_926, inferred: false },
      { gate: "H2", start: T0 + 594_635, end: T0 + 663_600, inferred: false },
    ]);
  });

  it("ends an unapproved H1 hold when a stage from S4 on starts, and leaves an unapproved H2 hold open", () => {
    expect(holdsOf(cmd, { h1: null, h2: null })).toEqual([
      { gate: "H1", start: T0 + 27_000, end: T0 + 42_000, inferred: true },
      { gate: "H2", start: T0 + 594_635, end: Infinity, inferred: false },
    ]);
  });

  it("stops T+ during holds", () => {
    expect(runClock(cmd, approvals, T0 + 10_000).tPlus).toBe(10_000);
    // inside the H1 hold the clock stands still
    expect(runClock(cmd, approvals, T0 + 35_000).tPlus).toBe(27_000);
    // at the H2 park: 594.635 s minus the 12.926 s H1 hold
    expect(runClock(cmd, approvals, T0 + 594_635).tPlus).toBe(581_709);
    expect(runClock(cmd, approvals, T0 + 663_600).tPlus).toBe(581_709);
    expect(formatTPlus(581_709)).toBe("09:41.7");
    expect(runClock(foldCommand([]), approvals, T0).tPlus).toBeNull();
  });

  it("states each gate at a recorded time", () => {
    expect(gatesAt(cmd, approvals, T0 + 1_000)).toEqual({ H1: { state: "none", parkTs: null, actedTs: null, heldMs: null, inferred: false }, H2: { state: "none", parkTs: null, actedTs: null, heldMs: null, inferred: false } });
    expect(gatesAt(cmd, approvals, T0 + 30_000).H1).toEqual({ state: "waiting", parkTs: T0 + 27_000, actedTs: null, heldMs: 3_000, inferred: false });
    expect(gatesAt(cmd, approvals, T0 + 50_000).H1).toEqual({ state: "approved", parkTs: T0 + 27_000, actedTs: T0 + 39_926, heldMs: 12_926, inferred: false });
    expect(gatesAt(cmd, approvals, Infinity).H2).toEqual({ state: "approved", parkTs: T0 + 594_635, actedTs: T0 + 663_600, heldMs: 68_965, inferred: false });
    expect(gatesAt(cmd, { h1: null, h2: null }, T0 + 50_000).H1).toMatchObject({ state: "approved", actedTs: T0 + 42_000, inferred: true });
    expect(gatesAt(cmd, null, T0 + 600_000).H2).toMatchObject({ state: "waiting", heldMs: 5_365 });
    // an approval recorded without a park the feed read
    expect(gatesAt(foldCommand([]), { h1: { at: iso(T0) }, h2: { at: null } }, T0 + 1).H1).toMatchObject({ state: "approved", parkTs: null, heldMs: null });
  });

  it("formats run time, holds and wall times", () => {
    expect(formatTPlus(0)).toBe("00:00.0");
    expect(formatTPlus(3_725_450)).toBe("1:02:05.5");
    expect(formatTPlus(59_960)).toBe("01:00.0");
    expect(formatHeld(12_926)).toBe("0:12.9");
    expect(formatHeld(68_965)).toBe("1:09.0");
    const at = Date.parse("2026-10-04T02:48:49.998Z");
    const base = new Date(at + 2).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    expect(formatWall(at)).toBe(`${base}.0`);
    expect(formatWall(NaN)).toBe("");
    expect(formatTime(at)).toBe(new Date(at).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(formatTime(Infinity)).toBe("");
  });
});

describe("recorded time at a display time", () => {
  it("inverts the replay clock piecewise and monotonically", () => {
    const keys = [{ t: T0 }, { t: T0 + 1_000, minStep: 300 }, { t: T0 + 60_000 }, { t: T0 + 61_000, minStep: 2_000 }];
    const c = replayClock(keys);
    for (const t of [T0, T0 + 500, T0 + 1_000, T0 + 2_000, T0 + 59_999, T0 + 60_500, T0 + 61_000, T0 + 63_000]) {
      expect(c.recordedAt(c.at(t))).toBeCloseTo(t, 3);
    }
    let prev = -Infinity;
    for (let d = 0; d <= c.span + 2_000; d += 37) {
      const r = c.recordedAt(d);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    // past the end it saturates where the clock does
    expect(c.recordedAt(c.span + 10_000_000)).toBe(T0 + 61_000 + 6_000);
    expect(c.recordedAt(-5)).toBe(T0 - 600 * 8);
    expect(Number.isNaN(replayClock([]).recordedAt(10))).toBe(true);
  });

  it("inverts the live clock", () => {
    const c = liveClock(250);
    expect(c.recordedAt(c.at(T0))).toBe(T0);
  });
});
