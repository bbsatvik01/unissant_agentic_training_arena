/**
 * The Bid Tower's world at a display time: the exact clock, the model calls behind the machine room's racks and the
 * riser, the two human gates, the sky's phase, the step strip, the notary's stamp beats, each researcher's stay in
 * the archive, and the event log. Pure functions of the recorded run, so a replay, a live run and the tests agree.
 *
 * Exact time: one recorded second is one displayed second (`exactClock`). A burst is never time-warped: 235 verdicts
 * over five seconds are stamped in beats every `RESTAMP_MS`, each beat carrying every verdict that landed in it.
 */
import type { InspectCall } from "@/lib/live/inspect";
import { ROW_STATUS_LABEL, type Approvals, type RowStatus, type RunHistory } from "@/lib/pipeline/rail";
import { PHASES, phaseOf, STEP_ORDER, isGate, type PhaseId, type StepId } from "@/lib/pipeline/steps";
import type { StageId } from "@/lib/stages";

import type { BeatClock, OfficePlan, OfficeRecord, Schedule, Verdict, WarpKey } from "../office";
import { KIND_LABEL, shortName, type SwarmView } from "../swarm";

import type { TowerLayout } from "./layout";
import type { TowerRecord } from "./record";

/* ------------------------------------------------------------------------------------------------ the clock */

export const LEAD_MS = 600;

export type ExactClock = BeatClock & { t0: number };

/** Exact time from `t0`: display ms = recorded ms - t0 + `LEAD_MS`. A model call starts at its recorded start. */
export function exactClock(t0: number): ExactClock {
  const at = (t: number) => t - t0 + LEAD_MS;
  return { t0, at, typingStart: (t, lat) => at(t - Math.max(0, lat)) };
}

export interface TowerInputs {
  view: SwarmView;
  record: OfficeRecord;
  tower: TowerRecord;
  history: RunHistory | null;
  approvals: Approvals;
  calls: readonly InspectCall[] | null;
}

function finite(list: readonly number[]): number[] {
  return list.filter((v) => Number.isFinite(v));
}

function callTimes(calls: readonly InspectCall[] | null): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const c of calls ?? []) {
    const end = c.createdAt ? Date.parse(c.createdAt) : NaN;
    if (!Number.isFinite(end)) continue;
    ends.push(end);
    starts.push(end - Math.max(0, c.latencyMs ?? 0));
  }
  return { starts, ends };
}

/** The run's first and last recorded moments across everything the tower draws (null before anything is recorded). */
export function runBounds(input: TowerInputs): { start: number; end: number } | null {
  const { view, record, tower, history, approvals, calls } = input;
  const msgs = view.messages.map((m) => Date.parse(m.ts));
  const lat = view.messages.map((m) => Date.parse(m.ts) - Math.max(0, m.usage.latencyMs));
  const cards = Object.values(view.cardSeen).map((c) => Date.parse(c.ts));
  const { starts, ends } = callTimes(calls);
  const approved = [approvals.h1?.at, approvals.h2?.at].map((a) => (a ? Date.parse(a) : NaN));
  const firsts = finite([tower.first?.ts ?? NaN, ...record.stages.map((s) => s.ts), ...record.fetches.map((f) => f.ts), ...cards, ...lat, ...starts]);
  const lasts = finite([
    tower.last?.ts ?? NaN,
    ...record.stages.map((s) => s.ts),
    ...record.verifies.map((v) => v.ts),
    ...msgs,
    ...cards,
    view.boardSeen ? Date.parse(view.boardSeen.ts) : NaN,
    ...approved,
    ...ends,
    ...(history?.parks.map((p) => p.ts) ?? []),
    ...(history?.errors.map((e) => e.ts) ?? []),
  ]);
  if (firsts.length === 0 || lasts.length === 0) return null;
  return { start: Math.min(...firsts), end: Math.max(...lasts, ...firsts) };
}

/* ------------------------------------------------------------------------------------------------ model calls */

export interface CallSpan {
  id: number;
  endpoint: string;
  stage: string;
  start: number;
  end: number;
  /** The call's recorded start (createdAt minus latency). */
  startTs: number;
  free: boolean;
  ok: boolean;
  usd: number;
  model: string;
}

