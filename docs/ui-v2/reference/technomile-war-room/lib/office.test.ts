import { describe, expect, it } from "vitest";

import type { AgentCard, AgentMessage, BoardResult, RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";

import {
  buildSchedule,
  depth,
  enterPath,
  feedAction,
  ENTER_MS,
  FLIGHT_MS,
  foldOffice,
  frameAt,
  iso,
  isOfficeEvent,
  liveClock,
  LIVE_LAG_MS,
  LIVE_TYPING_MS,
  MIN_BROWSE_MS,
  NEW_SYNC,
  noteArrival,
  planOffice,
  podCentres,
  podKey,
  pointAlong,
  isPresent,
  REACT_MS,
  recipientSeats,
  replayClock,
  REPLAY_LEAD_MS,
  SEND_MS,
  sentFirst,
  stageAt,
  STAMP_MS,
  TRIP_JOIN_MS,
  tripPath,
  WALK_MS,
  warpKeys,
  type BeatClock,
  type LiveSync,
  type OfficeRecord,
} from "./office";
import { foldSwarm, type SwarmView } from "./swarm";

const T0 = Date.parse("2026-10-04T02:48:00Z");
const iso8601 = (ms: number) => new Date(ms).toISOString();

let n = 0;
function env(event: RunEvent, at: number, seq?: number): RunEventEnvelope {
  n += 1;
  return { seq: seq ?? n, runId: "r", idemKey: `k${n}`, ts: iso8601(at), event };
}
const act = (activityType: string, content: unknown) => ({ type: "ACTIVITY_SNAPSHOT", messageId: `a${n}`, activityType, content }) as unknown as RunEvent;
const fetchEv = (subject: string, host: string, status: "ok" | "blocked" | "error" = "ok") =>
  act("fetch", { subject, evidenceId: "e#1", host, sourceType: "web", tier: "other", status, column: "corporate" });
const verifyEv = (verdict: "supported" | "partially_supported" | "unsupported") => act("verify", { claimId: "c", claim: "x", verdict, sourceUnreachable: false });

const snapshot = (lanes: { subject: string; home?: boolean }[]): WarRoomSnapshot => ({
  runId: "r",
  opportunity: "o",
  lanes: Object.fromEntries(lanes.map((l) => [l.subject, { subject: l.subject, label: l.subject, home: l.home ?? false, status: "queued", fetches: 0, activity: "" }])),
  laneOrder: lanes.map((l) => l.subject),
  columns: [],
  cells: {},
  cost: { usd: 0, capUsd: 1 },
  counters: { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 },
  stages: {},
});

const card = (agentId: string, role: string, group: string, groupLabel: string): AgentCard => ({
  agentId,
  name: `${role} ${groupLabel}`,
  role,
  group,
  groupLabel,
  stage: group === "board" ? "S10" : "S9",
  skills: [],
  reads: "accepted claims",
});

const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  messageId: "m",
  contextId: "acme",
  taskId: "t",
  stage: "S9",
  round: 1,
  kind: "brief",
  role: "agent",
  from: "acme.pricing",
  to: ["acme.capture_lead"],
  state: "completed",
  text: "Acme holds the current contract and prices at market.",
  reasoning: "",
  citations: [],
  dropped: 0,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, latencyMs: 8000, model: "m", free: true },
  data: {},
  ...over,
});

const board: BoardResult = {
  label: "simulated board",
  members: 3,
  runs: 9,
  rows: [{ group: "acme", label: "ACME CORP", code: "A", incumbent: false, share: 0.7, ratings: {} }],
  notes: [],
  budget: { capUsd: 1, spentUsd: 0, calls: 1, maxCalls: 9, agents: 9, messages: 9 },
};

