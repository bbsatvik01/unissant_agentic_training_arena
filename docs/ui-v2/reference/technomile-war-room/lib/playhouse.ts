/**
 * The Black Hat Playhouse: an office style that stages the run as a paper toy theatre. A black hat review is
 * role-play, so research is the rehearsal, the S9 swarm is the play and the de-identified S10 board judges the
 * troupes through a scrim. Pure functions over the office's own model (`office.ts`): the same record, plan,
 * schedule and frames, placed on a front-on stage.
 *
 * Every state here comes from one recorded event at its recorded time on the shared display clock: the curtain
 * from stage edges, the H1 park and its approval; a book from each S4 fetch; a slip from each S7 verdict; a light
 * pool from a model call's recorded window; the devil from a red-team challenge; the scrim from the S10 start and
 * the board result. Anything at or before the history boundary (`settledSeq`) is already in place: `displayAt`
 * puts it at -Infinity, so it never moves.
 */
import type { BoardResult, SourceTier, StepStatus } from "@/lib/contracts/run-events";
import { phaseOf, STEP_META, type PhaseId, type StepId } from "@/lib/pipeline/steps";
import type { StageId } from "@/lib/stages";

import {
  podKey,
  STAMP_GAP_MS,
  STAMP_MS,
  type BeatClock,
  type OfficeFrame,
  type OfficePlan,
  type OfficeRecord,
  type Pt,
  type Schedule,
  type Verdict,
  type WarpKey,
} from "./office";
import { seatKnown, type Scene } from "./scene";
import { firstWords, ROUND_SHORT } from "./swarm-graph";
import { shortName, type SwarmItem, type SwarmView } from "./swarm";

/* ------------------------------------------------------------------------------------------------ the stage */

export const STAGE_W = 1600;
export const STAGE_H = 900;

/** The fixed places on the stage (feet positions, stage units). */
export const CORNER: Pt = { x: 200, y: 742 };
export const BOX_TABLE: Pt = { x: 1375, y: 344 };
export const PROMPT: Pt = { x: 1410, y: 756 };
export const ANALYST_SPOT: Pt = { x: 240, y: 876 };
export const HOME_LANE_SPOT: Pt = { x: 330, y: 876 };
export const BOARD_SPOTS: readonly Pt[] = [1322, 1375, 1428].map((x) => ({ x, y: 322 }));
const RED_EXTRA: readonly Pt[] = [
  { x: 156, y: 742 },
  { x: 244, y: 742 },
];

/** Where each troupe member stands, relative to the troupe's centre (x scales with the troupe; y is the floor). */
const LEAD_SLOT: Pt = { x: 2, y: 746 };
const SLOT: Readonly<Record<string, Pt>> = {
  lane: { x: -78, y: 750 },
  pricing: { x: -56, y: 640 },
  technical: { x: 0, y: 640 },
  past_performance: { x: 56, y: 640 },
  capture_lead: LEAD_SLOT,
  x0: { x: 90, y: 640 },
  x1: { x: -92, y: 640 },
  x2: { x: -38, y: 758 },
};
export const TRAP_Y = 772;

export interface TroupePos {
  x: number;
  scale: number;
}

const FIXED_CENTRES: Readonly<Record<number, readonly number[]>> = {
  1: [780],
  2: [600, 960],
  3: [480, 780, 1080],
  4: [420, 660, 900, 1140],
  5: [380, 575, 770, 965, 1160],
  6: [360, 536, 712, 888, 1064, 1240],
};

/** One troupe per rival across the stage: fixed spacing up to six, then evenly spread and smaller. */
export function troupeCentres(n: number): TroupePos[] {
  if (n <= 0) return [];
  const fixed = FIXED_CENTRES[n];
  if (fixed) return fixed.map((x) => ({ x, scale: n === 6 ? 0.85 : 1 }));
  return Array.from({ length: n }, (_, i) => ({ x: Math.round((340 + (i * 920) / (n - 1)) * 10) / 10, scale: 0.75 }));
}

export interface Troupe {
  key: string;
  label: string;
  short: string;
  /** The swarm group id (the thread filter's context id), once the rival's cards are recorded. */
  groupId: string | null;
  team: number;
  x: number;
  scale: number;
}

export interface StageLayout {
  troupes: Troupe[];
  /** Feet position of every seat of the office plan. */
  spots: Record<string, Pt>;
  /** Each seat's size (its troupe's scale; 1 outside the troupes). */
  scale: Record<string, number>;
  /** The star trap in front of each troupe, by pod key. */
  traps: Record<string, Pt>;
}

/** The stage for an office plan: a troupe per rival pod, the devil's corner, the director's table in the stalls,
 *  the critics' box and the prompt desk. */