/** Each model call's window on the display clock (`createdAt - latencyMs` to `createdAt`; a call with no recorded
 *  time is skipped, one with no latency is an instant). In start order. */
export function callSpans(calls: readonly InspectCall[] | null, clock: BeatClock): CallSpan[] {
  const out: CallSpan[] = [];
  (calls ?? []).forEach((c, id) => {
    const end = c.createdAt ? Date.parse(c.createdAt) : NaN;
    if (!Number.isFinite(end)) return;
    const lat = Math.max(0, c.latencyMs ?? 0);
    out.push({ id, endpoint: c.endpoint || c.provider || "model", stage: c.stage, start: clock.at(end - lat), end: clock.at(end), startTs: end - lat, free: c.free, ok: c.status === "ok", usd: c.usd, model: c.model });
  });
  return out.sort((a, b) => a.start - b.start || a.id - b.id);
}

export const RACKS = 6;
export const LEDS = 24;

export interface RackPlan {
  /** Endpoint names in first-seen order, one per rack (endpoints past the last rack share it). */
  endpoints: string[];
  rackOf: (endpoint: string) => number;
  /** Each call's LED slot in its rack; -1 when every slot was lit at its start (counted, not drawn). */
  slotOf: Map<number, number>;
}

/** Racks and stable LED slots: the lowest slot free at a call's start, per rack. */
export function rackSlots(spans: readonly CallSpan[], leds = LEDS, racks = RACKS): RackPlan {
  const endpoints: string[] = [];
  for (const s of spans) if (!endpoints.includes(s.endpoint)) endpoints.push(s.endpoint);
  const rackOf = (endpoint: string) => Math.min(racks - 1, Math.max(0, endpoints.indexOf(endpoint)));
  const busy: number[][] = Array.from({ length: racks }, () => Array.from({ length: leds }, () => -Infinity));
  const slotOf = new Map<number, number>();
  for (const s of spans) {
    const slots = busy[rackOf(s.endpoint)] as number[];
    const slot = slots.findIndex((until) => until <= s.start);
    slotOf.set(s.id, slot);
    if (slot >= 0) slots[slot] = Math.max(s.end, s.start + 1);
  }
  return { endpoints: endpoints.slice(0, racks), rackOf, slotOf };
}

/** A failed call's LED stays red this long after it ends. */
export const FAILED_LED_MS = 1500;

export interface CallsNow {
  /** Calls started by `t`. */
  started: number;
  inFlight: CallSpan[];
  /** Calls that failed in the last `FAILED_LED_MS`. */
  failing: CallSpan[];
  /** Spend of the calls finished by `t`. */
  usd: number;
}

export function callsAt(spans: readonly CallSpan[], t: number): CallsNow {
  let started = 0;
  let usd = 0;
  const inFlight: CallSpan[] = [];
  const failing: CallSpan[] = [];
  for (const s of spans) {
    if (s.start > t) break;
    started += 1;
    if (s.end <= t) usd += s.usd;
    if (t < s.end) inFlight.push(s);
    else if (!s.ok && t - s.end < FAILED_LED_MS) failing.push(s);
  }
  return { started, inFlight, failing, usd };
}

/** The building row whose work a stage's model calls are: the lobby for intake, B1 for research, the ground floor's
 *  presses, booth and ledger for S6-S8, the rival and upper floors for the role-play, the roof from the board on. */
export function stageRows(layout: TowerLayout, stage: string): number[] {
  const n = /^S(\d{1,2})$/.exec(stage);
  const k = n ? Number(n[1]) : -1;
  if (k >= 4 && k <= 5) return [layout.basement];
  if (k === 9) return [layout.upper, ...layout.rivalRows];
  if (k >= 10) return [layout.roof];
  return [layout.ground];
}