/** A small run: two rivals researched at S4, a verdict burst at S7, the swarm at S9 and the board at S10. */
function scenario() {
  n = 0;
  const s = 1000;
  const envs: RunEventEnvelope[] = [
    env({ type: "STEP_STARTED", stepName: "S4" }, T0),
    env({ type: "STATE_SNAPSHOT", snapshot: snapshot([{ subject: "ACME CORP" }, { subject: "Beta Inc" }, { subject: "Home Co", home: true }]) }, T0 + 1),
    env(fetchEv("ACME CORP", "api.sam.gov"), T0 + 2 * s),
    env(fetchEv("ACME CORP", "acme.com", "blocked"), T0 + 4 * s),
    env(fetchEv("Beta Inc", "beta.com", "error"), T0 + 5 * s),
    env(fetchEv("ACME CORP", "news.example", "ok"), T0 + 60 * s), // a second trip: far from the first
    env(fetchEv("Home Co", "home.example"), T0 + 61 * s),
    env({ type: "STEP_FINISHED", stepName: "S4", status: "done" }, T0 + 62 * s),
    env({ type: "STEP_STARTED", stepName: "S7" }, T0 + 70 * s),
    env(verifyEv("supported"), T0 + 71 * s),
    env(verifyEv("partially_supported"), T0 + 71 * s + 10),
    env(verifyEv("unsupported"), T0 + 71 * s + 20),
    env(verifyEv("supported"), T0 + 75 * s),
    env({ type: "STEP_FINISHED", stepName: "S7", status: "done" }, T0 + 76 * s),
    env(act("agent_card", card("red_team", "red_team", "red_team", "Red team")), T0 + 80 * s),
    env(act("agent_card", card("analyst", "analyst", "analyst", "Home team")), T0 + 80 * s),
    env(act("agent_card", card("acme.pricing", "pricing", "acme", "ACME CORP")), T0 + 80 * s),
    env(act("agent_card", card("acme.capture_lead", "capture_lead", "acme", "ACME CORP")), T0 + 80 * s),
    env(act("agent_card", card("acme.librarian", "librarian", "acme", "ACME CORP")), T0 + 80 * s),
    env(act("agent_card", card("gamma.capture_lead", "capture_lead", "gamma", "Gamma LLC")), T0 + 80 * s),
    env(act("agent_message", msg({ messageId: "m1", seq: 0 } as Partial<AgentMessage>)), T0 + 90 * s),
    env(act("agent_message", msg({ messageId: "m2", from: "acme.capture_lead", to: ["red_team"], kind: "strategy", usage: { ...msg({}).usage, latencyMs: 0 } })), T0 + 95 * s),
    env(act("agent_message", msg({ messageId: "m3", from: "red_team", to: ["acme"], kind: "challenge", round: 2, state: "failed" })), T0 + 100 * s),
    env(act("agent_message", msg({ messageId: "m4", from: "acme.capture_lead", to: ["board", "red_team"], kind: "response", round: 3 })), T0 + 105 * s),
    env(act("agent_message", msg({ messageId: "m5", from: "nobody", to: ["red_team"] })), T0 + 106 * s),
    env(act("agent_card", card("board.technical", "evaluator", "board", "Board")), T0 + 110 * s),
    env(act("agent_card", card("board.management", "evaluator", "board", "Board")), T0 + 110 * s),
    env(act("agent_message", msg({ messageId: "m6", from: "board.technical", to: ["board"], kind: "rating", round: 4, usage: { ...msg({}).usage, latencyMs: 2000 } })), T0 + 112 * s),
    env(act("board_result", board), T0 + 115 * s),
  ];
  const view = foldSwarm(envs);
  const record = foldOffice(envs);
  return { envs, view, record };
}

describe("foldOffice", () => {
  it("keeps lanes in snapshot order, fetches, verdicts and stage edges; a fetch for an unknown rival adds its lane", () => {
    const { record } = scenario();
    expect(record.lanes.map((l) => l.key)).toEqual(["ACME CORP", "BETA INC", "HOME CO"]);
    expect(record.lanes.find((l) => l.key === "HOME CO")?.home).toBe(true);
    expect(record.fetches.map((f) => [f.lane, f.host, f.status])).toEqual([
      ["ACME CORP", "api.sam.gov", "ok"],
      ["ACME CORP", "acme.com", "blocked"],
      ["BETA INC", "beta.com", "error"],
      ["ACME CORP", "news.example", "ok"],
      ["HOME CO", "home.example", "ok"],
    ]);
    expect(record.verifies.map((v) => v.verdict)).toEqual(["supported", "partly", "withheld", "supported"]);
    expect(record.stages.map((s) => `${s.stage}:${s.edge}`)).toEqual(["S4:started", "S4:finished", "S7:started", "S7:finished"]);
    expect(record.lastSeq).toBe(29);
  });

  it("ignores duplicate seqs and frames with no readable time, in any order", () => {
    n = 0;
    const a = env(fetchEv("Zed", "z.example"), T0, 5);
    const dup = env(fetchEv("Zed", "dup.example"), T0, 5);
    const bad = { ...env(fetchEv("Zed", "late.example"), T0, 6), ts: "not a time" };
    const r = foldOffice([bad, dup, a]);
    expect(r.fetches).toHaveLength(1);
    expect(r.lanes).toEqual([{ key: "ZED", label: "Zed", home: false, seq: 5, ts: T0 }]);
    expect(r.lastSeq).toBe(6);
  });

  it("selects only the office's events from a stream", () => {
    n = 0;
    expect(isOfficeEvent(env(fetchEv("A", "a"), T0))).toBe(true);
    expect(isOfficeEvent(env(verifyEv("supported"), T0))).toBe(true);
    expect(isOfficeEvent(env({ type: "STEP_STARTED", stepName: "S4" }, T0))).toBe(true);
    expect(isOfficeEvent(env({ type: "STATE_SNAPSHOT", snapshot: snapshot([]) }, T0))).toBe(true);
    expect(isOfficeEvent(env(act("agent_card", card("x", "pricing", "g", "G")), T0))).toBe(false);
    expect(isOfficeEvent(env({ type: "STATE_DELTA", delta: [] }, T0))).toBe(false);
  });

  it("folds a rival's name to one key", () => {
    expect(podKey("  Acme   Corp ")).toBe("ACME CORP");
  });
});