export function stageLayout(plan: OfficePlan): StageLayout {
  const centres = troupeCentres(plan.pods.length);
  const spots: Record<string, Pt> = {};
  const scale: Record<string, number> = {};
  const traps: Record<string, Pt> = {};
  const troupes: Troupe[] = plan.pods.map((pod, i) => {
    const c = centres[i]!;
    traps[pod.key] = { x: c.x, y: TRAP_Y };
    for (const id of pod.seats) {
      const off = SLOT[id.slice(pod.key.length + 1)] ?? LEAD_SLOT;
      spots[id] = { x: Math.round((c.x + off.x * c.scale) * 10) / 10, y: off.y };
      scale[id] = c.scale;
    }
    return { key: pod.key, label: pod.label, short: shortName(pod.label), groupId: pod.groupId, team: pod.team, x: c.x, scale: c.scale };
  });
  for (const seat of Object.values(plan.seats)) {
    if (spots[seat.id]) continue;
    scale[seat.id] = 1;
    const index = Number(seat.id.split(":")[1] ?? 0);
    if (seat.zone === "analyst") spots[seat.id] = seat.role === "researcher" ? HOME_LANE_SPOT : ANALYST_SPOT;
    else if (seat.zone === "board") spots[seat.id] = BOARD_SPOTS[index] ?? BOX_TABLE;
    else if (seat.zone === "verify") spots[seat.id] = PROMPT;
    else spots[seat.id] = RED_EXTRA[index - 1] ?? CORNER;
  }
  return { troupes, spots, scale, traps };
}

/* ------------------------------------------------------------------------------------------------ the archive */

export type Shelf = "federal" | "sec" | "company" | "news" | "other";

/** The archive's shelves, top to bottom. */
export const SHELVES: readonly { id: Shelf; label: string }[] = [
  { id: "federal", label: "Federal" },
  { id: "sec", label: "SEC" },
  { id: "company", label: "Company" },
  { id: "news", label: "News" },
  { id: "other", label: "Other" },
];

const TIER_SHELF: Readonly<Record<SourceTier, Shelf>> = {
  federal_primary: "federal",
  sec_filing: "sec",
  company_owned: "company",
  news: "news",
  other: "other",
};

/** The shelf a source tier is filed on; an unknown tier goes to Other. */
export function shelfOf(tier: string): Shelf {
  return TIER_SHELF[tier as SourceTier] ?? "other";
}

/* ------------------------------------------------------------------------------------------------ time */

/** A recorded item on the display clock: history (at or before the boundary) is in effect from the start. */
export function displayAt(item: { seq: number; ts: number }, clock: BeatClock, settledSeq: number): number {
  return item.seq <= settledSeq ? -Infinity : clock.at(item.ts);
}

export interface StageEdgeAt {
  at: number;
  seq: number;
  ts: number;
  stage: StageId;
  edge: "started" | "finished";
  status: StepStatus | null;
}

/** The run's stage edges on the display clock, in ledger order. */
export function stageEdges(record: OfficeRecord, clock: BeatClock, settledSeq: number): StageEdgeAt[] {
  return [...record.stages]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ at: displayAt(s, clock, settledSeq), seq: s.seq, ts: s.ts, stage: s.stage, edge: s.edge, status: s.status ?? null }));
}

const STAGE_NO = (s: StageId) => Number(s.slice(1));

/** The latest stage started at or before `t`, else null. */
export function startedAt(edges: readonly StageEdgeAt[], t: number): StageEdgeAt | null {
  let out: StageEdgeAt | null = null;
  for (const e of edges) if (e.edge === "started" && e.at <= t) out = e;
  return out;
}

/** The phase the stage is in at `t` (from the latest stage started), else null before the first stage. */
export function phaseAt(edges: readonly StageEdgeAt[], t: number): PhaseId | null {
  const s = startedAt(edges, t);
  return s ? phaseOf(s.stage).id : null;
}

/** The painted cloth for each phase. */
export const BACKDROP: Readonly<Record<PhaseId, string>> = {
  intake: "Casting",
  research: "The archive",
  verify: "The read-through",
  wargame: "The war room",
  decide: "The notices",
};

/* ------------------------------------------------------------------------------------------------ gates */

export interface ApprovalLite {
  gate: string;
  createdAt: string | null;
}

export interface ParkAt {
  at: number;
  seq: number;
  ts: number;
  state: string;
}

const H1_STATES: ReadonlySet<string> = new Set(["awaiting_plan_approval"]);
const H2_STATES: ReadonlySet<string> = new Set(["awaiting_decision", "awaiting_review"]);

export function parksAt(record: OfficeRecord, clock: BeatClock, settledSeq: number): ParkAt[] {
  return [...record.parks].sort((a, b) => a.seq - b.seq).map((p) => ({ ...p, at: displayAt(p, clock, settledSeq) }));
}