/** The rows drawing model time now (the riser glows from the machine room up to the highest). */
export function riserRows(layout: TowerLayout, inFlight: readonly CallSpan[]): number[] {
  const rows = new Set<number>();
  for (const s of inFlight) for (const r of stageRows(layout, s.stage)) rows.add(r);
  return [...rows].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------------------------------------ gates */

export interface GateSpan {
  /** When the run parked at the gate (display), null if it never did. */
  park: number | null;
  /** When the person's approval was recorded (display), null if not yet. */
  approved: number | null;
  /** The approval's recorded time (for the sign). */
  approvedTs: number | null;
  /** The park's recorded time (a wait is measured in recorded time, never in replay time). */
  parkTs: number | null;
}

const H1_STATES: ReadonlySet<string> = new Set(["awaiting_plan_approval"]);
const H2_STATES: ReadonlySet<string> = new Set(["awaiting_decision", "awaiting_review"]);

export function gateSpans(history: RunHistory | null, approvals: Approvals, clock: BeatClock): { h1: GateSpan; h2: GateSpan } {
  const parks = history?.parks ?? [];
  const span = (states: ReadonlySet<string>, a: { at: string | null } | null, last: boolean): GateSpan => {
    const hits = parks.filter((p) => states.has(p.state));
    const park = last ? hits.at(-1) : hits[0];
    const ts = a?.at ? Date.parse(a.at) : NaN;
    return { park: park ? clock.at(park.ts) : null, approved: Number.isFinite(ts) ? clock.at(ts) : null, approvedTs: Number.isFinite(ts) ? ts : null, parkTs: park ? park.ts : null };
  };
  return { h1: span(H1_STATES, approvals.h1, false), h2: span(H2_STATES, approvals.h2, true) };
}

/** How long "approved" shows on a gate's sign before it reads plainly open. */
export const APPROVED_SIGN_MS = 4000;

export type GateState = "closed" | "waiting" | "approved" | "open";

export interface GateNow {
  state: GateState;
  /** While waiting: how long the run has waited so far, in recorded time (null when the frame has no finite time). */
  waitedMs: number | null;
  /** While waiting: display time of the recorded approval, if there is one (a replay can skip to it). */
  skipTo: number | null;
}

/** A gate at display time `t`. `back` maps a display time to the recorded time it shows, so a wait reads in recorded
 *  time even on a compressed replay clock. */
export function gateAt(span: GateSpan, t: number, back: (display: number) => number = (d) => d): GateNow {
  if (span.approved !== null && t >= span.approved) return { state: t - span.approved < APPROVED_SIGN_MS ? "approved" : "open", waitedMs: 0, skipTo: null };
  if (span.park !== null && t >= span.park) {
    const now = back(t);
    const parked = span.parkTs ?? back(span.park);
    return { state: "waiting", waitedMs: Number.isFinite(now) && Number.isFinite(parked) ? Math.max(0, now - parked) : null, skipTo: span.approved };
  }
  return { state: "closed", waitedMs: 0, skipTo: null };
}

/* ------------------------------------------------------------------------------------------------ phases and the strip */

/** The phase of the latest stage started by `t` (the sky follows it); intake before any. */
export function phaseAt(stages: Schedule["stages"], t: number): PhaseId {
  let phase: PhaseId = "intake";
  for (const s of stages) {
    if (s.at > t) break;
    if (s.edge === "started") phase = phaseOf(s.stage).id;
  }
  return phase;
}

export const PHASE_ORDER: readonly PhaseId[] = PHASES.map((p) => p.id);

export interface StripCell {
  id: StepId;
  status: RowStatus;
  label: string;
  /** Elapsed (running), duration (finished) or wait (gate), in ms. */
  ms: number | null;
}

/** The 18 steps at display time `t`: each stage from its recorded edges, each gate from its park and approval. */
export function stepStripAt(
  stages: Schedule["stages"],
  history: RunHistory | null,
  gates: { h1: GateSpan; h2: GateSpan },
  t: number,
  back: (display: number) => number = (d) => d,
): StripCell[] {
  const state = new Map<StageId, { status: RowStatus; start: number | null; end: number | null }>();
  for (const s of stages) {
    if (s.at > t) break;
    const cur = state.get(s.stage);
    if (s.edge === "started") state.set(s.stage, { status: "running", start: s.at, end: null });
    else state.set(s.stage, { status: history?.edges[s.stage]?.status ?? "done", start: cur?.start ?? null, end: s.at });
  }
  return STEP_ORDER.map((id): StripCell => {
    if (isGate(id)) {
      const g = gateAt(id === "H1" ? gates.h1 : gates.h2, t, back);
      const span = id === "H1" ? gates.h1 : gates.h2;
      const status: RowStatus = g.state === "waiting" ? "waiting" : g.state === "approved" || g.state === "open" ? "approved" : "not_started";
      const ms = status === "waiting" ? g.waitedMs : status === "approved" && span.parkTs !== null && span.approvedTs !== null ? Math.max(0, span.approvedTs - span.parkTs) : null;
      return { id, status, label: ROW_STATUS_LABEL[status], ms };
    }
    const s = state.get(id);
    if (!s) return { id, status: "not_started", label: ROW_STATUS_LABEL.not_started, ms: null };
    const edge = history?.edges[id];
    const recorded = edge && edge.start !== null && edge.end !== null ? edge.end - edge.start : null;
    const elapsed = s.start !== null && Number.isFinite(s.start) && Number.isFinite(t) ? back(t) - back(s.start) : NaN;
    const ms = s.status === "running" ? (Number.isFinite(elapsed) ? Math.max(0, elapsed) : null) : (recorded ?? (s.start !== null && s.end !== null && Number.isFinite(s.start) ? back(s.end) - back(s.start) : null));
    return { id, status: s.status, label: ROW_STATUS_LABEL[s.status], ms };
  });
}

/** The step running at `t` (the latest started and not finished), else null. */
export function runningStep(strip: readonly StripCell[]): StepId | null {
  return [...strip].reverse().find((c) => c.status === "running" || c.status === "waiting")?.id ?? null;
}

/* ------------------------------------------------------------------------------------------------ verdicts */

/** The notary re-stamps this often while verdicts arrive. */
export const RESTAMP_MS = 520;

export interface StampBeat {
  id: string;
  start: number;
  counts: Record<Verdict, number>;
  /** Verdicts in this beat whose source could not be reached. */
  unreachable: number;
  total: number;
}

export interface TimedVerdict {
  at: number;
  /** The verdict's recorded time. */
  ts: number;
  verdict: Verdict;
  unreachable: boolean;
  lane: string | null;
}

/** Verdicts grouped into stamp beats: a beat starts at a verdict and takes every verdict in the next `RESTAMP_MS`. */
export function stampBeats(verdicts: readonly TimedVerdict[]): StampBeat[] {
  const beats: StampBeat[] = [];
  let cur: StampBeat | null = null;
  for (const v of verdicts) {
    if (!Number.isFinite(v.at)) continue;
    if (!cur || v.at - cur.start >= RESTAMP_MS) {
      cur = { id: `stamp:${beats.length}`, start: v.at, counts: { supported: 0, partly: 0, withheld: 0 }, unreachable: 0, total: 0 };
      beats.push(cur);
    }
    cur.counts[v.verdict] += 1;
    cur.total += 1;
    if (v.unreachable) cur.unreachable += 1;
  }
  return beats;
}

/** A stamp beat as of display time `t`: only the verdicts recorded by then (a burst grows; it never shows its whole
 *  count at its first verdict). */
export function beatAt(beat: StampBeat, verdicts: readonly TimedVerdict[], t: number): StampBeat {
  const out: StampBeat = { ...beat, counts: { supported: 0, partly: 0, withheld: 0 }, unreachable: 0, total: 0 };
  for (const v of verdicts) {
    if (v.at < beat.start || v.at - beat.start >= RESTAMP_MS || v.at > t) continue;
    out.counts[v.verdict] += 1;
    out.total += 1;
    if (v.unreachable) out.unreachable += 1;
  }
  return out;
}

/** The display-to-recorded mapping for a frame: a finite frame time reads the clock's own inverse; the final frame
 *  (no finite time) of a run still parked reads the wall clock, or nothing when there is none yet. */
export function finalBack(back: (display: number) => number, wallNow: number | null): (display: number) => number {
  return (d) => (Number.isFinite(d) ? back(d) : (wallNow ?? NaN));
}

/** Verdicts on the display clock (history, at or before `settledSeq`, counts at once). In time order. */
export function timedVerdicts(tower: TowerRecord, clock: BeatClock, settledSeq: number): TimedVerdict[] {
  return tower.verdicts
    .map((v) => ({ at: v.seq > settledSeq ? clock.at(v.ts) : -Infinity, ts: v.ts, verdict: v.verdict, unreachable: v.unreachable, lane: v.lane }))
    .sort((a, b) => a.at - b.at);
}

export function tallyAt(verdicts: readonly TimedVerdict[], t: number, lane?: string | null): Record<Verdict, number> & { unreachable: number } {
  const out = { supported: 0, partly: 0, withheld: 0, unreachable: 0 };
  for (const v of verdicts) {
    if (v.at > t) break;
    if (lane !== undefined && v.lane !== lane) continue;
    out[v.verdict] += 1;
    if (v.unreachable) out.unreachable += 1;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ research trips */

export interface LaneTrip {
  lane: string;
  /** The researcher's seat. */
  seat: string;
  /** The archive carrel the lane reads at. */
  slot: number;
  /** When the researcher sets off for the archive (the plan's approval, else the S4 start), display ms. */
  down: number;
  /** When the lane's research ended (its status changed to done, degraded or ended), display ms. */
  up: number;
  /** At least one source answered: the researcher carries printouts back. */
  carries: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "degraded", "ended"]);
/** The plan's approval sets researchers off when S4 starts within this long after it. */
export const APPROVAL_LEAD_MS = 120_000;
/** A lane with no recorded end stays in the archive this long after its last fetch. */
export const LANE_TAIL_MS = 800;

/**
 * Each research lane's stay in the archive: from the plan's approval (or S4's start) to the lane's recorded end. One
 * stay per lane per S4 start; fetches far apart in one S4 run do not send the researcher back upstairs, because the
 * lane is still running. History (at or before `settledSeq`) does not move: its times are -Infinity.
 */
export function laneTrips(plan: OfficePlan, record: OfficeRecord, tower: TowerRecord, approvals: Approvals, clock: BeatClock, settledSeq: number, slots = 6): LaneTrip[] {
  const s4 = record.stages.filter((s) => s.stage === "S4" && s.edge === "started").map((s) => s.ts);
  const s4end = record.stages.filter((s) => s.stage === "S4" && s.edge === "finished").map((s) => s.ts);
  const approvedTs = approvals.h1?.at ? Date.parse(approvals.h1.at) : NaN;
  const podIndex = new Map(plan.pods.map((p, i) => [p.key, i]));
  const byLane = new Map<string, typeof record.fetches>();
  for (const f of record.fetches) byLane.set(f.lane, [...(byLane.get(f.lane) ?? []), f]);
  const trips: LaneTrip[] = [];
  for (const [lane, list] of byLane) {
    const seat = `${lane}:lane`;
    if (!plan.seats[seat]) continue;
    const slot = (podIndex.get(lane) ?? plan.pods.length) % slots;
    // one stay per S4 start: fetches are grouped by the latest S4 start at or before them
    const groups = new Map<number, typeof list>();
    for (const f of [...list].sort((a, b) => a.seq - b.seq)) {
      const start = Math.max(-Infinity, ...s4.filter((t) => t <= f.ts));
      const key = Number.isFinite(start) ? start : f.ts;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [start, fetches] of groups) {
      const first = fetches[0];
      const last = fetches.at(-1);
      if (!first || !last) continue;
      const downTs = Number.isFinite(approvedTs) && approvedTs <= start && start - approvedTs <= APPROVAL_LEAD_MS ? approvedTs : start;
      const end = (tower.marks[lane] ?? []).find((m) => m.ts >= first.ts && TERMINAL.has(m.status));
      const stageEnd = s4end.find((t) => t >= first.ts);
      const upTs = end ? end.ts : stageEnd !== undefined ? Math.max(stageEnd, last.ts) : last.ts + LANE_TAIL_MS;
      const upSeq = end ? end.seq : last.seq;
      trips.push({
        lane,
        seat,
        slot,
        down: first.seq > settledSeq ? clock.at(downTs) : -Infinity,
        up: upSeq > settledSeq ? clock.at(upTs) : -Infinity,
        carries: fetches.some((f) => f.status === "ok"),
      });
    }
  }
  return trips.sort((a, b) => a.down - b.down || a.slot - b.slot);
}

/** A lane's latest activity line at display time `t` (history at once). */
export function laneLineAt(tower: TowerRecord, lane: string, at: (ts: number) => number, settledSeq: number, t: number): string | null {
  let text: string | null = null;
  for (const l of tower.lines[lane] ?? []) {
    const shown = l.seq > settledSeq ? at(l.ts) : -Infinity;
    if (shown > t) break;
    text = l.text;
  }
  return text;
}

/* ------------------------------------------------------------------------------------------------ the log */

export type LogTone = "plain" | "signal" | "danger";

export interface LogRow {
  id: string;
  at: number;
  /** The recorded time the row is stamped with (history keeps it too); null when the record has none. */
  ts: number | null;
  /** A batch row's words at a frame: it counts only the items recorded by then. */
  textAt?: (t: number) => string;
  /** A batch row's tone at a frame (a failure or a withheld claim only once it is recorded). */
  toneAt?: (t: number) => LogTone;
  /** The step it belongs to ("S4", "S9 R2", "H1"). */
  step: string;
  text: string;
  tone: LogTone;
}

/** Model calls are logged per stage in windows this long. */
export const CALL_LOG_MS = 10_000;

/**
 * Every recorded event as a log line on the display clock: stage edges, fetches, verdict beats, cards (one line per
 * team), messages, the board's result, gate parks and approvals, errors, and model calls grouped per stage per ten
 * seconds. In time order.
 */
export function buildLog(input: TowerInputs, plan: OfficePlan, clock: BeatClock, settledSeq: number, spans: readonly CallSpan[], beats: readonly StampBeat[], gates: { h1: GateSpan; h2: GateSpan }, verdicts: readonly TimedVerdict[] = []): LogRow[] {
  const { view, record, history } = input;
  const at = (seq: number, ts: number) => (seq > settledSeq ? clock.at(ts) : -Infinity);
  const rows: LogRow[] = [];
  const laneName = (lane: string) => shortName(record.lanes.find((l) => l.key === lane)?.label ?? plan.pods.find((p) => p.key === lane)?.label ?? lane);
  for (const s of record.stages) {
    const edge = history?.edges[s.stage];
    const status = s.edge === "started" ? "started" : (edge?.status ?? "done").replace("_", " ");
    const dur = s.edge === "finished" && edge && edge.start !== null && edge.end !== null ? ` in ${seconds(edge.end - edge.start)}` : "";
    rows.push({ id: `stage:${s.seq}`, at: at(s.seq, s.ts), ts: s.ts, step: s.stage, text: `${stageName(s.stage)} ${status}${dur}`, tone: s.edge === "finished" && (status === "failed" || status === "degraded") ? "danger" : "plain" });
  }
  for (const f of record.fetches) {
    rows.push({ id: `fetch:${f.seq}`, at: at(f.seq, f.ts), ts: f.ts, step: "S4", text: `${laneName(f.lane)} researcher read ${f.host} (${f.status})`, tone: f.status === "ok" ? "plain" : "danger" });
  }
  for (const b of beats) {
    const mine = verdicts.filter((v) => v.at >= b.start && v.at - b.start < RESTAMP_MS);
    const words = (t: number) => {
      const c = logRevealAt({ verdicts: mine, spans: [] }, t).verdicts;
      const parts = [`${c.supported} supported`, c.partly ? `${c.partly} partly` : "", c.withheld ? `${c.withheld} withheld` : ""].filter(Boolean);
      return `${c.total} ${c.total === 1 ? "claim" : "claims"} checked: ${parts.join(", ")}${c.unreachable ? `, ${c.unreachable} source unreachable` : ""}`;
    };
    const toneAt = (t: number): LogTone => (logRevealAt({ verdicts: mine, spans: [] }, t).verdicts.withheld ? "danger" : "plain");
    rows.push({ id: b.id, at: b.start, ts: mine[0]?.ts ?? null, step: "S7", text: words(Infinity), textAt: words, tone: toneAt(Infinity), toneAt });
  }
  // cards: one line per team, at its first card
  for (const g of view.groups) {
    const seen = g.agents.map((a) => view.cardSeen[a.agentId]).filter((c): c is NonNullable<typeof c> => c !== undefined);
    const first = seen.sort((a, b) => a.seq - b.seq)[0];
    if (!first) continue;
    const who = g.kind === "rival" ? `${shortName(g.label)} capture team` : g.kind === "board" ? "Board" : g.label;
    const noun = g.kind === "board" ? "evaluator" : "agent";
    // the count grows as each card is recorded; it never shows the team's final size early
    const arrivals = seen.map((c) => at(c.seq, Date.parse(c.ts)));
    const words = (t: number) => {
      const n = arrivals.filter((a) => a <= t).length;
      return `${who} joined (${n} ${noun}${n === 1 ? "" : "s"})`;
    };
    rows.push({ id: `cards:${g.id}`, at: at(first.seq, Date.parse(first.ts)), ts: Date.parse(first.ts), step: g.kind === "board" ? "S10" : "S9", text: words(Infinity), textAt: words, tone: "plain" });
  }
  const who = (id: string) => {
    if (id === "board") return "the board";
    const c = view.cards[id];
    if (!c) return id;
    const role = c.role.replace("_", " ");
    return c.group === "red_team" || c.group === "analyst" || c.group === "board" ? c.name : `${shortName(c.groupLabel)} ${role}`;
  };
  for (const m of view.messages) {
    const ts = Date.parse(m.ts);
    if (!Number.isFinite(ts)) continue;
    const state = m.state === "completed" ? "" : m.state === "rejected" ? " (not run: budget spent)" : " (failed)";
    const lat = m.usage.latencyMs > 0 ? `, ${seconds(m.usage.latencyMs)} model time` : "";
    rows.push({
      id: `msg:${m.messageId}`,
      at: at(m.seq, ts),
      ts,
      step: m.round >= 4 ? "S10" : `S9 R${m.round}`,
      text: `${capital(who(m.from))} to ${m.to.map(who).join(", ")}: ${KIND_LABEL[m.kind].toLowerCase()}${state}${lat}`,
      tone: m.state === "completed" ? "plain" : "danger",
    });
  }
  if (view.board && view.boardSeen) {
    const shares = [...view.board.rows]
      .filter((r) => r.code)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((r) => `${r.code} ${Math.round(r.share * 100)}%`)
      .join(", ");
    rows.push({ id: "board", at: at(view.boardSeen.seq, Date.parse(view.boardSeen.ts)), ts: Date.parse(view.boardSeen.ts), step: "S10", text: `Board scored: ${shares}`, tone: "signal" });
  }
  const gate = (id: "H1" | "H2", g: GateSpan, name: string) => {
    if (g.park !== null) rows.push({ id: `${id}:park`, at: g.park, ts: g.parkTs, step: id, text: `${name}: your call, waiting`, tone: "signal" });
    if (g.approved !== null) rows.push({ id: `${id}:approved`, at: g.approved, ts: g.approvedTs, step: id, text: id === "H1" ? "Plan approved" : "Decision recorded", tone: "signal" });
  };
  gate("H1", gates.h1, "Plan review");
  gate("H2", gates.h2, "Decision");
  for (const e of history?.errors ?? []) rows.push({ id: `error:${e.seq}`, at: at(e.seq, e.ts), ts: e.ts, step: "Run", text: e.code ? `Run error (${e.code})` : "Run error", tone: "danger" });
  // model calls: one line per stage per window
  const windows = new Map<string, CallSpan[]>();
  for (const s of spans) {
    const key = `${s.stage}|${Math.floor(s.start / CALL_LOG_MS)}`;
    windows.set(key, [...(windows.get(key) ?? []), s]);
  }
  for (const [key, list] of windows) rows.push(callLogRow(key, list));
  // history rows share -Infinity: they keep their recorded order
  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at - b.at) || (a.ts ?? 0) - (b.ts ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The log as of `t`, newest first. */
export function logAt(rows: readonly LogRow[], t: number): LogRow[] {
  let hi = rows.length;
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.at ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return rows
    .slice(0, lo)
    .reverse()
    .map((r) => (r.textAt || r.toneAt ? { ...r, ...(r.textAt ? { text: r.textAt(t) } : {}), ...(r.toneAt ? { tone: r.toneAt(t) } : {}) } : r));
}

/** One log row for a stage's model calls in one window: its words and tone at a frame name only the calls started
 *  by then (and their endpoints), and count a failure only once that call has ended. */
export function callLogRow(key: string, list: readonly CallSpan[]): LogRow {
  const first = list[0] as CallSpan;
  const words = (t: number) => {
    const c = logRevealAt({ verdicts: [], spans: list }, t).calls;
    return `${c.started} model ${c.started === 1 ? "call" : "calls"} started (${c.endpoints.join(", ")})${c.failed ? `, ${c.failed} failed` : ""}`;
  };
  const toneAt = (t: number): LogTone => (logRevealAt({ verdicts: [], spans: list }, t).calls.failed ? "danger" : "plain");
  return { id: `calls:${key}`, at: first.start, ts: first.startTs, step: first.stage || "Run", text: words(Infinity), textAt: words, tone: toneAt(Infinity), toneAt };
}

/** What a batch has revealed by display time `t`: the verdicts recorded so far, the calls started so far, and the
 *  calls known to have failed (ended without success). Nothing is counted before its own recorded time. */
export function logRevealAt(input: { verdicts: readonly TimedVerdict[]; spans: readonly CallSpan[] }, t: number): {
  verdicts: Record<Verdict, number> & { unreachable: number; total: number };
  calls: { started: number; failed: number; endpoints: string[] };
} {
  const verdicts = { supported: 0, partly: 0, withheld: 0, unreachable: 0, total: 0 };
  for (const v of input.verdicts) {
    if (v.at > t) continue;
    verdicts[v.verdict] += 1;
    verdicts.total += 1;
    if (v.unreachable) verdicts.unreachable += 1;
  }
  let started = 0;
  let failed = 0;
  const endpoints: string[] = [];
  for (const s of input.spans) {
    if (s.start <= t) {
      started += 1;
      if (!endpoints.includes(s.endpoint)) endpoints.push(s.endpoint);
    }
    if (!s.ok && s.end <= t) failed += 1;
  }
  return { verdicts, calls: { started, failed, endpoints } };
}

/** The recorded moments the tower adds to the office replay clock, so they keep their place: lane activity lines,
 *  S7 verdicts, model-call starts and ends, gate parks and the people's approvals (a decision made half an hour later
 *  is an anchor, not a point past the last key). */
export function towerWarpKeys(tower: TowerRecord, calls: readonly InspectCall[] | null, history: RunHistory | null, approvals: Approvals): WarpKey[] {
  const keys: WarpKey[] = [];
  for (const list of Object.values(tower.lines)) for (const l of list) keys.push({ t: l.ts });
  for (const v of tower.verdicts) keys.push({ t: v.ts });
  for (const c of calls ?? []) {
    const end = c.createdAt ? Date.parse(c.createdAt) : NaN;
    if (!Number.isFinite(end)) continue;
    keys.push({ t: end - Math.max(0, c.latencyMs ?? 0) }, { t: end });
  }
  for (const p of history?.parks ?? []) keys.push({ t: p.ts });
  for (const a of [approvals.h1, approvals.h2]) {
    const ts = a?.at ? Date.parse(a.at) : NaN;
    if (Number.isFinite(ts)) keys.push({ t: ts });
  }
  return keys;
}

const STAGE_NAMES: Record<string, string> = {
  S0: "Intake",
  S1: "Lineage",
  S2: "Entities",
  S3: "Plan",
  S4: "Evidence",
  S5: "Rows",
  S6: "Dossier",
  S7: "Verify",
  S8: "Price to win",
  S9: "Role-play",
  S10: "Board",
  S11: "Counters",
  S12: "Decision",
  S13: "Brief",
  S14: "Check",
  S15: "Export",
};

export function stageName(stage: string): string {
  return STAGE_NAMES[stage] ?? stage;
}

export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A display time as m:ss.s from `origin` (the run's first recorded moment). */
export function clockLabel(ms: number, origin: number): string {
  if (!Number.isFinite(ms)) return "--:--";
  const d = Math.max(0, ms - origin);
  const m = Math.floor(d / 60_000);
  const s = (d % 60_000) / 1000;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