describe("the floor", () => {
  it("projects isometrically: x runs right and down, y left and down, z lifts", () => {
    const o = iso({ x: 0, y: 0 });
    const x1 = iso({ x: 1, y: 0 });
    const y1 = iso({ x: 0, y: 1 });
    expect(x1.sx).toBeGreaterThan(o.sx);
    expect(x1.sy).toBeGreaterThan(o.sy);
    expect(y1.sx).toBeLessThan(o.sx);
    expect(iso({ x: 0, y: 0 }, 10).sy).toBe(o.sy - 10);
    expect(depth({ x: 2, y: 3 })).toBe(5);
  });

  it("lays out pods in one row up to three rivals, two rows beyond, never overlapping", () => {
    expect(podCentres(0)).toEqual([]);
    expect(new Set(podCentres(3).map((p) => p.y)).size).toBe(1);
    const five = podCentres(5);
    expect(new Set(five.map((p) => p.y)).size).toBe(2);
    for (const a of five) for (const b of five) if (a !== b) expect(Math.abs(a.x - b.x) >= 5 || Math.abs(a.y - b.y) >= 4.4).toBe(true);
  });

  it("gives every rival a pod and every agent a desk; desks fill as cards are recorded", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    expect(plan.pods.map((p) => p.key)).toEqual(["ACME CORP", "BETA INC", "GAMMA LLC"]);
    expect(plan.pods[0]?.groupId).toBe("acme");
    expect(plan.pods[1]?.groupId).toBeNull();
    expect(plan.byAgent["acme.pricing"]).toBe("ACME CORP:pricing");
    expect(plan.seats["ACME CORP:technical"]?.agentId).toBeNull();
    // a role with no desk of its own still gets one
    expect(plan.byAgent["acme.librarian"]).toBe("ACME CORP:x0");
    expect(plan.seats["ACME CORP:x0"]?.role).toBe("analyst");
    // the home lane's researcher sits beside the analyst, not in a pod
    expect(plan.seats["HOME CO:lane"]?.zone).toBe("analyst");
    expect(plan.byAgent["board.technical"]).toBe("board:0");
    expect(plan.seats["board:2"]?.agentId).toBeNull();
    expect(plan.seats.verifier?.role).toBe("verifier");
    // painter's order: further back first
    const depths = plan.order.map((id) => depth(plan.seats[id]?.at ?? { x: 0, y: 0 }));
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
  });

  it("seats extra red-team agents beside the first", () => {
    const view = foldSwarm([
      env(act("agent_card", card("rt1", "red_team", "red_team", "Red team")), T0),
      env(act("agent_card", card("rt2", "red_team", "red_team", "Red team")), T0),
    ]);
    const plan = planOffice(view, { lanes: [], fetches: [], verifies: [], stages: [], parks: [], notes: [], lastSeq: 0 });
    expect(plan.byAgent.rt1).toBe("red_team");
    expect(plan.byAgent.rt2).toBe("red_team:1");
  });

  it("addresses a message to desks: named agents, every member of a group, the board-room table before the board sits", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    expect(recipientSeats(plan, view, { from: "red_team", to: ["acme"] }).sort()).toEqual(["ACME CORP:capture_lead", "ACME CORP:pricing", "ACME CORP:x0"]);
    expect(recipientSeats(plan, view, { from: "acme.capture_lead", to: ["red_team", "acme.capture_lead", "ghost"] })).toEqual(["red_team"]);
    const early = { ...view, groups: view.groups.filter((g) => g.kind !== "board") };
    expect(recipientSeats(plan, early, { from: "acme.capture_lead", to: ["board"] })).toEqual(["board"]);
    expect(recipientSeats(plan, view, { from: "acme.capture_lead", to: ["board"] }).sort()).toEqual(["board:0", "board:1"]);
  });
});

describe("clocks", () => {
  it("replays faster, cuts long quiet stretches and keeps order", () => {
    const c = replayClock([{ t: T0 }, { t: T0 + 4000 }, { t: T0 + 600_000 }], 8, 6000);
    expect(c.at(T0)).toBe(REPLAY_LEAD_MS);
    expect(c.at(T0 + 4000)).toBe(REPLAY_LEAD_MS + 500);
    // ten minutes of silence plays as the capped gap
    expect(c.at(T0 + 600_000)).toBe(REPLAY_LEAD_MS + 500 + 750);
    expect(c.span).toBe(REPLAY_LEAD_MS + 1250);
    expect(c.at(T0 + 2000)).toBe(REPLAY_LEAD_MS + 250);
    expect(c.at(T0 - 800)).toBe(REPLAY_LEAD_MS - 100);
    expect(c.at(T0 - 10_000_000)).toBe(0);
    expect(c.at(T0 + 600_000 + 800)).toBe(REPLAY_LEAD_MS + 1250 + 100);
    expect(c.typingStart(T0 + 4000, 4000)).toBe(c.at(T0));
    expect(c.typingStart(T0 + 4000, -5)).toBe(c.at(T0 + 4000));
  });

  it("holds a burst apart by its minimum step", () => {
    const c = replayClock([{ t: T0 }, { t: T0 + 1, minStep: 40 }, { t: T0 + 2, minStep: 40 }, { t: T0 + 2, minStep: 10 }, { t: Number.NaN }]);
    expect(c.at(T0 + 1) - c.at(T0)).toBe(40);
    expect(c.at(T0 + 2) - c.at(T0 + 1)).toBe(40);
  });

  it("an empty replay clock starts everything at the lead", () => {
    const c = replayClock([]);
    expect(c.at(T0)).toBe(REPLAY_LEAD_MS);
    expect(c.span).toBe(REPLAY_LEAD_MS);
  });

  it("the live clock shifts by the measured skew plus the lag and shows at most a short call", () => {
    const c = liveClock(250);
    expect(c.at(T0)).toBe(T0 + 250 + LIVE_LAG_MS);
    expect(c.typingStart(T0, 60_000)).toBe(c.at(T0) - LIVE_TYPING_MS);
    expect(c.typingStart(T0, 300)).toBe(c.at(T0) - 300);
    expect(c.typingStart(T0, -1)).toBe(c.at(T0));
  });

  it("collects every anchor a replay needs", () => {
    const { view, record } = scenario();
    const keys = warpKeys(view, record);
    expect(keys.length).toBe(record.fetches.length + record.verifies.length + record.stages.length + view.messages.length * 2 + Object.keys(view.cardSeen).length + 1);
    expect(warpKeys({ ...view, boardSeen: null }, record).length).toBe(keys.length - 1);
  });
});