function approvalTs(approvals: readonly ApprovalLite[], gate: "h1" | "h2"): number | null {
  const a = approvals.find((x) => x.gate === gate);
  const ts = a?.createdAt ? Date.parse(a.createdAt) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

export interface GateInput {
  edges: readonly StageEdgeAt[];
  parks: readonly ParkAt[];
  approvals: readonly ApprovalLite[];
  clock: BeatClock;
  /** The recorded time the frame shows (Infinity in the final state); a live view passes the wall clock's. */
  nowRecorded: number;
}

/** How long the curtain takes to rise or fall. */
export const CURTAIN_MS = 900;

export interface CurtainState {
  open: boolean;
  /** The H1 placard on the curtain: waiting for the analyst, or approved (shown until the curtain is up). */
  h1: { phase: "waiting" | "approved"; waitedMs: number | null; parkTs: number } | null;
}

/**
 * The main curtain: closed until the cast is known (the first stage from S4 on, where the S4 snapshot names the
 * lanes) and while the run waits at H1. The H1 placard reads "waiting" until the approval's recorded time (or, with
 * no approval row, the resume), then "approved after" until the curtain has risen.
 */
export function curtainAt(input: GateInput, t: number): CurtainState {
  const cast = input.edges.some((e) => e.edge === "started" && STAGE_NO(e.stage) >= 4 && e.at <= t);
  let park: ParkAt | null = null;
  for (const p of input.parks) if (p.at <= t) park = p;
  if (!park || !H1_STATES.has(park.state)) return { open: cast, h1: null };
  const parked = park;
  const resume = input.edges.find((e) => e.edge === "started" && e.seq > parked.seq);
  // still parked (no resume recorded): the curtain stays down, even in the final frame
  const resumed = resume !== undefined && t >= resume.at;
  if (resume && t >= resume.at + CURTAIN_MS) return { open: cast, h1: null };
  const approved = approvalTs(input.approvals, "h1");
  const decidedTs = approved !== null && approved >= parked.ts ? approved : resume ? resume.ts : null;
  const isApproved = resumed || (decidedTs !== null && decidedTs <= input.nowRecorded);
  // a wait still open is measured to the frame's recorded time; with no finite time (the final frame) it is unknown
  const waitedMs = Math.max(0, (isApproved && decidedTs !== null ? decidedTs : input.nowRecorded) - parked.ts);
  return { open: resumed && cast, h1: { phase: isApproved ? "approved" : "waiting", waitedMs: Number.isFinite(waitedMs) ? waitedMs : null, parkTs: parked.ts } };
}

export interface H2State {
  decided: boolean;
  /** When the decision was recorded (ms since epoch), else null. */
  decidedTs: number | null;
  /** How long the run has waited (null while still waiting with no finite time to measure to). */
  waitedMs: number | null;
  /** When the run parked at H2 (recorded ms since epoch). */
  parkTs: number;
}

/** The H2 banner: shown from the park at H2; decided once an h2 approval is recorded at or before the frame. */
export function h2At(input: GateInput, t: number): H2State | null {
  let park: ParkAt | null = null;
  for (const p of input.parks) if (p.at <= t) park = p;
  if (!park || !H2_STATES.has(park.state)) return null;
  const ts = approvalTs(input.approvals, "h2");
  const decided = ts !== null && ts <= input.nowRecorded;
  const until = decided && ts !== null ? ts : input.nowRecorded;
  const waitedMs = Math.max(0, until - park.ts);
  return { decided, decidedTs: decided ? ts : null, waitedMs: Number.isFinite(waitedMs) ? waitedMs : null, parkTs: park.ts };
}

export type BillStatus = "not_started" | "running" | "done" | "degraded" | "failed" | "not_built" | "waiting" | "approved";

/** The playbill under the stage: each stage's and gate's status at `t`. */
export function playbillAt(input: GateInput, t: number): Partial<Record<StepId, BillStatus>> {
  const out: Partial<Record<StepId, BillStatus>> = {};
  for (const e of input.edges) {
    if (e.at > t) continue;
    out[e.stage] = e.edge === "started" ? "running" : (e.status ?? "done");
  }
  let park: ParkAt | null = null;
  for (const p of input.parks) if (p.at <= t) park = p;
  const resumedAfter = (p: ParkAt) => input.edges.some((e) => e.edge === "started" && e.seq > p.seq && e.at <= t);
  const h1Ts = approvalTs(input.approvals, "h1");
  const h1Passed = input.parks.some((p) => H1_STATES.has(p.state) && p.at <= t && resumedAfter(p));
  if ((h1Ts !== null && h1Ts <= input.nowRecorded) || h1Passed) out.H1 = "approved";
  else if (park && H1_STATES.has(park.state)) out.H1 = "waiting";
  const h2Ts = approvalTs(input.approvals, "h2");
  if (h2Ts !== null && h2Ts <= input.nowRecorded) out.H2 = "approved";
  else if (park && H2_STATES.has(park.state)) out.H2 = "waiting";
  return out;
}

/* ------------------------------------------------------------------------------------------------ the easel */

const ACT = ["", "Act I", "Act II", "Act III"] as const;

const STATUS_NOTE: Readonly<Record<StepStatus, string>> = {
  done: "done",
  degraded: "done with gaps",
  failed: "failed",
  not_built: "skipped on this run",
};

export interface EaselCard {
  title: string;
  sub: string;
}

/** A stage that finished other than "done" is noted on the easel for this long. */
export const EASEL_NOTE_MS = 4000;

/**
 * The easel at the front of the stage: the stage working now ("S4 · Evidence") with the question it answers, or
 * during the swarm the act its latest message belongs to; the gates by name. A stage that just finished other than
 * "done" says so ("S6 Dossier: done with gaps").
 */
export function easelAt(input: { edges: readonly StageEdgeAt[]; ordered: readonly SwarmItem[]; sent: number; h1: CurtainState["h1"]; h2: H2State | null }, t: number): EaselCard {
  if (input.h2) return { title: "H2 · Decision", sub: input.h2.decided ? "Bid / no-bid call recorded" : "Your bid / no-bid call" };
  const started = startedAt(input.edges, t);
  if (input.h1 && (input.h1.phase === "waiting" || !started || STAGE_NO(started.stage) < 4)) {
    return { title: "H1 · Plan review", sub: input.h1.phase === "waiting" ? "Waiting for your approval" : "Approved" };
  }
  if (!started) return { title: "Casting", sub: "Before the first stage" };
  let odd: StageEdgeAt | null = null;
  for (const e of input.edges) if (e.at <= t && e.edge === "finished") odd = e.status && e.status !== "done" ? e : null;
  const note = odd?.status && t < odd.at + EASEL_NOTE_MS ? `${odd.stage} ${STEP_META[odd.stage].name}: ${STATUS_NOTE[odd.status]}` : null;
  if ((started.stage === "S9" || started.stage === "S10") && input.sent > 0) {
    let round = 0;
    for (const m of input.ordered.slice(0, input.sent)) round = Math.max(round, m.round);
    if (round >= 4) return { title: "The board", sub: ROUND_SHORT[4] ?? "Board scoring" };
    if (round >= 1) return { title: ACT[round] ?? "Act I", sub: ROUND_SHORT[round] ?? "" };
  }
  return { title: `${started.stage} · ${STEP_META[started.stage].name}`, sub: note ?? STEP_META[started.stage].question };
}

/* ------------------------------------------------------------------------------------------------ research */

export interface Book {
  id: string;
  seq: number;
  lane: string;
  shelf: Shelf;
  host: string;
  status: "ok" | "blocked" | "error";
  start: number;
  end: number;
}

/** How long a book is in the air, by its fetch's status. */
export const BOOK_MS: Readonly<Record<Book["status"], number>> = { ok: 900, blocked: 1500, error: 500 };

/** One book per fresh S4 fetch, from its tier's shelf to the rival's researcher (history pulls no books). */
export function books(record: OfficeRecord, clock: BeatClock, settledSeq: number): Book[] {
  return record.fetches
    .filter((f) => f.seq > settledSeq)
    .map((f) => {
      const start = clock.at(f.ts);
      return { id: `book:${f.seq}`, seq: f.seq, lane: f.lane, shelf: shelfOf(f.tier), host: f.host, status: f.status, start, end: start + BOOK_MS[f.status] };
    })
    .sort((a, b) => a.start - b.start || a.seq - b.seq);
}

/** The books in the air at `t`: at most `cap` per researcher, newest first, with how many more are on their way. */
export function flyingAt(list: readonly Book[], t: number, cap = 3): { flying: Book[]; extra: Record<string, number> } {
  const byLane = new Map<string, Book[]>();
  for (const b of list) {
    if (t < b.start || t >= b.end) continue;
    byLane.set(b.lane, [...(byLane.get(b.lane) ?? []), b]);
  }
  const flying: Book[] = [];
  const extra: Record<string, number> = {};
  for (const [lane, all] of byLane) {
    const newest = [...all].sort((a, b) => b.start - a.start || b.seq - a.seq);
    flying.push(...newest.slice(0, cap));
    if (newest.length > cap) extra[lane] = newest.length - cap;
  }
  return { flying: flying.sort((a, b) => a.start - b.start || a.seq - b.seq), extra };
}

export interface Trunk {
  ok: number;
  blocked: number;
  error: number;
  supported: number;
  partly: number;
  withheld: number;
}

const EMPTY_TRUNK: Trunk = { ok: 0, blocked: 0, error: 0, supported: 0, partly: 0, withheld: 0 };

/** Each troupe's trunk at `t`: sources read by status, and its claims checked by verdict (attributed through the
 *  verdict's paired cell delta). Verdicts with no recorded rival are counted under `unattributed`. */
export function trunksAt(record: OfficeRecord, clock: BeatClock, settledSeq: number, t: number): { lanes: Record<string, Trunk>; unattributed: number } {
  const lanes: Record<string, Trunk> = {};
  const get = (lane: string) => (lanes[lane] ??= { ...EMPTY_TRUNK });
  for (const f of record.fetches) if (displayAt(f, clock, settledSeq) <= t) get(f.lane)[f.status] += 1;
  let unattributed = 0;
  for (const v of record.verifies) {
    if (displayAt(v, clock, settledSeq) > t) continue;
    if (v.lane) get(v.lane)[v.verdict] += 1;
    else unattributed += 1;
  }
  return { lanes, unattributed };
}

/** Each lane's latest recorded activity line at `t`, without a trailing "for <the rival>" (the troupe is named on
 *  its pennant). */
export function laneLinesAt(record: OfficeRecord, clock: BeatClock, settledSeq: number, t: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of [...record.notes].sort((a, b) => a.seq - b.seq)) {
    if (displayAt(n, clock, settledSeq) > t) continue;
    out[n.lane] = trimSubject(n.text, n.lane);
  }
  return out;
}

