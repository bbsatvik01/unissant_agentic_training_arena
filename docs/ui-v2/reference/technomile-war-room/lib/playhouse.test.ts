import { describe, expect, it } from "vitest";

import type { AgentCard, AgentMessage, BoardResult, RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";

import { buildSchedule, foldOffice, frameAt, planOffice, type BeatClock, type OfficeFrame, type OfficePlan, type OfficeRecord, type Schedule } from "./office";
import {
  ANALYST_SPOT,
  BOARD_SPOTS,
  BOOK_MS,
  books,
  callDoing,
  cardShown,
  deskTip,
  seatTip,
  trunkTip,
  castAt,
  callsAt,
  callWindows,
  CORNER,
  criticFocus,
  CURTAIN_MS,
  curtainAt,
  devilAt,
  displayAt,
  easelAt,
  EASEL_NOTE_MS,
  flyingAt,
  GATE_HOLD_MS,
  h2At,
  headline,
  HOME_LANE_SPOT,
  houseTime,
  laneLinesAt,
  parksAt,
  phaseAt,
  placards,
  playbillAt,
  playhouseWarpKeys,
  promptAt,
  PROMPT,
  ratingsOf,
  runSpan,
  scorecards,
  scrimAt,
  shelfOf,
  SLIP_HOLD_MS,
  spotTargets,
  stageEdges,
  stageLayout,
  startedAt,
  trimSubject,
  troupeCentres,
  trunksAt,
  waitWords,
  WITHHELD_HOLD_MS,
  WITHHELD_STEP_MS,
  type ApprovalLite,
  type GateInput,
} from "./playhouse";
import { foldSwarm } from "./swarm";
import { replayOrder } from "./swarm-graph";

const T0 = Date.parse("2026-10-04T02:48:00Z");
const S = 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
function env(event: RunEvent, at: number, idemKey?: string): RunEventEnvelope {
  n += 1;
  return { seq: n, runId: "r", idemKey: idemKey ?? `k${n}`, ts: iso(at), event };
}
const act = (activityType: string, content: unknown) => ({ type: "ACTIVITY_SNAPSHOT", messageId: `a${n}`, activityType, content }) as unknown as RunEvent;
const step = (type: "STEP_STARTED" | "STEP_FINISHED", stepName: string, status?: string) => ({ type, stepName, ...(status ? { status } : {}) }) as unknown as RunEvent;
const park = (state: string) => ({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { state } }) as RunEvent;
const fetchEv = (subject: string, host: string, tier: string, status: "ok" | "blocked" | "error" = "ok") =>
  act("fetch", { subject, evidenceId: "e#1", host, sourceType: "web", tier, status, column: "corporate" });
const verifyEv = (claim: string, verdict: "supported" | "partially_supported" | "unsupported") => act("verify", { claimId: claim, claim, verdict, sourceUnreachable: false });
const delta = (paths: Record<string, unknown>) => ({ type: "STATE_DELTA", delta: Object.entries(paths).map(([path, value]) => ({ op: "replace", path, value })) }) as RunEvent;

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

const card = (agentId: string, role: string, group: string, groupLabel: string, name?: string): AgentCard => ({
  agentId,
  name: name ?? `${role} ${groupLabel}`,
  role,
  group,
  groupLabel,
  stage: group === "board" ? "S10" : "S9",
  skills: role === "evaluator" ? ["relevance of the work"] : [],
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
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, latencyMs: 2000, model: "m", free: true },
  data: {},
  ...over,
});

const board: BoardResult = {
  label: "simulated board",
  members: 3,
  runs: 9,
  rows: [
    { group: "acme", label: "ACME CORP", code: "B", incumbent: true, share: 0.62, ratings: {} },
    { group: "zz-unknown", label: "Beta Inc", code: "A", incumbent: false, share: 0.38, ratings: {} },
  ],
  notes: [],
  budget: { capUsd: 1, spentUsd: 0, calls: 1, maxCalls: 9, agents: 9, messages: 9 },
};