/** A clock that maps recorded time 1:1 from T0, so expectations read in seconds. */
const plain: BeatClock = { at: (t) => t - T0, typingStart: (t, lat) => t - T0 - lat };

describe("buildSchedule", () => {
  it("turns each message into its recorded model call at the desk, then a send to every recipient", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    const sched = buildSchedule(plan, view, record, plain);
    const type1 = sched.beats.find((b) => b.id === "type:m1");
    expect(type1).toMatchObject({ seat: "ACME CORP:pricing", start: 82_000, end: 90_000 });
    expect(sched.beats.find((b) => b.id === "send:m1")).toMatchObject({ start: 90_000, end: 90_000 + SEND_MS, to: ["ACME CORP:capture_lead"] });
    // no latency recorded: no typing beat
    expect(sched.beats.find((b) => b.id === "type:m2")).toBeUndefined();
    expect(sched.beats.find((b) => b.id === "send:m3")).toMatchObject({ failed: true });
    // a sender with no desk: listed as sent, nothing moves
    expect(sched.beats.find((b) => b.id === "send:m5")).toBeUndefined();
    expect(sched.sends.map((s) => s.msgId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("walks evaluators in through the door and seats them before their call is shown", () => {
    const { view, record } = scenario();
    const sched = buildSchedule(planOffice(view, record), view, record, plain);
    const enter = sched.beats.find((b) => b.id === "enter:board:0");
    expect(enter).toMatchObject({ start: 110_000, end: 110_000 + ENTER_MS });
    expect(sched.beats.find((b) => b.id === "type:m6")).toMatchObject({ start: 110_000 + ENTER_MS, end: 112_000 });
    expect(sched.presentFrom["board:0"]).toBe(110_000);
    expect(sched.presentFrom["board:2"]).toBe(Infinity);
    expect(sched.presentFrom["ACME CORP:lane"]).toBe(-Infinity);
    expect(sched.presentFrom.verifier).toBe(-Infinity);
    expect(sched.presentFrom["ACME CORP:technical"]).toBe(Infinity);
    expect(sched.scoresAt).toBe(115_000);
    expect(sched.end).toBeGreaterThanOrEqual(115_000);
  });

  it("groups a lane's fetches into trips to the web terminal", () => {
    const { view, record } = scenario();
    const sched = buildSchedule(planOffice(view, record), view, record, plain);
    const trips = sched.beats.filter((b) => b.kind === "trip");
    const acme = trips.filter((b) => b.seat === "ACME CORP:lane");
    expect(acme).toHaveLength(2);
    expect(acme[0]).toMatchObject({ start: 2000 - WALK_MS, out: 2000, back: 4000, end: 4000 + WALK_MS, carries: true });
    expect(acme[0]?.kind === "trip" && acme[0].visits.map((v) => v.host)).toEqual(["api.sam.gov", "acme.com"]);
    const beta = trips.find((b) => b.seat === "BETA INC:lane");
    expect(beta).toMatchObject({ back: 5000 + MIN_BROWSE_MS, carries: false });
    expect(trips.find((b) => b.seat === "HOME CO:lane")).toBeDefined();
    expect(TRIP_JOIN_MS).toBeGreaterThan(2000);
  });

  it("stamps verdict bursts once and counts every verdict", () => {
    const { view, record } = scenario();
    const sched = buildSchedule(planOffice(view, record), view, record, plain);
    const stamps = sched.beats.filter((b) => b.kind === "stamp");
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toMatchObject({ verdict: "withheld", count: 3, end: 71_000 + STAMP_MS });
    expect(sched.verdicts).toHaveLength(4);
  });

  it("history sets the scene: nothing at or before the settled seq moves", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    const sched = buildSchedule(plan, view, record, plain, 1000);
    expect(sched.beats).toEqual([]);
    expect(sched.presentFrom["acme.pricing" in plan.byAgent ? "ACME CORP:pricing" : ""]).toBe(-Infinity);
    expect(sched.presentFrom["board:0"]).toBe(-Infinity);
    expect(sched.scoresAt).toBe(-Infinity);
    expect(sched.sends.every((s) => s.at === -Infinity)).toBe(true);
    expect(sched.verdicts.every((v) => v.at === -Infinity)).toBe(true);
    expect(sched.end).toBe(0);
  });

  it("a trip never mixes history with fresh fetches: only the fresh part moves", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    // seq 3 (api.sam.gov) is history, seq 4 (acme.com, 2 s later) is fresh: they would otherwise be one trip
    const sched = buildSchedule(plan, view, record, plain, 3);
    const acme = sched.beats.filter((b) => b.kind === "trip" && b.seat === "ACME CORP:lane");
    expect(acme[0]?.kind === "trip" && acme[0].visits.map((v) => v.host)).toEqual(["acme.com"]);
  });

  it("the live clock runs until the last fresh change, a stage edge or an arrival included", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    // only S7's finish (seq 14) and later are fresh, and nothing after it but cards, messages and the board
    const late: OfficeRecord = { ...record, stages: [...record.stages, { seq: 99, ts: T0 + 200_000, stage: "S11", edge: "started" }] };
    expect(buildSchedule(plan, view, late, plain, 13).end).toBe(200_000);
  });

  it("a desk with no recorded agent stays empty in the final frame", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    const end = frameAt(plan, buildSchedule(plan, view, record, plain), Infinity);
    expect(end.seats["ACME CORP:technical"]?.present).toBe(false);
    expect(end.seats["board:2"]?.present).toBe(false);
    expect(end.seats["ACME CORP:pricing"]?.present).toBe(true);
  });

  it("a run with no board result never shows scores", () => {
    const { view, record } = scenario();
    const sched = buildSchedule(planOffice(view, record), { ...view, boardSeen: null }, record, plain);
    expect(sched.scoresAt).toBe(Infinity);
  });

  it("a lane with no desk, a message with no readable time and a card with no time are skipped safely", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    const stray: OfficeRecord = { ...record, fetches: [...record.fetches, { seq: 999, ts: T0, lane: "NOWHERE", host: "x", status: "ok", tier: "other" }] };
    const badMsg = { ...view, messages: [...view.messages, { ...view.messages[0]!, messageId: "bad", ts: "nope" }] };
    const sched = buildSchedule(plan, badMsg, stray, plain);
    expect(sched.beats.some((b) => b.id.includes("NOWHERE"))).toBe(false);
    expect(sched.sends.some((s) => s.msgId === "bad")).toBe(false);
    const noTime = { ...view, cardSeen: { ...view.cardSeen, "acme.pricing": { seq: 17, ts: "nope" } } };
    expect(buildSchedule(plan, noTime, record, plain).presentFrom["ACME CORP:pricing"]).toBe(-Infinity);
  });
});

