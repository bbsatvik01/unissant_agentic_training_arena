import { describe, expect, it } from "vitest";

import type { AgentCard, AgentCitation, AgentMessage, RunEvent, RunEventEnvelope } from "@/lib/contracts/run-events";

import {
  CREW_ROLES,
  boardKeys,
  boardSlotRow,
  isFetchEcho,
  laneText,
  codenameRects,
  codesOf,
  crewRoleOf,
  fanRects,
  initials,
  memosByRow,
  memoTargets,
  planBoard,
  ratingsOf,
  restAngle,
  roundEmphasis,
  tagRects,
  tagsByRow,
  threadPath,
  threadsAt,
  VIEW_H,
  VIEW_W,
  wrapText,
  rovingIndex,
  dossierTipWords,
  type Rect,
} from "./case-board";
import { foldCommand } from "./command";
import { SEND_MS, type Schedule } from "./office";
import { foldSwarm, type SwarmView } from "./swarm";

const T0 = Date.parse("2026-10-04T02:54:46.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
function env(event: RunEvent, at: number, idemKey?: string): RunEventEnvelope {
  seq += 1;
  return { seq, runId: "r", idemKey: idemKey ?? `k${seq}`, ts: iso(at), event };
}
const act = (activityType: string, content: unknown) => ({ type: "ACTIVITY_SNAPSHOT", messageId: `a${seq}`, activityType, content }) as unknown as RunEvent;
const card = (agentId: string, role: string, group: string, groupLabel: string): AgentCard => ({ agentId, name: `${role}, ${groupLabel}`, role, group, groupLabel, stage: group === "board" ? "S10" : "S9", skills: [], reads: "accepted claims" });
const cite = (code: string, claimId: string): AgentCitation => ({ code, claimId, text: `fact ${code}` });
const msg = (id: string, from: string, to: string[], contextId: string, round: number, kind: AgentMessage["kind"], citations: AgentCitation[] = [], extra: Partial<AgentMessage> = {}): AgentMessage => ({
  messageId: id,
  contextId,
  taskId: id,
  stage: round === 4 ? "S10" : "S9",
  round,
  kind,
  role: "agent",
  from,
  to,
  state: "completed",
  text: `${kind} text from ${from} with several words in it to read`,
  reasoning: "",
  citations,
  dropped: 0,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1000, model: "m", free: true },
  data: {},
  ...extra,
});

function swarm(): SwarmView {
  seq = 0;
  const envs: RunEventEnvelope[] = [
    env(act("agent_card", card("red_team", "red_team", "red_team", "Red team")), T0),
    env(act("agent_card", card("analyst", "analyst", "analyst", "Home team")), T0),
    ...["pricing", "technical", "past_performance", "capture_lead"].map((r) => env(act("agent_card", card(`TRK.${r}`, r, "TRK", "CGI FEDERAL INC.")), T0)),
    ...["pricing", "capture_lead"].map((r) => env(act("agent_card", card(`L48.${r}`, r, "L48", "AKUMEN, INC.")), T0)),
    env(act("agent_message", msg("m1", "TRK.pricing", ["TRK.capture_lead"], "TRK", 1, "brief", [cite("E1", "c1"), cite("E2", "c2"), cite("E1", "c1")])), T0 + 10_000),
    env(act("agent_message", msg("m2", "TRK.capture_lead", ["red_team"], "TRK", 1, "strategy", [cite("E2", "c2"), cite("E3", "c3"), cite("E4", "c4"), cite("E5", "c5"), cite("E6", "c6"), cite("E7", "c7"), cite("E8", "c8")])), T0 + 20_000),
    env(act("agent_message", msg("m3", "red_team", ["TRK.capture_lead"], "TRK", 2, "challenge", [cite("E3", "c3")])), T0 + 30_000),
    env(act("agent_message", msg("m4", "TRK.capture_lead", ["board", "red_team"], "TRK", 3, "response")), T0 + 40_000),
    env(act("agent_message", msg("m5", "L48.pricing", ["L48.capture_lead"], "L48", 1, "brief", [cite("E1", "a1")], { state: "failed" })), T0 + 41_000),
    env(act("agent_message", msg("m6", "TRK.capture_lead", ["analyst"], "TRK", 3, "interview", [cite("E9", "c9")])), T0 + 42_000),
    env(act("agent_card", card("board.technical", "evaluator", "board", "Evaluation board (de-identified)")), T0 + 50_000),
    env(act("agent_card", card("board.management", "evaluator", "board", "Evaluation board (de-identified)")), T0 + 50_000),
    env(act("agent_message", msg("m7", "board.technical", ["board"], "board", 4, "rating", [], { data: { ratings: { B: 3, A: 4 } } })), T0 + 55_000),
    env(act("agent_message", msg("m8", "board.management", ["board"], "board", 4, "rating", [], { data: { ratings: { A: 2, C: 5, junk: "x" } } })), T0 + 56_000),
  ];
  return foldSwarm(envs);
}