/** A small run: intake, the H1 park, S4 research, the S6 dossiers, an S7 burst, the swarm, the board and H2. */
function scenario() {
  n = 0;
  const envs: RunEventEnvelope[] = [
    env(step("STEP_STARTED", "S0"), T0),
    env(step("STEP_FINISHED", "S0"), T0 + 1 * S),
    env(step("STEP_STARTED", "S3"), T0 + 2 * S),
    env(step("STEP_FINISHED", "S3"), T0 + 3 * S),
    env(park("awaiting_plan_approval"), T0 + 4 * S), // seq 5
    env(step("STEP_STARTED", "S4"), T0 + 12 * S), // seq 6
    env({ type: "STATE_SNAPSHOT", snapshot: snapshot([{ subject: "ACME CORP" }, { subject: "Beta Inc" }, { subject: "Home Co", home: true }]) }, T0 + 12 * S + 100),
    env(delta({ "/lanes/ACME CORP/activity": "Reading federal records for ACME CORP" }), T0 + 12 * S + 900),
    env(fetchEv("ACME CORP", "api.sam.gov", "federal_primary"), T0 + 13 * S), // seq 9
    env(fetchEv("ACME CORP", "sec.gov", "sec_filing", "blocked"), T0 + 13 * S + 200),
    env(fetchEv("ACME CORP", "acme.com", "company_owned"), T0 + 13 * S + 400),
    env(fetchEv("ACME CORP", "news.example", "news"), T0 + 13 * S + 600),
    env(fetchEv("Beta Inc", "beta.example", "mystery", "error"), T0 + 14 * S),
    env(step("STEP_FINISHED", "S4"), T0 + 15 * S),
    env(step("STEP_STARTED", "S6"), T0 + 16 * S),
    env(delta({ "/lanes/ACME CORP/activity": "Drafting the dossier (attempt 1 of 3) for ACME CORP" }), T0 + 17 * S),
    env(step("STEP_FINISHED", "S6", "degraded"), T0 + 30 * S), // seq 17
    env(step("STEP_STARTED", "S7"), T0 + 31 * S),
    env(verifyEv("Acme holds the incumbent contract with two option years left.", "supported"), T0 + 32 * S, "S7:acme:verdict:1"), // seq 19
    env(delta({ "/cells/ACME CORP:past_performance": { state: "verified" } }), T0 + 32 * S + 10, "S7:acme:verdict:1:delta"),
    env(verifyEv("Beta lists a ceiling rate of forty five dollars an hour.", "unsupported"), T0 + 32 * S + 100, "S7:beta:verdict:2"),
    env(delta({ "/cells/Beta Inc:labor_rates": { state: "withheld" } }), T0 + 32 * S + 110, "S7:beta:verdict:2:delta"),
    env(verifyEv("An unattributed claim that has no delta.", "partially_supported"), T0 + 32 * S + 200),
    env(step("STEP_FINISHED", "S7"), T0 + 33 * S),
    env(verifyEv("A late lone withheld claim about Beta pricing posture.", "unsupported"), T0 + 36 * S), // seq 25
    env(step("STEP_STARTED", "S9"), T0 + 40 * S),
    env(act("agent_card", card("red_team", "red_team", "red_team", "Red team")), T0 + 40 * S + 100),
    env(act("agent_card", card("analyst", "analyst", "analyst", "Home team")), T0 + 40 * S + 100),
    env(act("agent_card", card("acme.pricing", "pricing", "acme", "ACME CORP")), T0 + 40 * S + 100),
    env(act("agent_card", card("acme.capture_lead", "capture_lead", "acme", "ACME CORP")), T0 + 40 * S + 100),
    env(act("agent_card", card("beta.capture_lead", "capture_lead", "beta", "Beta Inc")), T0 + 40 * S + 100),
    env(act("agent_message", msg({ messageId: "m1" })), T0 + 44 * S),
    env(act("agent_message", msg({ messageId: "m2", from: "acme.capture_lead", to: ["red_team"], kind: "strategy" })), T0 + 46 * S),
    env(act("agent_message", msg({ messageId: "m3", from: "red_team", to: ["acme.capture_lead"], kind: "challenge", round: 2, usage: { ...msg({}).usage, latencyMs: 6000 } })), T0 + 50 * S),
    env(act("agent_message", msg({ messageId: "m4", from: "red_team", to: ["beta.capture_lead"], kind: "challenge", round: 2, usage: { ...msg({}).usage, latencyMs: 6000 } })), T0 + 51 * S),
    env(act("agent_message", msg({ messageId: "m5", from: "acme.capture_lead", to: ["board", "red_team"], kind: "response", round: 3 })), T0 + 54 * S),
    env(step("STEP_FINISHED", "S9"), T0 + 58 * S),
    env(step("STEP_STARTED", "S10"), T0 + 60 * S),
    env(act("agent_card", card("board.technical", "evaluator", "board", "Board", "Evaluator, technical")), T0 + 60 * S + 100),
    env(act("agent_card", card("board.management", "evaluator", "board", "Board", "Evaluator, management")), T0 + 60 * S + 100),
    env(act("agent_message", msg({ messageId: "r1", from: "board.technical", to: ["board"], kind: "rating", round: 4, data: { ratings: { A: 4, B: 3.5, C: 7, D: 2 } } })), T0 + 64 * S),
    env(act("agent_message", msg({ messageId: "r2", from: "board.management", to: ["board"], kind: "rating", round: 4, state: "failed", data: { ratings: { A: 5 } } })), T0 + 65 * S),
    env(act("board_result", board), T0 + 70 * S),
    env(step("STEP_FINISHED", "S10"), T0 + 71 * S),
    env(park("awaiting_decision"), T0 + 75 * S),
  ];
  const view = foldSwarm(envs);
  const record = foldOffice(envs);
  const plan = planOffice(view, record);
  return { envs, view, record, plan };
}

/** Maps recorded time 1:1 from T0, so expectations read in seconds. */
const plain: BeatClock = { at: (t) => t - T0, typingStart: (t, lat) => t - T0 - lat };
const approvals: ApprovalLite[] = [
  { gate: "h1", createdAt: iso(T0 + 10 * S) },
  { gate: "h2", createdAt: iso(T0 + 90 * S) },
];

function gates(record: OfficeRecord, at: (t: number) => number, opts: { approvals?: ApprovalLite[]; settled?: number } = {}): (t: number) => GateInput {
  const edges = stageEdges(record, plain, opts.settled ?? 0);
  const parks = parksAt(record, plain, opts.settled ?? 0);
  return (t) => ({ edges, parks, approvals: opts.approvals ?? approvals, clock: plain, nowRecorded: at(t) });
}
const rec = (t: number) => (t === Infinity ? Infinity : T0 + t);