describe("frameAt", () => {
  const setup = () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    return { plan, sched: buildSchedule(plan, view, record, plain), view };
  };

  it("before anything happens everyone present sits idle", () => {
    const { plan, sched } = setup();
    const f = frameAt(plan, sched, 0);
    expect(f.seats["ACME CORP:lane"]).toMatchObject({ present: true, activity: "idle", away: false });
    expect(f.seats["ACME CORP:pricing"]?.present).toBe(false);
    expect(f.tally).toEqual({ supported: 0, partly: 0, withheld: 0 });
    expect(f.scores).toBe(false);
    expect(f.sent).toBe(0);
  });

  it("a researcher walks to the terminal, reads, and walks back carrying a document", () => {
    const { plan, sched } = setup();
    const out = frameAt(plan, sched, 1500).seats["ACME CORP:lane"];
    expect(out).toMatchObject({ activity: "walking", away: true, carrying: false });
    expect(out?.walk?.path.at(-1)).toEqual(plan.kioskSlots[0]);
    const at = frameAt(plan, sched, 3000).seats["ACME CORP:lane"];
    expect(at).toMatchObject({ activity: "browsing", visits: 1 });
    expect(at?.visit?.host).toBe("api.sam.gov");
    expect(frameAt(plan, sched, 4000 + 10).seats["ACME CORP:lane"]).toMatchObject({ activity: "walking", carrying: true, visits: 2 });
    expect(frameAt(plan, sched, 4000 + WALK_MS + 10).seats["ACME CORP:lane"]?.activity).toBe("idle");
  });

  it("a message is typed, then sent with a bubble; an envelope flies and the recipient reacts", () => {
    const { plan, sched } = setup();
    expect(frameAt(plan, sched, 85_000).seats["ACME CORP:pricing"]?.activity).toBe("typing");
    const send = frameAt(plan, sched, 90_100);
    expect(send.seats["ACME CORP:pricing"]).toMatchObject({ activity: "sending" });
    expect(send.seats["ACME CORP:pricing"]?.bubble?.msgId).toBe("m1");
    expect(send.flights).toEqual([{ id: "send:m1>ACME CORP:capture_lead", from: "ACME CORP:pricing", to: "ACME CORP:capture_lead", start: 90_000, end: 90_000 + FLIGHT_MS }]);
    const land = frameAt(plan, sched, 90_000 + FLIGHT_MS + REACT_MS / 2);
    expect(land.seats["ACME CORP:capture_lead"]?.activity).toBe("receiving");
    expect(land.flights).toEqual([]);
    expect(land.sent).toBe(1);
  });

  it("the verifier stamps; the tally counts verdicts landed; the board walks in and scores", () => {
    const { plan, sched } = setup();
    const stamp = frameAt(plan, sched, 71_100);
    expect(stamp.stamp).toMatchObject({ verdict: "withheld", count: 3 });
    expect(stamp.seats.verifier?.activity).toBe("stamping");
    expect(stamp.tally).toEqual({ supported: 1, partly: 1, withheld: 1 });
    // a burst's stamp shows only the verdicts recorded by then, never the rest of the burst ahead of time
    expect(frameAt(plan, sched, 71_000).stamp).toMatchObject({ verdict: "supported", count: 1 });
    expect(frameAt(plan, sched, 71_015).stamp).toMatchObject({ verdict: "partly", count: 2 });
    const enter = frameAt(plan, sched, 110_500).seats["board:0"];
    expect(enter).toMatchObject({ activity: "entering", present: true });
    expect(enter?.walk?.path[0]).toEqual(enterPath(plan.seats["board:0"]!.at)[0]);
    const end = frameAt(plan, sched, Infinity);
    expect(end.scores).toBe(true);
    expect(end.tally).toEqual({ supported: 2, partly: 1, withheld: 1 });
    expect(end.sent).toBe(6);
    expect(Object.values(end.seats).every((s) => s.activity === "idle")).toBe(true);
  });

  it("a typing beat never overrides a send at the same desk", () => {
    const { plan, sched } = setup();
    const both = { ...sched, beats: [...sched.beats, { kind: "type" as const, id: "late", seat: "ACME CORP:pricing", start: 90_050, end: 90_200, seq: 99 }] };
    expect(frameAt(plan, both, 90_100).seats["ACME CORP:pricing"]?.activity).toBe("sending");
  });

  it("beats for desks that no longer exist are ignored", () => {
    const { plan, sched } = setup();
    const ghost = {
      ...sched,
      beats: [
        { kind: "trip" as const, id: "g", seat: "GONE:lane", slot: 0, start: 0, out: 1, back: 2, end: 3, seq: 1, visits: [], carries: false },
        { kind: "trip" as const, id: "g2", seat: "ACME CORP:lane", slot: 99, start: 0, out: 1, back: 2, end: 3, seq: 1, visits: [], carries: false },
        { kind: "enter" as const, id: "e", seat: "GONE", start: 0, end: 3, seq: 1 },
      ],
    };
    const f = frameAt(plan, ghost, 1.5);
    expect(f.seats["ACME CORP:lane"]?.activity).toBe("idle");
  });
});