const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= VIEW_W && r.y + r.h <= VIEW_H && r.w > 0 && r.h > 0;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const pods = (n: number) => ({ pods: Array.from({ length: n }, (_, i) => ({ key: `R${i}` })) });

describe("planBoard", () => {
  for (let n = 1; n <= 6; n++) {
    it(`lays out ${n} rival rows inside the view, without overlaps, at equal heights`, () => {
      const b = planBoard(pods(n));
      expect(b.rows).toHaveLength(n);
      expect(b.overflow).toBeNull();
      const heights = new Set(b.rows.map((r) => Math.round(r.band.h * 1000)));
      expect(heights.size).toBe(1);
      for (const row of b.rows) {
        const rects = [row.dossier, row.fan, row.ledger, row.memo, row.slot, ...CREW_ROLES.map((r) => row.crew[r])];
        for (const r of rects) {
          expect(inside(r)).toBe(true);
          // inside its own band
          expect(r.y).toBeGreaterThanOrEqual(row.band.y);
          expect(r.y + r.h).toBeLessThanOrEqual(row.band.y + row.band.h + 0.001);
        }
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!), `${row.key} ${i}/${j}`).toBe(false);
      }
      // rows never overlap each other, the header, the jury column or the footer
      for (let i = 1; i < b.rows.length; i++) expect(b.rows[i]!.band.y).toBeGreaterThanOrEqual(b.rows[i - 1]!.band.y + b.rows[i - 1]!.band.h - 0.001);
      const fixed = [b.header.caseCard, b.header.tPlus, b.header.wall, b.header.stage, b.header.h1, b.header.h2, b.footer.red, b.footer.verifier, b.footer.analyst, b.footer.incidents, b.jury.header];
      for (const r of fixed) expect(inside(r)).toBe(true);
      for (const row of b.rows) for (const r of [b.header.caseCard, b.footer.red, b.jury.column]) expect(overlap(row.band, r)).toBe(false);
      expect(row0(b).compact).toBe(n >= 5);
    });
  }

  it("keeps the stage chips in two rows of nine inside the header", () => {
    const b = planBoard(pods(4));
    const ids = Object.keys(b.header.chips);
    expect(ids).toEqual(["S0", "S1", "S2", "S3", "H1", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "H2"]);
    const chips = Object.values(b.header.chips);
    for (const c of chips) expect(inside(c)).toBe(true);
    for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) expect(overlap(chips[i]!, chips[j]!)).toBe(false);
  });

  it("adds an overflow row past six rivals", () => {
    const b = planBoard(pods(8));
    expect(b.rows).toHaveLength(6);
    expect(b.overflow?.keys).toEqual(["R6", "R7"]);
    expect(inside(b.overflow!.band)).toBe(true);
    expect(b.overflow!.band.y).toBeGreaterThanOrEqual(b.rows[5]!.band.y + b.rows[5]!.band.h - 0.001);
  });

  it("lays out the jury's codename cards for any count", () => {
    const b = planBoard(pods(4));
    for (const n of [0, 1, 4, 6, 9]) {
      const rects = codenameRects(b, n);
      expect(rects).toHaveLength(n);
      for (const r of rects) expect(inside(r)).toBe(true);
      for (let i = 1; i < rects.length; i++) expect(rects[i]!.y).toBeGreaterThanOrEqual(rects[i - 1]!.y + rects[i - 1]!.h);
    }
  });
});

const row0 = (b: ReturnType<typeof planBoard>) => b.rows[0]!;