describe("the stage", () => {
  it("spreads one troupe per rival, smaller from six on", () => {
    expect(troupeCentres(0)).toEqual([]);
    expect(troupeCentres(1)).toEqual([{ x: 780, scale: 1 }]);
    expect(troupeCentres(3).map((c) => c.x)).toEqual([480, 780, 1080]);
    expect(troupeCentres(4).map((c) => c.x)).toEqual([420, 660, 900, 1140]);
    expect(troupeCentres(6).every((c) => c.scale === 0.85)).toBe(true);
    const seven = troupeCentres(7);
    expect(seven[0]).toEqual({ x: 340, scale: 0.75 });
    expect(seven.at(-1)?.x).toBe(1260);
  });

  it("places every seat of the office plan: troupes, the devil's corner, the stalls, the box and the prompt desk", () => {
    const { view, record } = scenario();
    const extra = foldSwarm([
      ...scenario().envs,
      env(act("agent_card", card("acme.librarian", "librarian", "acme", "ACME CORP")), T0 + 41 * S),
      env(act("agent_card", card("red_team.b", "red_team", "red_team", "Red team")), T0 + 41 * S),
      env(act("agent_card", card("board.past", "evaluator", "board", "Board")), T0 + 61 * S),
    ]);
    const plan = planOffice(extra, record);
    const lay = stageLayout(plan);
    expect(lay.troupes.map((t) => [t.key, t.short, t.groupId])).toEqual([
      ["ACME CORP", "ACME CORP", "acme"],
      ["BETA INC", "Beta Inc", "beta"],
    ]);
    const acme = lay.troupes[0]?.x ?? 0;
    expect(lay.spots["ACME CORP:lane"]).toEqual({ x: acme - 78, y: 750 });
    expect(lay.spots["ACME CORP:pricing"]).toEqual({ x: acme - 56, y: 640 });
    expect(lay.spots["ACME CORP:technical"]).toEqual({ x: acme, y: 640 });
    expect(lay.spots["ACME CORP:past_performance"]).toEqual({ x: acme + 56, y: 640 });
    expect(lay.spots["ACME CORP:capture_lead"]).toEqual({ x: acme + 2, y: 746 });
    expect(lay.spots["ACME CORP:x0"]).toEqual({ x: acme + 90, y: 640 });
    expect(lay.traps["ACME CORP"]).toEqual({ x: acme, y: 772 });
    expect(lay.spots["HOME CO:lane"]).toEqual(HOME_LANE_SPOT);
    expect(lay.spots.red_team).toEqual(CORNER);
    expect(lay.spots["red_team:1"]?.x).toBeLessThan(CORNER.x);
    expect(lay.spots.analyst).toEqual(ANALYST_SPOT);
    expect([0, 1, 2].map((i) => lay.spots[`board:${i}`])).toEqual([...BOARD_SPOTS]);
    expect(lay.spots.verifier).toEqual(PROMPT);
    expect(lay.scale.verifier).toBe(1);
    void view;
  });

  it("files each source tier on its shelf; an unknown tier goes to Other", () => {
    expect(["federal_primary", "sec_filing", "company_owned", "news", "other", "mystery"].map(shelfOf)).toEqual(["federal", "sec", "company", "news", "other", "other"]);
  });

  it("history is in effect from the start; fresh events land at their recorded time", () => {
    expect(displayAt({ seq: 3, ts: T0 + 5 * S }, plain, 3)).toBe(-Infinity);
    expect(displayAt({ seq: 4, ts: T0 + 5 * S }, plain, 3)).toBe(5 * S);
  });

  it("knows the stage and the phase at any instant", () => {
    const { record } = scenario();
    const edges = stageEdges(record, plain, 0);
    expect(startedAt(edges, -1)).toBeNull();
    expect(phaseAt(edges, -1)).toBeNull();
    expect(startedAt(edges, 13 * S)?.stage).toBe("S4");
    expect(phaseAt(edges, 13 * S)).toBe("research");
    expect(phaseAt(edges, 32 * S)).toBe("verify");
    expect(phaseAt(edges, Infinity)).toBe("wargame");
    expect(edges.find((e) => e.stage === "S6" && e.edge === "finished")?.status).toBe("degraded");
  });
});