describe("paths", () => {
  it("goes out along the corridor and comes back the same way", () => {
    const p = tripPath({ x: 8, y: 9 }, { x: 1.15, y: 4 });
    expect(p[1]?.y).toBe(p[2]?.y);
    expect(p.at(-1)).toEqual({ x: 1.15, y: 4 });
    // a pod researcher steps off the rug first, then walks up beside the pod
    const side = tripPath({ x: 8, y: 9 }, { x: 1.15, y: 4 }, 1.2);
    expect(side[1]).toEqual({ x: 6.8, y: 9 });
    expect(side[2]?.x).toBe(6.8);
    expect(side).toHaveLength(5);
  });

  it("finds the point at a fraction of a polyline's length", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ];
    expect(pointAlong(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAlong(path, 0.5)).toEqual({ x: 2, y: 0 });
    expect(pointAlong(path, 0.75)).toEqual({ x: 2, y: 1 });
    expect(pointAlong(path, 2)).toEqual({ x: 2, y: 2 });
    expect(pointAlong([{ x: 3, y: 3 }], 0.5)).toEqual({ x: 3, y: 3 });
    expect(pointAlong([], 0.5)).toEqual({ x: 0, y: 0 });
    expect(
      pointAlong(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        0.5,
      ),
    ).toEqual({ x: 1, y: 1 });
  });
});

describe("replay helpers", () => {
  it("lists the first messages sent, in send order", () => {
    const { view, record } = scenario();
    const sched = buildSchedule(planOffice(view, record), view, record, plain);
    expect([...sentFirst(sched, 2)]).toEqual(["m1", "m2"]);
    expect(sentFirst(sched, -1).size).toBe(0);
  });

  it("knows which stage is running at a display time", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    const sched = buildSchedule(plan, view, record, plain);
    expect(stageAt(sched, -1)).toBeNull();
    expect(stageAt(sched, 30_000)).toBe("S4");
    expect(stageAt(sched, 65_000)).toBeNull();
    expect(stageAt(sched, 72_000)).toBe("S7");
    const odd: OfficeRecord = { ...record, stages: [{ seq: 1, ts: T0, stage: "S4", edge: "started" }, { seq: 2, ts: T0 + 1, stage: "S5", edge: "finished" }] };
    expect(stageAt(buildSchedule(plan, view, odd, plain), 10)).toBe("S4");
  });

  it("a stage already started when the office opened is running at once, not after the live delay", () => {
    const { view, record } = scenario();
    const plan = planOffice(view, record);
    // S4 started at seq 1, inside the history: it is in effect immediately, even long before its display time
    const sched = buildSchedule(plan, view, record, liveClock(0), 2);
    expect(stageAt(sched, 0)).toBe("S4");
  });
});