describe("card helpers", () => {
  it("fans up to eight intel cards, newest at the right, the rest behind a count", () => {
    const fan = { x: 272, y: 100, w: 240, h: 120 };
    const three = fanRects(fan, 3, 50);
    expect(three.cards).toHaveLength(3);
    expect(three.more).toBeNull();
    expect(three.cards[0]!.x).toBeGreaterThan(three.cards[1]!.x);
    expect(three.cards[0]!.x + three.cards[0]!.w).toBeLessThanOrEqual(fan.x + fan.w);
    const many = fanRects(fan, 25, 50);
    expect(many.cards).toHaveLength(8);
    expect(many.hidden).toBe(17);
    expect(many.more!.x).toBeGreaterThanOrEqual(fan.x);
    expect(many.more!.x + many.more!.w).toBeLessThanOrEqual(many.cards.at(-1)!.x + 0.001);
    expect(fanRects(fan, 0, 50).cards).toEqual([]);
  });

  it("pins up to twelve evidence tags in two columns, then a count", () => {
    const ledger = { x: 522, y: 100, w: 230, h: 107 };
    const t = tagRects(ledger, 15);
    expect(t.tags).toHaveLength(12);
    expect(t.hidden).toBe(3);
    expect(t.more).not.toBeNull();
    for (const r of [...t.tags, t.more!]) {
      expect(r.x + r.w).toBeLessThanOrEqual(ledger.x + ledger.w);
      expect(r.y + r.h).toBeLessThanOrEqual(ledger.y + ledger.h);
    }
    expect(new Set(t.tags.map((r) => r.x)).size).toBe(2);
    expect(tagRects(ledger, 4).more).toBeNull();
  });

  it("gives each card a stable rest angle within 2.5 degrees", () => {
    const a = restAngle("memo:m1");
    expect(restAngle("memo:m1")).toBe(a);
    for (const id of ["a", "b", "intel:CGI:7", "tag:TRK:E3", "x".repeat(40)]) expect(Math.abs(restAngle(id))).toBeLessThanOrEqual(2.5);
    expect(new Set(["a", "b", "c", "d", "e"].map(restAngle)).size).toBeGreaterThan(2);
  });

  it("wraps text by character count and marks a cut", () => {
    expect(wrapText("one two three four five", 9, 2)).toEqual(["one two", "three..."]);
    expect(wrapText("short", 20, 2)).toEqual(["short"]);
    expect(wrapText("Supercalifragilistic word", 8, 2)).toEqual(["Supercal", "word"]);
    expect(wrapText("   ", 8, 2)).toEqual([]);
  });

  it("makes a monogram from a rival's short name", () => {
    expect(initials("CGI FEDERAL INC.")).toBe("CF");
    expect(initials("DELOITTE & TOUCHE LLP")).toBe("DT");
    expect(initials("AKUMEN, INC.")).toBe("A");
    expect(initials("")).toBe("?");
  });

  it("maps a card's role to a crew seat", () => {
    expect(crewRoleOf("pricing")).toBe("pricing");
    expect(crewRoleOf("evaluator")).toBeNull();
  });
});