describe("the gates", () => {
  it("the curtain stays down until the cast is known and while the run waits at H1", () => {
    const { record } = scenario();
    const g = gates(record, rec);
    expect(curtainAt(g(1 * S), 1 * S)).toEqual({ open: false, h1: null });
    const waiting = curtainAt(g(6 * S), 6 * S);
    expect(waiting).toEqual({ open: false, h1: { phase: "waiting", waitedMs: 2 * S, parkTs: T0 + 4 * S } });
    // the approval's recorded time turns the placard; the curtain rises with the next stage
    expect(curtainAt(g(11 * S), 11 * S)).toEqual({ open: false, h1: { phase: "approved", waitedMs: 6 * S, parkTs: T0 + 4 * S } });
    const rising = curtainAt(g(12 * S + 100), 12 * S + 100);
    expect(rising.open).toBe(true);
    expect(rising.h1?.phase).toBe("approved");
    expect(curtainAt(g(12 * S + CURTAIN_MS), 12 * S + CURTAIN_MS)).toEqual({ open: true, h1: null });
    expect(curtainAt(g(Infinity), Infinity)).toEqual({ open: true, h1: null });
  });

  it("with no approval row the resume is the approval; a live wait grows with the clock; history opens at once", () => {
    const { record } = scenario();
    const none = gates(record, rec, { approvals: [] });
    expect(curtainAt(none(9 * S), 9 * S).h1).toEqual({ phase: "waiting", waitedMs: 5 * S, parkTs: T0 + 4 * S });
    expect(curtainAt(none(12 * S + 10), 12 * S + 10).h1).toEqual({ phase: "approved", waitedMs: 8 * S, parkTs: T0 + 4 * S });
    // live, parked: only what was recorded up to the park exists yet
    const parked = { ...record, stages: record.stages.filter((s) => s.seq < 5), parks: record.parks.slice(0, 1) };
    const live = gates(parked, () => T0 + 70 * S, { approvals: [] });
    expect(curtainAt(live(8 * S), 8 * S).h1).toEqual({ phase: "waiting", waitedMs: 66 * S, parkTs: T0 + 4 * S });
    const history = gates(record, rec, { settled: 999 });
    expect(curtainAt(history(0), 0)).toEqual({ open: true, h1: null });
  });

  it("the H2 banner shows from the park at H2 and turns once the decision is recorded", () => {
    const { record } = scenario();
    const g = gates(record, rec);
    expect(h2At(g(6 * S), 6 * S)).toBeNull();
    expect(h2At(g(74 * S), 74 * S)).toBeNull();
    expect(h2At(g(80 * S), 80 * S)).toEqual({ decided: false, decidedTs: null, waitedMs: 5 * S, parkTs: T0 + 75 * S });
    expect(h2At(g(Infinity), Infinity)).toEqual({ decided: true, decidedTs: T0 + 90 * S, waitedMs: 15 * S, parkTs: T0 + 75 * S });
    const review = { ...record, parks: [...record.parks.slice(0, 1), { ...record.parks[1]!, state: "awaiting_review" }] };
    expect(h2At(gates(review, rec)(80 * S), 80 * S)?.decided).toBe(false);
  });

  it("the playbill reads each stage's and gate's status at the frame", () => {
    const { record } = scenario();
    const g = gates(record, rec);
    expect(playbillAt(g(6 * S), 6 * S)).toEqual({ S0: "done", S3: "done", H1: "waiting" });
    const mid = playbillAt(g(20 * S), 20 * S);
    expect(mid).toMatchObject({ H1: "approved", S4: "done", S6: "running" });
    expect(playbillAt(g(Infinity), Infinity)).toMatchObject({ S6: "degraded", S10: "done", H1: "approved", H2: "approved" });
    expect(playbillAt(gates(record, rec, { approvals: [] })(80 * S), 80 * S)).toMatchObject({ H1: "approved", H2: "waiting" });
  });
});

describe("the easel", () => {
  const setup = () => {
    const s = scenario();
    const edges = stageEdges(s.record, plain, 0);
    const ordered = replayOrder(s.view.messages);
    return { ...s, edges, ordered };
  };

  it("reads the stage and its question, the acts of the swarm, the gates, and a stage that finished with gaps", () => {
    const { edges, ordered } = setup();
    const card = (t: number, over: Partial<Parameters<typeof easelAt>[0]> = {}) => easelAt({ edges, ordered, sent: 0, h1: null, h2: null, ...over }, t);
    expect(card(-1)).toEqual({ title: "Casting", sub: "Before the first stage" });
    expect(card(13 * S)).toEqual({ title: "S4 · Evidence", sub: "What is each agent finding, and from where?" });
    expect(card(30 * S + 100).sub).toBe("S6 Dossier: done with gaps");
    expect(card(31 * S + 200)).toMatchObject({ title: "S7 · Verify", sub: "S6 Dossier: done with gaps" });
    expect(card(30 * S + EASEL_NOTE_MS + 10).sub).toBe("Which claims held up against their sources, and which were withheld?");
    expect(card(45 * S, { sent: 1 })).toEqual({ title: "Act I", sub: "Briefs and strategy" });
    expect(card(50 * S, { sent: 3 })).toEqual({ title: "Act II", sub: "Red-team challenge" });
    expect(card(55 * S, { sent: 5 })).toEqual({ title: "Act III", sub: "Response and interview" });
    expect(card(65 * S, { sent: 6 })).toEqual({ title: "The board", sub: "Board scoring" });
    expect(card(73 * S, { sent: 7 }).title).toBe("The board");
    const later = [...edges, { at: 72 * S, seq: 99, ts: T0 + 72 * S, stage: "S11" as const, edge: "started" as const, status: null }];
    expect(easelAt({ edges: later, ordered, sent: 7, h1: null, h2: null }, 73 * S)).toEqual({ title: "S11 · Counters", sub: "What do we say to beat each rival?" });
    expect(card(6 * S, { h1: { phase: "waiting", waitedMs: 1, parkTs: 0 } })).toEqual({ title: "H1 · Plan review", sub: "Waiting for your approval" });
    expect(card(11 * S, { h1: { phase: "approved", waitedMs: 1, parkTs: 0 } }).sub).toBe("Approved");
    expect(card(12 * S + 10, { h1: { phase: "approved", waitedMs: 1, parkTs: 0 } }).title).toBe("S4 · Evidence");
    expect(card(80 * S, { h2: { decided: false, decidedTs: null, waitedMs: 0, parkTs: 0 } })).toEqual({ title: "H2 · Decision", sub: "Your bid / no-bid call" });
    expect(card(99 * S, { h2: { decided: true, decidedTs: 1, waitedMs: 0, parkTs: 0 } }).sub).toBe("Bid / no-bid call recorded");
  });
});