describe("feedAction", () => {
  it("follows an active run, reads a stopped one to its last seq, parks at a gate, ends after the run ends", () => {
    expect(feedAction("running", 10, 50)).toBe("follow");
    expect(feedAction("decided", 10, 50)).toBe("read");
    expect(feedAction("decided", 50, 50)).toBe("end");
    expect(feedAction("failed", 50, 50)).toBe("end");
    expect(feedAction("awaiting_plan_approval", 50, 50)).toBe("park");
    expect(feedAction("awaiting_decision", 50, 50)).toBe("park");
    expect(feedAction("awaiting_review", 49, 50)).toBe("read");
    // an interrupted run can be resumed (POST /runs/{id}/resume): the feed keeps looking
    expect(feedAction("interrupted", 50, 50)).toBe("park");
    expect(feedAction("queued", 50, 50)).toBe("follow");
    expect(feedAction("cancelled", 50, 50)).toBe("end");
  });

  it("a parked feed resumes whenever it next finds the run active, whatever the swarm poll saw in between", () => {
    // running -> H1 (the feed parks) -> approved elsewhere: the feed's own re-read finds it running and follows again
    const steps = [feedAction("running", 20, 40), feedAction("awaiting_plan_approval", 40, 40), feedAction("running", 40, 41)];
    expect(steps).toEqual(["follow", "park", "follow"]);
  });
});

describe("live sync", () => {
  it("before the history boundary is known nothing measures skew", () => {
    expect(noteArrival(NEW_SYNC, { seq: 9, ts: iso8601(T0) }, T0 + 50)).toBe(NEW_SYNC);
  });

  it("history never measures skew, however slowly it arrives; events after the boundary do", () => {
    let s: LiveSync = { ...NEW_SYNC, settledSeq: 10 };
    // an hour-old history event arriving late is still history
    s = noteArrival(s, { seq: 10, ts: iso8601(T0 - 3_600_000) }, T0 + 500);
    expect(s.skewMs).toBeNull();
    s = noteArrival(s, { seq: 11, ts: iso8601(T0) }, T0 + 300);
    expect(s.skewMs).toBe(300);
    s = noteArrival(s, { seq: 12, ts: iso8601(T0 + 1000) }, T0 + 1120);
    expect(s.skewMs).toBe(120);
    s = noteArrival(s, { seq: 13, ts: "bad" }, T0 + 9000);
    expect(s).toMatchObject({ skewMs: 120, settledSeq: 10 });
  });

  it("an agent with no recorded card is never present, not even in the final frame", () => {
    expect(isPresent(Infinity, Infinity)).toBe(false);
    expect(isPresent(undefined, 5)).toBe(false);
    expect(isPresent(-Infinity, 0)).toBe(true);
    expect(isPresent(100, 99)).toBe(false);
    expect(isPresent(100, Infinity)).toBe(true);
  });
});

/** A view type check: the scenario folds into a real SwarmView. */
const _typed: (v: SwarmView) => number = (v) => v.messages.length;
void _typed;