describe("filing", () => {
  const view = swarm();
  const all = new Set(view.messages.map((m) => m.messageId));

  it("files memos in the row of their context, newest first; ratings go to the jury", () => {
    const f = memosByRow(view, all);
    expect(f.rows.TRK?.map((m) => m.messageId)).toEqual(["m6", "m4", "m3", "m2", "m1"]);
    expect(f.rows.L48?.map((m) => m.messageId)).toEqual(["m5"]);
    expect(f.jury.map((m) => m.messageId)).toEqual(["m8", "m7"]);
    const early = memosByRow(view, new Set(["m1", "m2"]));
    expect(early.rows.TRK?.map((m) => m.messageId)).toEqual(["m2", "m1"]);
    expect(early.jury).toEqual([]);
  });

  it("tags each row's cited codes once, in first-cited order, with the S7 verdict when recorded", () => {
    seq = 100;
    const cmd = foldCommand([
      env(act("verify", { claimId: "c1", claim: "x", verdict: "supported", sourceUnreachable: false }), T0, "g0:execute:S7:TRK:verdict:c1"),
      env(act("verify", { claimId: "c3", claim: "y", verdict: "unsupported", sourceUnreachable: false }), T0, "g0:execute:S7:TRK:verdict:c3"),
      env(act("verify", { claimId: "c3", claim: "y", verdict: "partially_supported", sourceUnreachable: false }), T0 + 1, "g0:execute:S7:TRK:verdict:c3b"),
    ]);
    const tags = tagsByRow(view, all, cmd);
    expect(tags.TRK?.map((t) => t.code)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]);
    expect(tags.TRK?.[0]).toEqual({ code: "E1", claimId: "c1", text: "fact E1", verdict: "supported" });
    // the latest verdict on a claim wins; a claim with none stays plain
    expect(tags.TRK?.[2]?.verdict).toBe("partly");
    expect(tags.TRK?.[1]?.verdict).toBeNull();
    // a failed message cites nothing
    expect(tags.L48).toBeUndefined();
    expect(tagsByRow(view, new Set(["m1"]), cmd).TRK?.map((t) => t.code)).toEqual(["E1", "E2"]);
  });

  it("reads the board's codes and each evaluator's ratings from the rating messages", () => {
    const sent = new Set(view.messages.map((m) => m.messageId));
    expect(codesOf(view, sent)).toEqual(["A", "B", "C"]);
    expect(ratingsOf(view, sent)).toEqual({ "board.technical": { A: 4, B: 3 }, "board.management": { A: 2, C: 5 } });
    expect(codesOf(view, new Set(["m7"]))).toEqual(["A", "B"]);
  });

  it("finds the row a board row lands in by its group", () => {
    const rows = [
      { key: "CGI FEDERAL INC.", groupId: "TRK" },
      { key: "AKUMEN, INC.", groupId: null },
    ];
    expect(boardSlotRow(rows, { group: "TRK", label: "CGI FEDERAL INC." })).toBe(0);
    expect(boardSlotRow(rows, { group: "L48", label: "Akumen, Inc." })).toBe(1);
    expect(boardSlotRow(rows, { group: "ZZZ", label: "Nobody" })).toBe(-1);
  });
});