describe("research", () => {
  it("pulls one book per fresh fetch from its shelf, holding a blocked one longer and dropping an error sooner", () => {
    const { record } = scenario();
    const all = books(record, plain, 0);
    expect(all.map((b) => [b.lane, b.shelf, b.status])).toEqual([
      ["ACME CORP", "federal", "ok"],
      ["ACME CORP", "sec", "blocked"],
      ["ACME CORP", "company", "ok"],
      ["ACME CORP", "news", "ok"],
      ["BETA INC", "other", "error"],
    ]);
    expect(all[1]?.end).toBe((all[1]?.start ?? 0) + BOOK_MS.blocked);
    expect(all[4]?.end).toBe(14 * S + BOOK_MS.error);
    expect(books(record, plain, 10)).toHaveLength(3);
  });

  it("flies at most three books per researcher, newest first, and counts the rest", () => {
    const { record } = scenario();
    const all = books(record, plain, 0);
    const mid = flyingAt(all, 13 * S + 650);
    expect(mid.flying.map((b) => b.shelf)).toEqual(["sec", "company", "news"]);
    expect(mid.extra).toEqual({ "ACME CORP": 1 });
    expect(flyingAt(all, 14 * S + 100).flying.map((b) => b.lane)).toEqual(["ACME CORP", "ACME CORP", "ACME CORP", "BETA INC"]);
    expect(flyingAt(all, 20 * S).flying).toEqual([]);
  });

  it("counts each trunk's sources and claims at the frame; a verdict with no recorded rival is unattributed", () => {
    const { record } = scenario();
    const early = trunksAt(record, plain, 0, 13 * S + 250);
    expect(early.lanes["ACME CORP"]).toMatchObject({ ok: 1, blocked: 1, error: 0 });
    const end = trunksAt(record, plain, 0, Infinity);
    expect(end.lanes["ACME CORP"]).toEqual({ ok: 3, blocked: 1, error: 0, supported: 1, partly: 0, withheld: 0 });
    expect(end.lanes["BETA INC"]).toEqual({ ok: 0, blocked: 0, error: 1, supported: 0, partly: 0, withheld: 1 });
    expect(end.unattributed).toBe(2);
  });

  it("shows each lane's latest activity line without naming the rival again", () => {
    const { record } = scenario();
    expect(laneLinesAt(record, plain, 0, 12 * S)).toEqual({});
    expect(laneLinesAt(record, plain, 0, 13 * S)).toEqual({ "ACME CORP": "Reading federal records" });
    expect(laneLinesAt(record, plain, 0, Infinity)).toEqual({ "ACME CORP": "Drafting the dossier (attempt 1 of 3)" });
    expect(trimSubject("GET api.sam.gov (sam.entity)", "ACME CORP")).toBe("GET api.sam.gov (sam.entity)");
    expect(trimSubject("Waiting for review for SOMEONE ELSE", "ACME CORP")).toBe("Waiting for review for SOMEONE ELSE");
  });
});

describe("the prompter", () => {
  it("counts a burst on one slip and gives each withheld claim its own slip inside it", () => {
    const { record } = scenario();
    expect(promptAt(record, plain, 0, 31 * S)).toEqual({ strike: null, slip: null, withheld: null });
    const first = promptAt(record, plain, 0, 32 * S + 50);
    // only what is recorded by the frame: one verdict so far is one slip, with no count of verdicts still to come
    expect(first.slip).toMatchObject({ kind: "one", seq: 19 });
    expect(first.slip).not.toHaveProperty("total");
    expect(first.strike).toBe("b:19");
    const mid = promptAt(record, plain, 0, 32 * S + 150);
    expect(mid.slip).toEqual({ kind: "burst", seq: 19, checked: 2, start: 32 * S });
    expect(mid.withheld).toEqual({ seq: 21, words: "Beta lists a ceiling rate of forty...", start: 32 * S + 100 });
    expect(mid.strike).toBe("w:21");
    expect(promptAt(record, plain, 0, 32 * S + 100 + WITHHELD_HOLD_MS).withheld).toBeNull();
    expect(promptAt(record, plain, 0, 32 * S + 200 + SLIP_HOLD_MS).slip).toBeNull();
  });

  it("a lone verdict gets its words; a lone withheld verdict only its redacted slip; history stamps nothing", () => {
    const { record } = scenario();
    const lone = promptAt(record, plain, 0, 36 * S + 10);
    expect(lone.slip).toBeNull();
    expect(lone.withheld?.seq).toBe(25);
    const single = { ...record, verifies: record.verifies.slice(0, 1) };
    expect(promptAt(single, plain, 0, 32 * S + 10).slip).toEqual({ kind: "one", seq: 19, verdict: "supported", words: "Acme holds the incumbent contract with two...", start: 32 * S });
    expect(promptAt(record, plain, 999, 40 * S)).toEqual({ strike: null, slip: null, withheld: null });
  });
});