describe("the record the Playhouse style reads", () => {
  const delta = (idemKey: string, paths: Record<string, unknown>, at: number, seq: number): RunEventEnvelope => ({
    seq,
    runId: "r",
    idemKey,
    ts: iso8601(at),
    event: { type: "STATE_DELTA", delta: Object.entries(paths).map(([path, value]) => ({ op: "replace" as const, path, value })) },
  });
  const verdict = (idemKey: string, claim: string, v: "supported" | "unsupported", at: number, seq: number): RunEventEnvelope => ({
    seq,
    runId: "r",
    idemKey,
    ts: iso8601(at),
    event: { type: "ACTIVITY_SNAPSHOT", messageId: "v", activityType: "verify", content: { claimId: idemKey, claim, verdict: v, sourceUnreachable: false } },
  });

  it("keeps each fetch's source tier, each finished stage's status and each phase end", () => {
    n = 0;
    const r = foldOffice([
      env({ type: "STEP_STARTED", stepName: "S6" }, T0),
      env({ type: "STEP_FINISHED", stepName: "S6", status: "degraded" }, T0 + 1),
      env({ type: "STEP_FINISHED", stepName: "S7" }, T0 + 2),
      env({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { state: "awaiting_plan_approval" } }, T0 + 3),
      env(act("fetch", { subject: "Acme", evidenceId: "e", host: "sec.gov", sourceType: "filing", tier: "sec_filing", status: "ok", column: "c" }), T0 + 4),
    ]);
    expect(r.stages.map((s) => [s.stage, s.edge, s.status])).toEqual([
      ["S6", "started", undefined],
      ["S6", "finished", "degraded"],
      ["S7", "finished", "done"],
    ]);
    expect(r.parks).toEqual([{ seq: 4, ts: T0 + 3, state: "awaiting_plan_approval" }]);
    expect(r.fetches[0]?.tier).toBe("sec_filing");
  });

  it("names a verdict's rival from its paired cell delta, whichever arrives first, and keeps the claim", () => {
    const r = foldOffice([
      verdict("S7:g1:verdict:a", "Acme holds the incumbent contract.", "supported", T0, 1),
      delta("S7:g1:verdict:a:delta", { "/cells/ACME, INC.:past_performance": { state: "verified" }, "/counters/supported": 1 }, T0 + 5, 2),
      delta("S7:g2:verdict:b:delta", { "/cells/Beta~1Gamma LLC:labor_rates/state": "withheld" }, T0 + 6, 3),
      verdict("S7:g2:verdict:b", "Beta lists a rate of $45.", "unsupported", T0 + 7, 4),
      verdict("S7:g3:verdict:c", "No delta was recorded for this one.", "supported", T0 + 8, 5),
      // a delta without the suffix, or without a cell, attributes nothing
      delta("S7:g3:verdict:c", { "/cells/ACME, INC.:x": {} }, T0 + 9, 6),
      delta("S7:g3:verdict:c:delta", { "/counters/supported": 3 }, T0 + 10, 7),
      // a cell key with no column names the whole key
      verdict("S7:g4:verdict:d", "Delta has a cell key with no column.", "supported", T0 + 11, 8),
      delta("S7:g4:verdict:d:delta", { "/cells/Delta Co": {} }, T0 + 12, 9),
    ]);
    expect(r.verifies.map((v) => [v.claim.split(" ")[0], v.verdict, v.lane])).toEqual([
      ["Acme", "supported", "ACME, INC."],
      ["Beta", "withheld", "BETA/GAMMA LLC"],
      ["No", "supported", null],
      ["Delta", "supported", "DELTA CO"],
    ]);
  });

  it("keeps each lane's recorded activity line, unescaping the subject", () => {
    const r = foldOffice([
      delta("k1", { "/lanes/ACME, INC./activity": "Drafting the dossier (attempt 1 of 3) for ACME, INC.", "/lanes/ACME, INC./fetches": 4 }, T0, 1),
      delta("k2", { "/lanes/Beta~1Gamma/activity": "GET api.sam.gov (sam.entity)", "/lanes/Beta~1Gamma/status": "running" }, T0 + 1, 2),
      delta("k3", { "/lanes/ACME, INC./activity": 7 }, T0 + 2, 3),
    ]);
    expect(r.notes).toEqual([
      { seq: 1, ts: T0, lane: "ACME, INC.", text: "Drafting the dossier (attempt 1 of 3) for ACME, INC." },
      { seq: 2, ts: T0 + 1, lane: "BETA/GAMMA", text: "GET api.sam.gov (sam.entity)" },
    ]);
  });

  it("keeps from a stream only the deltas that carry an activity line or pair a verdict", () => {
    expect(isOfficeEvent(delta("k", { "/lanes/A/activity": "Reading" }, T0, 1))).toBe(true);
    expect(isOfficeEvent(delta("S7:g:verdict:x:delta", { "/cells/A:col": {} }, T0, 2))).toBe(true);
    expect(isOfficeEvent(delta("S5:rows", { "/cells/A:col": {} }, T0, 3))).toBe(false);
    expect(isOfficeEvent(delta("k", { "/counters/fetches": 3, "/lanes/A/fetches": 3 }, T0, 4))).toBe(false);
    expect(isOfficeEvent(delta("x:delta", { "/cells/": {} }, T0, 5))).toBe(false);
  });
});

describe("recorded time from display time", () => {
  it("the replay clock's inverse lands on every key, between keys and clamps outside them", () => {
    const c = replayClock([{ t: T0 }, { t: T0 + 4000 }, { t: T0 + 4001, minStep: 300 }, { t: T0 + 600_000 }], 8, 6000);
    for (const t of [T0, T0 + 4000, T0 + 4001, T0 + 600_000]) expect(c.recordedAt(c.at(t))).toBeCloseTo(t, 6);
    expect(c.recordedAt(c.at(T0 + 2000))).toBeCloseTo(T0 + 2000, 6);
    // before the first key: the lead-in, never earlier than the clock's zero
    expect(c.recordedAt(c.at(T0 - 800))).toBeCloseTo(T0 - 800, 6);
    expect(c.recordedAt(-50)).toBe(T0 - REPLAY_LEAD_MS * 8);
    // after the last key: the capped gap, then clamped
    expect(c.recordedAt(c.at(T0 + 600_400))).toBeCloseTo(T0 + 600_400, 6);
    expect(c.recordedAt(Number.POSITIVE_INFINITY)).toBe(T0 + 600_000 + 6000);
    expect(replayClock([]).recordedAt(100)).toBeNaN();
  });

  it("the live clock's inverse removes the skew and the lag", () => {
    const c = liveClock(250);
    expect(c.recordedAt(c.at(T0))).toBe(T0);
  });
});