describe("replay keys and lane lines", () => {
  it("adds the lines, parks, errors and approvals a replay must hold apart", () => {
    seq = 200;
    const cmd = foldCommand([
      env({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/lanes/A/activity", value: "Drafting the dossier (attempt 1 of 3) for A" }] }, T0),
      env({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/lanes/A/activity", value: "GET api.sam.gov (sam.entity)" }] }, T0 + 5),
      env({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { state: "awaiting_plan_approval" } }, T0 + 10),
      env({ type: "RUN_ERROR", message: "phase failed (x)", code: "x" }, T0 + 20),
    ]);
    const keys = boardKeys(cmd, { h1: { at: iso(T0 + 15) }, h2: { at: "not a time" } });
    expect(keys).toEqual([
      { t: T0, minStep: 120 },
      { t: T0 + 5 },
      { t: T0 + 10, minStep: 1200 },
      { t: T0 + 20, minStep: 1200 },
      { t: T0 + 15, minStep: 1200 },
    ]);
    expect(boardKeys(cmd, null)).toHaveLength(4);
  });

  it("drops the rival's name a lane line ends with, and spots fetch echoes", () => {
    expect(laneText("Drafting the dossier (attempt 1 of 3) for CGI FEDERAL INC.", "CGI FEDERAL INC.")).toBe("Drafting the dossier (attempt 1 of 3)");
    expect(laneText("Sentinel checking 77 claims for deloitte & touche llp", "DELOITTE & TOUCHE LLP")).toBe("Sentinel checking 77 claims");
    expect(laneText("Verifying 72 claims of the dossier", "CGI FEDERAL INC.")).toBe("Verifying 72 claims of the dossier");
    expect(isFetchEcho("GET api.sam.gov (sam.entity)")).toBe(true);
    expect(isFetchEcho("Reading SEC filings for X")).toBe(false);
  });
});

describe("threads", () => {
  const view = swarm();
  const all = new Set(view.messages.map((m) => m.messageId));
  const at = (id: string) => Date.parse(view.messages.find((m) => m.messageId === id)!.ts);
  const sched = {
    beats: view.messages.map((m) => ({ kind: "send" as const, id: `send:${m.messageId}`, seat: "s", to: [], start: Date.parse(m.ts), end: Date.parse(m.ts) + SEND_MS, seq: m.seq, msgId: m.messageId, text: m.text, failed: m.state !== "completed" })),
  } as unknown as Schedule;

  it("routes a message to each recipient once and its evidence to the cited tags (six at most)", () => {
    expect(memoTargets(view, view.messages.find((m) => m.messageId === "m4")!)).toEqual([{ kind: "jury" }, { kind: "agent", agentId: "red_team" }]);
    const t = threadsAt(sched, view, at("m2") + 10, all);
    const m2 = t.filter((x) => x.msgId === "m2");
    expect(m2.filter((x) => x.kind === "route").map((x) => x.to)).toEqual([{ kind: "agent", agentId: "red_team" }]);
    expect(m2.filter((x) => x.kind === "evidence").map((x) => (x.to.kind === "tag" ? x.to.code : ""))).toEqual(["E2", "E3", "E4", "E5", "E6", "E7"]);
    expect(m2.every((x) => x.active)).toBe(true);
    expect(t.find((x) => x.msgId === "m2" && x.kind === "evidence")?.more).toBe(1);
    // an earlier message is history
    expect(t.filter((x) => x.msgId === "m1").every((x) => !x.active)).toBe(true);
    // a message is active for SEND_MS
    expect(threadsAt(sched, view, at("m2") + SEND_MS + 1, all).some((x) => x.active && x.msgId === "m2")).toBe(false);
  });

  it("draws no thread for a failed message or a rating, and nothing unsent", () => {
    const t = threadsAt(sched, view, Infinity, all);
    expect(t.some((x) => x.msgId === "m5")).toBe(false);
    expect(t.some((x) => x.msgId === "m7" || x.msgId === "m8")).toBe(false);
    expect(threadsAt(sched, view, Infinity, new Set(["m1"])).every((x) => x.msgId === "m1")).toBe(true);
    // the response reaches the jury and the red team
    expect(t.filter((x) => x.msgId === "m4").map((x) => x.to.kind)).toEqual(["jury", "agent"]);
  });

  it("emphasises the current round and fades older ones", () => {
    expect(roundEmphasis(true, 1, 3)).toBe("active");
    expect(roundEmphasis(false, 3, 3)).toBe("current");
    expect(roundEmphasis(false, 2, 3)).toBe("past");
  });

  it("hangs a thread as a sagging quadratic curve", () => {
    expect(threadPath({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe("M0 0 Q50 8 100 0");
    expect(threadPath({ x: 0, y: 10 }, { x: 0, y: 1010 })).toBe("M0 10 Q0 1070 0 1010");
  });
});

describe("rovingIndex", () => {
  it("moves one card per arrow key, clamps at the ends, jumps with Home and End, and ignores other keys", () => {
    expect(rovingIndex(0, 5, "ArrowRight")).toBe(1);
    expect(rovingIndex(0, 5, "ArrowDown")).toBe(1);
    expect(rovingIndex(3, 5, "ArrowLeft")).toBe(2);
    expect(rovingIndex(3, 5, "ArrowUp")).toBe(2);
    expect(rovingIndex(4, 5, "ArrowRight")).toBe(4);
    expect(rovingIndex(0, 5, "ArrowLeft")).toBe(0);
    expect(rovingIndex(2, 5, "Home")).toBe(0);
    expect(rovingIndex(2, 5, "End")).toBe(4);
    expect(rovingIndex(2, 5, "Enter")).toBeNull();
    expect(rovingIndex(0, 0, "ArrowRight")).toBeNull();
  });
});

describe("a dossier's card is read from the frame", () => {
  it("its words follow the cursor (a seek back shows fewer sources) and say nothing that is not yet recorded", () => {
    const late = dossierTipWords({ label: "Acme Corp", fetched: 27, incumbent: true, counts: { supported: 74, partly: 0, withheld: 2 }, memos: 7 });
    const early = dossierTipWords({ label: "Acme Corp", fetched: 2, incumbent: true, counts: null, memos: 0 });
    expect(late.lines[0]).toBe("27 sources fetched, incumbent");
    expect(early.lines).toEqual(["2 sources fetched, incumbent", "No S7 verdicts recorded for this rival yet", "No memos yet"]);
  });
});