describe("model calls", () => {
  const calls = [
    { createdAt: iso(T0 + 14 * S), stage: "S4", purpose: "s4.quotes", latencyMs: 1000 },
    { createdAt: iso(T0 + 20 * S), stage: "S6", purpose: "s6.dossier", latencyMs: 4000 },
    { createdAt: iso(T0 + 21 * S), stage: "S6", purpose: "gate.council", latencyMs: null },
    { createdAt: iso(T0 + 22 * S), stage: "S6", purpose: "gate.sentinel", latencyMs: 3000 },
    { createdAt: null, stage: "S6", purpose: "s6.dossier", latencyMs: 10 },
    { createdAt: iso(T0 + 50 * S), stage: "S9", purpose: "s9.swarm.pricing", latencyMs: 1000 },
  ];

  it("lights the archive for S4's calls and the prompt desk for S6's, for exactly each recorded window", () => {
    const w = callWindows(calls, plain);
    expect(w).toEqual([
      { stage: "S4", purpose: "s4.quotes", start: 13 * S, end: 14 * S },
      { stage: "S6", purpose: "s6.dossier", start: 16 * S, end: 20 * S },
      { stage: "S6", purpose: "gate.council", start: 21 * S, end: 21 * S },
      { stage: "S6", purpose: "gate.sentinel", start: 19 * S, end: 22 * S },
    ]);
    expect(callsAt(w, 13 * S + 500)).toEqual({ archive: 1, prompt: {} });
    expect(callsAt(w, 19 * S + 500)).toEqual({ archive: 0, prompt: { drafting: 1, "sentinel check": 1 } });
    expect(callsAt(w, 14 * S)).toEqual({ archive: 0, prompt: {} });
  });

  it("names what a call is doing", () => {
    expect(["s6.dossier", "gate.sentinel", "gate.council", "s4.quotes", "s4.triage.jev", "other"].map(callDoing)).toEqual([
      "drafting",
      "sentinel check",
      "council review",
      "reading quotes",
      "triage",
      "model call",
    ]);
  });
});

describe("the swarm on stage", () => {
  const setup = () => {
    const s = scenario();
    const sched = buildSchedule(s.plan, s.view, s.record, plain);
    return { ...s, sched };
  };

  it("brings the devil up through the trap of the troupe it challenges, the newest delivery winning", () => {
    const { plan, view, sched } = setup();
    expect(devilAt(sched, plan, view, 40 * S)).toEqual({ pose: "corner", peek: [] });
    // both challenges are being written: horns peek from both traps
    expect(devilAt(sched, plan, view, 46 * S)).toEqual({ pose: "corner", peek: ["ACME CORP", "BETA INC"] });
    expect(devilAt(sched, plan, view, 50 * S + 100)).toEqual({ pose: "trap", pod: "ACME CORP", from: 50 * S, to: 50 * S + 2600, peek: ["BETA INC"] });
    expect(devilAt(sched, plan, view, 51 * S + 100)).toMatchObject({ pose: "trap", pod: "BETA INC", peek: [] });
    expect(devilAt(sched, plan, view, 60 * S)).toEqual({ pose: "corner", peek: [] });
  });

  it("a challenge to two troupes, or a red-team message that is not a challenge, opens no trap", () => {
    const { plan, view, record } = setup();
    const wide = {
      ...view,
      messages: view.messages.map((m) =>
        m.messageId === "m3" ? { ...m, to: ["acme.capture_lead", "beta.capture_lead"] } : m.messageId === "m4" ? { ...m, kind: "interview" as const } : m,
      ),
    };
    const sched = buildSchedule(plan, wide, record, plain);
    expect(devilAt(sched, plan, wide, 46 * S)).toEqual({ pose: "corner", peek: [] });
    expect(devilAt(sched, plan, wide, 50 * S + 100)).toEqual({ pose: "corner", peek: [] });
  });

  it("aims the two follow-spots at the agents whose model calls started last", () => {
    const { plan, sched } = setup();
    const t = 45 * S;
    const frame = frameAt(plan, sched, t);
    expect(spotTargets(sched, frame, t)).toEqual(["red_team", "ACME CORP:capture_lead"]);
    expect(spotTargets(sched, frameAt(plan, sched, 80 * S), 80 * S)).toEqual([]);
  });
});