export function trimSubject(text: string, lane: string): string {
  const cut = text.toUpperCase().lastIndexOf(" FOR ");
  return cut > 0 && podKey(text.slice(cut + 5)) === lane ? text.slice(0, cut) : text;
}

/* ------------------------------------------------------------------------------------------------ the prompter */

/** A slip stays up this long after its verdict (or the last verdict of its burst). */
export const SLIP_HOLD_MS = 2000;
/** A withheld claim's own slip stays up this long, inside a burst too. */
export const WITHHELD_HOLD_MS = 1600;
/** The least display time a withheld verdict is held apart in the Playhouse's replay, so its slip can be read. */
export const WITHHELD_STEP_MS = 700;

export type PromptSlip =
  | { kind: "one"; seq: number; verdict: Verdict; words: string; start: number }
  | { kind: "burst"; seq: number; checked: number; start: number };

export interface PromptState {
  /** Changes at each stamp strike (a burst's first verdict, each withheld claim); null between strikes. */
  strike: string | null;
  slip: PromptSlip | null;
  withheld: { seq: number; words: string; start: number } | null;
}

/**
 * The prompter at the prompt desk: one slip per S7 verdict, or for a burst (verdicts under 240 ms apart on the
 * display clock) one slip counting the claims checked so far. Each withheld claim gets its own slip inside the
 * burst, its words struck through by a redaction bar.
 */