describe("the board", () => {
  const setup = () => {
    const s = scenario();
    const sched: Schedule = buildSchedule(s.plan, s.view, s.record, plain);
    return { ...s, sched, edges: stageEdges(s.record, plain, 0) };
  };

  it("keeps only integer ratings from 1 to 5", () => {
    expect(ratingsOf({ data: { ratings: { B: 3, A: 4, C: 7, D: 2.5, E: "4" } } })).toEqual([
      ["A", 4],
      ["B", 3],
    ]);
    expect(ratingsOf({ data: { ratings: [1, 2] } })).toEqual([]);
    expect(ratingsOf({ data: {} })).toEqual([]);
  });

  it("drops the scrim at S10, lists the codes rated so far, and clears it when the result unblinds the troupes", () => {
    const { view, sched, edges } = setup();
    const input = { edges, view, sched, settledSeq: 0, clock: plain };
    expect(scrimAt(input, 59 * S)).toEqual({ state: "none" });
    expect(scrimAt(input, 61 * S)).toEqual({ state: "masked", codes: [] });
    // the failed call's ratings never count; a non-integer or out-of-range rating names no code
    expect(scrimAt(input, 66 * S)).toEqual({ state: "masked", codes: ["A", "D"] });
    expect(scrimAt(input, 70 * S)).toEqual({ state: "clear" });
    expect(scrimAt({ ...input, edges: [] }, 71 * S)).toEqual({ state: "clear" });
    expect(scrimAt({ ...input, view: { ...view, boardSeen: null } }, 99 * S)).toMatchObject({ state: "masked" });
  });

  it("hangs each critic's recorded ratings on the box rail; a failed or rejected call shows none", () => {
    const { view, plan, sched } = setup();
    expect(scorecards({ view, plan, sched }, 63 * S)).toEqual([]);
    const all = scorecards({ view, plan, sched }, Infinity);
    expect(all.map((c) => [c.seat, c.focus, c.pairs, c.state])).toEqual([
      [
        "board:0",
        "Technical",
        [
          ["A", 4],
          ["D", 2],
        ],
        "completed",
      ],
      ["board:1", "Management", [], "failed"],
    ]);
    // a rating from an agent with no seat still hangs its row
    const ghost = { ...msg({ messageId: "r3", from: "board.ghost", to: ["board"], kind: "rating", round: 4, data: { ratings: { C: 1 } } }), seq: 99, ts: iso(T0 + 66 * S) };
    const stray = { ...view, messages: [...view.messages, ghost] };
    const withStray = buildSchedule(plan, stray, setup().record, plain);
    expect(scorecards({ view: stray, plan, sched: withStray }, Infinity).find((c) => c.msgId === "r3")).toMatchObject({ seat: null, focus: "board.ghost", pairs: [["C", 1]] });
    expect(criticFocus(undefined, "board.x")).toBe("board.x");
    expect(criticFocus({ name: "Lone evaluator", skills: ["fit to the work"] }, "x")).toBe("fit to the work");
    expect(criticFocus({ name: "Lone evaluator", skills: [] }, "x")).toBe("Lone evaluator");
  });

  it("unblinds each troupe's placard by group id, else by name, and words the headline as simulated", () => {
    const { plan } = setup();
    expect(placards(board, plan)).toEqual([
      { pod: "ACME CORP", code: "B", share: 0.62, incumbent: true },
      { pod: "BETA INC", code: "A", share: 0.38, incumbent: false },
    ]);
    expect(placards(null, plan)).toEqual([]);
    expect(headline(board)).toBe("Simulated board: B (ACME CORP) 62% of the vote. Not a decision input.");
    expect(headline({ ...board, rows: [{ ...board.rows[1]!, code: "" }] })).toBe("Simulated board: Beta Inc 38% of the vote. Not a decision input.");
    expect(headline(null)).toBeNull();
    expect(headline({ ...board, rows: [] })).toBeNull();
  });
});

describe("the Playhouse replay and clock", () => {
  it("holds gates, withheld verdicts and real work apart on the replay clock", () => {
    const { record } = scenario();
    const calls = [
      { createdAt: iso(T0 + 20 * S), stage: "S6", purpose: "s6.dossier", latencyMs: 4000 },
      { createdAt: iso(T0 + 50 * S), stage: "S9", purpose: "s9.swarm.pricing", latencyMs: 1000 },
      { createdAt: null, stage: "S4", purpose: "s4.quotes", latencyMs: 1 },
    ];
    const keys = playhouseWarpKeys({ record, approvals, calls });
    expect(keys).toContainEqual({ t: T0 + 4 * S });
    expect(keys).toContainEqual({ t: T0 + 10 * S, minStep: GATE_HOLD_MS });
    expect(keys.find((k) => k.t === T0 + 12 * S)?.minStep).toBeGreaterThan(0);
    expect(keys).toContainEqual({ t: T0 + 90 * S, minStep: GATE_HOLD_MS });
    expect(keys.filter((k) => k.minStep === WITHHELD_STEP_MS)).toHaveLength(2);
    expect(keys).toContainEqual({ t: T0 + 17 * S });
    expect(keys).toContainEqual({ t: T0 + 16 * S });
    expect(keys).toContainEqual({ t: T0 + 20 * S });
    expect(keys.some((k) => k.t === T0 + 49 * S)).toBe(false);
    // no approval rows: the resume itself holds the gate
    const bare = playhouseWarpKeys({ record, approvals: [], calls: [] });
    expect(bare.find((k) => k.t === T0 + 12 * S)?.minStep).toBe(GATE_HOLD_MS);
  });

  it("an interrupted run's park adds only its own time; a call with no latency is an instant", () => {
    const { record } = scenario();
    const odd = { ...record, parks: [{ seq: 5, ts: T0 + 4 * S, state: "interrupted" }], verifies: [], notes: [] };
    const keys = playhouseWarpKeys({ record: odd, approvals, calls: [{ createdAt: iso(T0 + 14 * S), stage: "S4", purpose: null, latencyMs: null }] });
    expect(keys).toEqual([{ t: T0 + 4 * S }, { t: T0 + 14 * S }, { t: T0 + 14 * S }]);
  });

  it("a run still parked keeps its recorded park time; its wait is unknown without a clock and real with one", () => {
    const { record } = scenario();
    const parked = { ...record, stages: record.stages.filter((s) => s.seq < 5), parks: record.parks.slice(0, 1) };
    // the final frame has no "now": no made-up wait, but the park time is the record's
    expect(curtainAt(gates(parked, rec, { approvals: [] })(Infinity), Infinity).h1).toEqual({ phase: "waiting", waitedMs: null, parkTs: T0 + 4 * S });
    expect(h2At(gates(record, rec, { approvals: [] })(Infinity), Infinity)).toEqual({ decided: false, decidedTs: null, waitedMs: null, parkTs: T0 + 75 * S });
    // a view that reads the wall clock (a run parked now) shows the true wait since the recorded park
    const wall = (t: number) => ({ ...gates(record, rec, { approvals: [] })(t), nowRecorded: T0 + 75 * S + 30 * 60 * 1000 });
    expect(h2At(wall(Infinity), Infinity)?.waitedMs).toBe(30 * 60 * 1000);
    const wallH1 = { ...gates(parked, rec, { approvals: [] })(Infinity), nowRecorded: T0 + 4 * S + 90 * S };
    expect(curtainAt(wallH1, Infinity).h1?.waitedMs).toBe(90 * S);
  });

  it("measures the run for the house clock and words waits", () => {
    const { record, view } = scenario();
    expect(runSpan(record, view)).toEqual({ first: T0, last: T0 + 75 * S });
    expect(runSpan({ ...record, stages: [], parks: [], fetches: [] }, { ...view, messages: [], boardSeen: null })).toBeNull();
    expect(houseTime(6 * 60 * S + 41 * S + 900)).toBe("T+06:41");
    expect(houseTime(-5)).toBe("T+00:00");
    expect(waitWords(161 * S)).toBe("2m 41s");
    expect(waitWords(13_400)).toBe("13s");
  });
});

describe("what a place may reveal", () => {
  it("shows an agent's card only once the agent is on stage at the frame", () => {
    const card = { agentId: "a", name: "Pricing" };
    expect(cardShown(card, true)).toBe(card);
    expect(cardShown(card, false)).toBeUndefined();
    expect(cardShown(undefined, true)).toBeUndefined();
  });
});

describe("the caption's cast", () => {
  it("names only agents at work on a known seat: never a rival not yet named", () => {
    const plan = {
      order: ["ACME:lane", "red_team", "BETA:lane"],
      seats: {
        "ACME:lane": { id: "ACME:lane", role: "researcher", zone: "pod", pod: "ACME", team: 0, at: { x: 0, y: 0 }, agentId: null },
        "BETA:lane": { id: "BETA:lane", role: "researcher", zone: "pod", pod: "BETA", team: 1, at: { x: 0, y: 0 }, agentId: null },
        red_team: { id: "red_team", role: "red_team", zone: "red_team", pod: null, team: -1, at: { x: 0, y: 0 }, agentId: "r" },
      },
    } as unknown as OfficePlan;
    const busy = { activity: "browsing" } as const;
    const frame = { seats: { "ACME:lane": busy, "BETA:lane": busy, red_team: { activity: "typing" } } } as unknown as OfficeFrame;
    const onlyAcme = { hasRival: (k: string) => k === "ACME" };
    expect(castAt(plan, frame, onlyAcme)).toEqual(["ACME:lane", "red_team"]);
    expect(castAt(plan, frame, { hasRival: () => false })).toEqual(["red_team"]);
  });
});

describe("model calls from the whole record at a replay cursor", () => {
  it("shows a call in flight at the cursor (started, not yet returned) and none that start later", () => {
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    const calls = [
      { createdAt: at(20_000), stage: "S4", purpose: null, latencyMs: 15_000 },
      { createdAt: at(30_000), stage: "S6", purpose: "s6.dossier", latencyMs: 12_000 },
      { createdAt: at(60_000), stage: "S6", purpose: "s6.dossier", latencyMs: 5_000 },
    ];
    const windows = callWindows(calls, plain);
    // at 19 s: the S4 call (5-20 s) and the first S6 call (18-30 s) are in flight; the third starts at 55 s
    expect(callsAt(windows, 19_000)).toEqual({ archive: 1, prompt: { drafting: 1 } });
    expect(callsAt(windows, 40_000)).toEqual({ archive: 0, prompt: {} });
  });
});

describe("tooltip words are read fresh from the frame", () => {
  it("a trunk's words follow the cursor: a seek back changes them, and before any source they are gone", () => {
    const { record } = scenario();
    const late = trunksAt(record, plain, 0, Infinity);
    const key = Object.keys(late.lanes)[0] ?? "";
    const atEnd = trunkTip("Acme Corp", late.lanes[key]);
    const firstFetch = Math.min(...record.fetches.filter((f) => f.lane === key).map((f) => f.ts)) - T0;
    const early = trunkTip("Acme Corp", trunksAt(record, plain, 0, firstFetch).lanes[key]);
    expect(atEnd).not.toBeNull();
    expect(early).not.toBeNull();
    expect(early?.lines).not.toEqual(atEnd?.lines);
    expect(trunkTip("Acme Corp", trunksAt(record, plain, 0, firstFetch - 1).lanes[key])).toBeNull();
  });

  it("the prompt desk reports only the verdicts recorded by the frame", () => {
    expect(deskTip({ supported: 0, partly: 0, withheld: 0 }, 0).lines[0]).toBe("No claims checked yet");
    expect(deskTip({ supported: 3, partly: 1, withheld: 2 }, 1).lines).toEqual(["6 claims checked: 3 held up, 1 partly, 2 withheld", "1 verdicts carry no recorded rival (unattributed)"]);
  });
});

describe("a seat's card at the frame", () => {
  it("turns into the agent's card once the agent arrives while the seat stays hovered", () => {
    const card = { agentId: "p1", name: "Acme pricing" };
    expect(seatTip({ role: "Pricing", present: false, card })).toEqual({ kind: "text", title: "Pricing", lines: ["Not on stage yet."] });
    expect(seatTip({ role: "Pricing", present: true, card: undefined })).toEqual({ kind: "text", title: "Pricing", lines: ["No agent card recorded for this place."] });
    expect(seatTip({ role: "Pricing", present: true, card })).toEqual({ kind: "agent", card });
  });
});