export function promptAt(record: OfficeRecord, clock: BeatClock, settledSeq: number, t: number): PromptState {
  const vs = record.verifies
    .map((v) => ({ v, at: displayAt(v, clock, settledSeq) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at || a.v.seq - b.v.seq);
  // the latest burst that has started: consecutive verdicts closer than the stamp gap
  const gapBefore = (i: number) => (i === 0 ? Infinity : vs[i]!.at - vs[i - 1]!.at);
  let start = -1;
  for (let i = 0; i < vs.length && vs[i]!.at <= t; i++) if (gapBefore(i) >= STAMP_GAP_MS) start = i;
  let slip: PromptSlip | null = null;
  let strike: { id: string; at: number } | null = null;
  if (start >= 0) {
    let end = start;
    // the burst as recorded so far: a verdict still to come is neither counted nor known
    while (end + 1 < vs.length && gapBefore(end + 1) < STAMP_GAP_MS && vs[end + 1]!.at <= t) end += 1;
    const first = vs[start]!;
    const last = vs[end]!;
    // a lone withheld verdict is shown by its own slip below
    if (t < last.at + SLIP_HOLD_MS && !(end === start && first.v.verdict === "withheld")) {
      slip =
        end === start
          ? { kind: "one", seq: first.v.seq, verdict: first.v.verdict, words: firstWords(first.v.claim, 7), start: first.at }
          : { kind: "burst", seq: first.v.seq, checked: end - start + 1, start: first.at };
    }
    if (t < first.at + STAMP_MS) strike = { id: `b:${first.v.seq}`, at: first.at };
  }
  let withheld: PromptState["withheld"] = null;
  for (const x of vs) {
    if (x.at > t) break;
    if (x.v.verdict !== "withheld") continue;
    withheld = t < x.at + WITHHELD_HOLD_MS ? { seq: x.v.seq, words: firstWords(x.v.claim, 7), start: x.at } : null;
    if (t < x.at + STAMP_MS && (!strike || x.at >= strike.at)) strike = { id: `w:${x.v.seq}`, at: x.at };
  }
  return { strike: strike?.id ?? null, slip, withheld };
}

/* ------------------------------------------------------------------------------------------------ model calls */

export interface CallLite {
  createdAt: string | null;
  stage: string;
  purpose: string | null;
  latencyMs: number | null;
}

export interface CallWindow {
  stage: "S4" | "S6";
  purpose: string;
  start: number;
  end: number;
}

/** The recorded S4 and S6 model calls (bh-api `/inspect`; `createdAt` is when a call returned) as windows on the
 *  display clock: S4's light the archive's lamp, S6's the prompt desk where the dossiers are written. */
export function callWindows(calls: readonly CallLite[], clock: BeatClock): CallWindow[] {
  const out: CallWindow[] = [];
  for (const c of calls) {
    if (c.stage !== "S4" && c.stage !== "S6") continue;
    const end = c.createdAt ? Date.parse(c.createdAt) : NaN;
    if (!Number.isFinite(end)) continue;
    const start = end - Math.max(0, c.latencyMs ?? 0);
    out.push({ stage: c.stage, purpose: c.purpose ?? "", start: clock.at(start), end: clock.at(end) });
  }
  return out;
}

/** What a dossier call is doing, by its purpose. */
export function callDoing(purpose: string): string {
  if (purpose.startsWith("s6.dossier")) return "drafting";
  if (purpose.includes("sentinel")) return "sentinel check";
  if (purpose.includes("council")) return "council review";
  if (purpose.includes("quotes")) return "reading quotes";
  if (purpose.includes("triage")) return "triage";
  return "model call";
}

/** The model calls in flight at `t`: how many at the archive (S4) and what the prompt desk is writing (S6). */
export function callsAt(windows: readonly CallWindow[], t: number): { archive: number; prompt: Record<string, number> } {
  let archive = 0;
  const prompt: Record<string, number> = {};
  for (const w of windows) {
    if (t < w.start || t >= w.end) continue;
    if (w.stage === "S4") archive += 1;
    else {
      const k = callDoing(w.purpose);
      prompt[k] = (prompt[k] ?? 0) + 1;
    }
  }
  return { archive, prompt };
}

/* ------------------------------------------------------------------------------------------------ the swarm */

export type DevilPose = { pose: "corner"; peek: string[] } | { pose: "trap"; pod: string; from: number; to: number; peek: string[] };

/**
 * The red team (the devil). A challenge's delivery (its message at its recorded time) brings the devil up through
 * the star trap in front of the troupe it challenges; the newest delivery wins, so it is never in two places. While
 * a challenge is still being written (its model call), horns peek from that troupe's trap.
 */
export function devilAt(sched: Schedule, plan: OfficePlan, view: SwarmView, t: number): DevilPose {
  const kind = new Map(view.messages.map((m) => [m.messageId, m.kind]));
  const podOf = (to: readonly string[]): string | null => {
    const pods = new Set(to.map((s) => plan.seats[s]?.pod).filter((p): p is string => typeof p === "string"));
    return pods.size === 1 ? [...pods][0]! : null;
  };
  const isRed = (seat: string) => plan.seats[seat]?.zone === "red_team";
  const sendTo = new Map<string, string[]>();
  for (const b of sched.beats) if (b.kind === "send") sendTo.set(b.msgId, b.to);
  let trap: { pod: string; from: number; to: number } | null = null;
  const peek = new Set<string>();
  for (const b of sched.beats) {
    if ((b.kind !== "send" && b.kind !== "type") || b.start > t || t >= b.end || !isRed(b.seat)) continue;
    if (b.kind === "send" && kind.get(b.msgId) === "challenge") {
      const pod = podOf(b.to);
      if (pod && (!trap || b.start >= trap.from)) trap = { pod, from: b.start, to: b.end };
    } else if (b.kind === "type") {
      const msgId = b.id.slice("type:".length);
      const pod = kind.get(msgId) === "challenge" ? podOf(sendTo.get(msgId) ?? []) : null;
      if (pod) peek.add(pod);
    }
  }
  if (trap) {
    peek.delete(trap.pod);
    return { pose: "trap", ...trap, peek: [...peek] };
  }
  return { pose: "corner", peek: [...peek] };
}

/** The two working agents with the latest model-call starts at `t` (the follow-spots' targets). */
export function spotTargets(sched: Schedule, frame: OfficeFrame, t: number): string[] {
  const starts = new Map<string, number>();
  for (const b of sched.beats) {
    if (b.kind !== "type" || b.start > t || t >= b.end || frame.seats[b.seat]?.activity !== "typing") continue;
    starts.set(b.seat, Math.max(starts.get(b.seat) ?? -Infinity, b.start));
  }
  return [...starts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([seat]) => seat);
}

/* ------------------------------------------------------------------------------------------------ the board */

export type ScrimState = { state: "none" } | { state: "masked"; codes: string[] } | { state: "clear" };

/** Board ratings carried by a round-4 message: offeror codes with integer ratings 1 to 5 (anything else is dropped). */
export function ratingsOf(m: Pick<SwarmItem, "data">): [string, number][] {
  const raw = m.data.ratings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isInteger(e[1]) && e[1] >= 1 && e[1] <= 5)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function sentAt(sched: Schedule): Map<string, number> {
  return new Map(sched.sends.map((s) => [s.msgId, s.at]));
}

/**
 * The scrim: it drops over the troupes when S10 starts (the board scores masked offerors, so names must not be
 * readable) and turns transparent when the board result unblinds them. The caption lists the codes rated so far;
 * a code is never placed over a troupe before the result, because the mapping is unknown until then.
 */
export function scrimAt(input: { edges: readonly StageEdgeAt[]; view: SwarmView; sched: Schedule; settledSeq: number; clock: BeatClock }, t: number): ScrimState {
  const seen = input.view.boardSeen;
  const boardAt = seen ? displayAt({ seq: seen.seq, ts: Date.parse(seen.ts) }, input.clock, input.settledSeq) : Infinity;
  if (t >= boardAt) return { state: "clear" };
  const s10 = input.edges.find((e) => e.edge === "started" && e.stage === "S10");
  if (!s10 || s10.at > t) return { state: "none" };
  const at = sentAt(input.sched);
  const codes = new Set<string>();
  for (const m of input.view.messages) {
    if (m.round !== 4 || m.state !== "completed" || (at.get(m.messageId) ?? Infinity) > t) continue;
    for (const [code] of ratingsOf(m)) codes.add(code);
  }
  return { state: "masked", codes: [...codes].sort() };
}

export interface Scorecard {
  msgId: string;
  /** The critic's seat, when it has one. */
  seat: string | null;
  focus: string;
  pairs: [string, number][];
  state: SwarmItem["state"];
  at: number;
}

/** What a critic scores, from its card ("Evaluator, technical" reads "Technical"). */
export function criticFocus(card: { name: string; skills: readonly string[] } | undefined, fallback: string): string {
  if (!card) return fallback;
  const cut = card.name.lastIndexOf(", ");
  const tail = cut >= 0 ? card.name.slice(cut + 2).trim() : "";
  if (tail) return tail.charAt(0).toUpperCase() + tail.slice(1);
  return card.skills[0] ?? card.name;
}

/** The critics' scorecards: one row per round-4 message sent by `t`, with its recorded 1-5 ratings. */
export function scorecards(input: { view: SwarmView; plan: OfficePlan; sched: Schedule }, t: number): Scorecard[] {
  const at = sentAt(input.sched);
  return input.view.messages
    .filter((m) => m.round === 4 && (at.get(m.messageId) ?? Infinity) <= t)
    .map((m) => ({
      msgId: m.messageId,
      seat: input.plan.byAgent[m.from] ?? null,
      focus: criticFocus(input.view.cards[m.from], m.from),
      pairs: m.state === "completed" ? ratingsOf(m) : [],
      state: m.state,
      at: at.get(m.messageId) ?? -Infinity,
    }))
    .sort((a, b) => a.at - b.at);
}

export interface Placard {
  pod: string;
  code: string;
  share: number;
  incumbent: boolean;
}

/** The unblinded placards: each troupe's board row, matched by its group id, else by its name. */
export function placards(board: BoardResult | null, plan: OfficePlan): Placard[] {
  if (!board) return [];
  const out: Placard[] = [];
  for (const pod of plan.pods) {
    const row = board.rows.find((r) => pod.groupId !== null && r.group === pod.groupId) ?? board.rows.find((r) => podKey(r.label) === pod.key);
    if (row) out.push({ pod: pod.key, code: row.code, share: row.share, incumbent: row.incumbent });
  }
  return out;
}

/** The board's judgment for the valance: the top share, simulated and never a decision input. */
export function headline(board: BoardResult | null): string | null {
  const top = board ? [...board.rows].sort((a, b) => b.share - a.share)[0] : undefined;
  if (!top) return null;
  const who = top.code ? `${top.code} (${shortName(top.label)})` : shortName(top.label);
  return `Simulated board: ${who} ${Math.round(top.share * 100)}% of the vote. Not a decision input.`;
}

/* ------------------------------------------------------------------------------------------------ the replay */

/** A gate holds at least this long in the Playhouse's compressed replay (its recorded wait is on the placard). */
export const GATE_HOLD_MS = 2400;
/** The "approved after" placard is read this long before the curtain rises in the compressed replay. */
export const APPROVED_HOLD_MS = 1500;

/**
 * The recorded times the Playhouse adds to the office's replay clock: each gate's park, approval and resume held
 * apart, each withheld verdict held apart so its slip can be read, and every lane activity line and S4/S6 model
 * call window, so a stretch of real work (the S6 dossiers) is not cut as quiet.
 */
export function playhouseWarpKeys(input: { record: OfficeRecord; approvals: readonly ApprovalLite[]; calls: readonly CallLite[] }): WarpKey[] {
  const keys: WarpKey[] = [];
  const { record } = input;
  const starts = [...record.stages].filter((s) => s.edge === "started").sort((a, b) => a.seq - b.seq);
  for (const park of record.parks) {
    keys.push({ t: park.ts });
    const gate = H1_STATES.has(park.state) ? "h1" : H2_STATES.has(park.state) ? "h2" : null;
    const approved = gate ? approvalTs(input.approvals, gate) : null;
    const resume = starts.find((s) => s.seq > park.seq);
    if (approved !== null && approved >= park.ts) keys.push({ t: approved, minStep: GATE_HOLD_MS });
    if (resume && gate) keys.push({ t: resume.ts, minStep: approved !== null && approved >= park.ts ? APPROVED_HOLD_MS : GATE_HOLD_MS });
  }
  for (const v of record.verifies) if (v.verdict === "withheld") keys.push({ t: v.ts, minStep: WITHHELD_STEP_MS });
  for (const n of record.notes) keys.push({ t: n.ts });
  for (const c of input.calls) {
    if (c.stage !== "S4" && c.stage !== "S6") continue;
    const end = c.createdAt ? Date.parse(c.createdAt) : NaN;
    if (!Number.isFinite(end)) continue;
    keys.push({ t: end - Math.max(0, c.latencyMs ?? 0) }, { t: end });
  }
  return keys;
}

/** The run's recorded span (first and last recorded times the office holds), for the house clock. */
export function runSpan(record: OfficeRecord, view: SwarmView): { first: number; last: number } | null {
  const times = [
    ...record.stages.map((s) => s.ts),
    ...record.parks.map((p) => p.ts),
    ...record.fetches.map((f) => f.ts),
    ...view.messages.map((m) => Date.parse(m.ts)),
    view.boardSeen ? Date.parse(view.boardSeen.ts) : NaN,
  ].filter((v) => Number.isFinite(v));
  if (times.length === 0) return null;
  return { first: Math.min(...times), last: Math.max(...times) };
}

/** "T+06:41" for a span in ms. */
export function houseTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `T+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "2m 41s", "13s": a recorded wait for the placards. */
export function waitWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** An agent's card as a place may show it at a frame: only once the agent is on stage (its card recorded by then). */
export function cardShown<T>(card: T | undefined, present: boolean): T | undefined {
  return present ? card : undefined;
}

/** The seats the caption may name at a frame: agents at work (not idle) on a seat the scene knows; a rival's seat
 *  only once the rival is named. In the plan's order. */
export function castAt(plan: Pick<OfficePlan, "order" | "seats">, frame: Pick<OfficeFrame, "seats">, scene: Pick<Scene, "hasRival">): string[] {
  return plan.order.filter((id) => {
    const seat = plan.seats[id];
    const sf = frame.seats[id];
    return seat !== undefined && sf !== undefined && sf.activity !== "idle" && seatKnown(seat, scene);
  });
}

/** Tooltip words: always built from the frame on show, never stored at hover time. */
export interface TipWords {
  title: string;
  lines: string[];
}

/** A troupe's trunk card at the frame; null before the rival has a source on record. */
export function trunkTip(label: string, trunk: Trunk | undefined): TipWords | null {
  if (!trunk) return null;
  const failed = trunk.blocked + trunk.error;
  const checked = trunk.supported + trunk.partly + trunk.withheld;
  return {
    title: `${shortName(label)}: the trunk`,
    lines: [
      `${trunk.ok} sources read${failed ? `, ${failed} could not be read` : ""}`,
      checked ? `S7: ${trunk.supported} held up, ${trunk.partly} partly, ${trunk.withheld} withheld` : "No claims checked for this rival yet",
    ],
  };
}

/** The prompt desk's card at the frame: the verdicts recorded by then. */
export function deskTip(tally: Record<Verdict, number>, unattributed: number): TipWords {
  const total = tally.supported + tally.partly + tally.withheld;
  return {
    title: "The prompt desk (S7 verifier)",
    lines: total
      ? [
          `${total} claims checked: ${tally.supported} held up, ${tally.partly} partly, ${tally.withheld} withheld`,
          unattributed ? `${unattributed} verdicts carry no recorded rival (unattributed)` : "Every verdict is filed to its rival's trunk",
        ]
      : ["No claims checked yet"],
  };
}

/** A hovered seat's card at the frame: its agent's card once the agent is on stage with one, else the place's own
 *  words. Read on every render, so an agent arriving under the pointer replaces the empty-place card. */
export function seatTip<C>(seat: { role: string; present: boolean; card: C | undefined }): { kind: "agent"; card: C } | { kind: "text"; title: string; lines: string[] } {
  const card = cardShown(seat.card, seat.present);
  if (card !== undefined) return { kind: "agent", card };
  return { kind: "text", title: seat.role, lines: [seat.present ? "No agent card recorded for this place." : "Not on stage yet."] };
}
