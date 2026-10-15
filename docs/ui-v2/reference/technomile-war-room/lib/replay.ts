/**
 * Full-run replay: a finished or parked run's own record played back at its recorded pace, in every view of the run
 * page (War Room, Pipeline, Office). Pure functions over the run's record, so the transport, the views and the
 * tests read one timeline:
 *
 * - `buildTimeline`: the run's envelopes in sequence order with their recorded times (`ts`, the row's `created_at`),
 *   its stages, and the two human gates (when the run parked at each, when a person acted);
 * - `playbackMap`: recorded time to playback time and back. A gate wait longer than `GATE_PLAY_MS` plays in that
 *   long unless waits are included; recorded times never change, only how long a span takes to play;
 * - `advance`: the War Room store as of a cursor, folded by the shared reducer from the run's base view (the same
 *   base bh-api's snapshot folds from, with the firms approved at H1 from the approval's recorded time on);
 * - `statusAt`, `detailAt`, `inspectAt`, `spendAt`: the run's status, run row, inspector and spend as of a
 *   recorded time (a call counts from its receipt's recorded time).
 *
 * At the end of the record every one of these equals the run's real final state.
 */
import type { Counters, RunEventEnvelope, StepStatus, WarRoomSnapshot } from "@/lib/contracts/run-events";
import type { Inspection } from "@/lib/live/inspect";
import type { RunDetail, RunStage, RunStatus } from "@/lib/live/types";
import { PHASES, type GateId, type PhaseId, type StepId } from "@/lib/pipeline/steps";
import type { StageId } from "@/lib/stages";

import { ACTIVE_RUN_STATES, emptyStore, reduceAll, type WarRoomStore } from "./state";

/** How long a collapsed gate wait plays (unless the replay includes waits). */
export const GATE_PLAY_MS = 3_000;

/** The run states a phase parks in, and the gate each one waits at. */
export const GATE_STATES: Readonly<Record<string, GateId>> = {
  awaiting_plan_approval: "H1",
  awaiting_decision: "H2",
  awaiting_review: "H2",
};

export interface ReplayStage {
  id: StageId;
  /** Recorded start (ms since epoch). A stage that ran again (a retry after a failure) has one entry per attempt. */
  start: number;
  /** When it finished and how, as recorded; null while it never finished. */
  end: { at: number; status: StepStatus } | null;
}

export interface ReplayGate {
  id: GateId;
  /** The run state it parked in. */
  state: string;
  /** When the phase closed at the gate (its closing event). */
  parkAt: number;
  /** When the replay applies the approval: its recorded time, or the park when the approval was recorded before it
   *  (playback never runs backwards); null while the run still waits. Never displayed as a time of day. */
  actedAt: number | null;
  /** The approval's own recorded time, unaltered (what the views show); null while the run still waits. */
  recordedActedAt: number | null;
  /** The recorded wait: to the approval, or to the end of the record while it still waits. */
  waitMs: number;
}

export interface ReplayRun {
  createdAt: string | null;
  terminalAt: string | null;
  status: string;
  capUsd: string | number;
  opportunityRef: string;
}

export interface ReplayApproval {
  gate: string;
  createdAt: string | null;
  subjects?: readonly unknown[] | undefined;
}

export interface ReplaySource {
  runId: string;
  run: ReplayRun;
  approvals: readonly ReplayApproval[];
  envs: readonly RunEventEnvelope[];
}

export interface StatusMark {
  at: number;
  status: string;
}

export interface Timeline {
  runId: string;
  /** Elapsed zero: the run's creation (never after its first event). */
  t0: number;
  /** The end of the record: the last event, a later approval, or the run's terminal time. */
  end: number;
  /** Envelopes in sequence order, one per seq. */
  envs: RunEventEnvelope[];
  /** Each envelope's delivery time, in ms since epoch: its recorded time, or the one before it when the record steps
   *  back (delivery follows seq, so it stays a prefix). The envelope's own `ts` and every stage and gate time keep
   *  the recorded value. */
  times: number[];
  stages: ReplayStage[];
  gates: ReplayGate[];
  /** The run's status on the recorded clock, in time order (the first is at `t0`). */
  marks: StatusMark[];
  /** The run's status now; the replay shows it from the end of the record on. */
  finalStatus: string;
  /** The H1 approval: when, and the firms it approved. */
  h1: { at: number; subjects: string[] } | null;
  opportunityRef: string;
  capUsd: number;
}

const parseTime = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** The first index whose value is above `x` (values non-decreasing): how many are at or below it. */
function countUpTo(values: readonly number[], x: number): number {
  const i = values.findIndex((v) => v > x);
  return i < 0 ? values.length : i;
}

/** Merge two reads of the run's envelopes by seq; `preferred` wins a seq both carry (the swarm read is never cut
 *  for size, while the stream sends an over-limit frame as a placeholder). */
export function mergeEnvelopes(base: readonly RunEventEnvelope[], preferred: readonly RunEventEnvelope[]): RunEventEnvelope[] {
  const bySeq = new Map<number, RunEventEnvelope>();
  for (const e of base) bySeq.set(e.seq, e);
  for (const e of preferred) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The firms an approval names, trimmed, each once (bh-api's `clean_subjects`). */
function cleanSubjects(list: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const s of list ?? []) {
    const v = typeof s === "string" ? s.trim() : "";
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** An envelope with its delivery time (`at`) and its own recorded time (`rec`, `at` when unreadable). */
type Row = { env: RunEventEnvelope; at: number; rec: number };

/** The timeline of a run's record, or null when nothing in it carries a readable time. */
export function buildTimeline(src: ReplaySource): Timeline | null {
  const envs = mergeEnvelopes(src.envs, []);
  const created = parseTime(src.run.createdAt);
  const first = envs.map((e) => parseTime(e.ts)).find((t) => Number.isFinite(t));
  const t0 = Number.isFinite(created) ? Math.min(created, first ?? created) : first;
  if (t0 === undefined || !Number.isFinite(t0)) return null;
  // each envelope at its recorded time, never before the one before it (so delivery stays a prefix of the record)
  const rows: Row[] = [];
  let last = t0;
  for (const env of envs) {
    const t = parseTime(env.ts);
    last = Number.isFinite(t) ? Math.max(last, t) : last;
    rows.push({ env, at: last, rec: Number.isFinite(t) ? Math.max(t0, t) : last });
  }

  const recorded = (gate: "h1" | "h2"): number | null => {
    const t = parseTime(src.approvals.find((a) => a.gate === gate)?.createdAt);
    return Number.isFinite(t) ? t : null;
  };
  const acted = (gate: "h1" | "h2"): number | null => {
    const t = recorded(gate);
    return t === null ? null : Math.max(t, t0);
  };
  const terminal = parseTime(src.run.terminalAt);
  const end = Math.max(last, acted("h1") ?? t0, acted("h2") ?? t0, Number.isFinite(terminal) ? terminal : t0);

  // one entry per attempt: a finish closes the latest open attempt of its stage
  const stages: ReplayStage[] = [];
  const parks: { at: number; gate: GateId; state: string }[] = [];
  for (const { env, rec } of rows) {
    const ev = env.event;
    if (ev.type === "STEP_STARTED") {
      stages.push({ id: ev.stepName, start: rec, end: null });
    } else if (ev.type === "STEP_FINISHED") {
      const open = stages.findLast((x) => x.id === ev.stepName && x.end === null);
      const end = { at: Math.max(rec, open?.start ?? rec), status: ev.status ?? "done" };
      if (open) open.end = end;
      else stages.push({ id: ev.stepName, start: rec, end });
    } else if (ev.type === "RUN_FINISHED") {
      const gate = GATE_STATES[ev.result.state];
      if (gate) parks.push({ at: rec, gate, state: ev.result.state });
    }
  }

  const gates: ReplayGate[] = [];
  for (const id of ["H1", "H2"] as const) {
    const act = acted(id === "H1" ? "h1" : "h2");
    const all = parks.filter((p) => p.gate === id);
    const park = (act === null ? all : all.filter((p) => p.at <= act)).at(-1) ?? all[0];
    if (!park) continue;
    const actedAt = act === null ? null : Math.max(act, park.at);
    gates.push({ id, state: park.state, parkAt: park.at, actedAt, recordedActedAt: act === null ? null : recorded(id === "H1" ? "h1" : "h2"), waitMs: (actedAt ?? end) - park.at });
  }

  const h1At = acted("h1");
  return {
    runId: src.runId,
    t0,
    end,
    envs,
    times: rows.map((r) => r.at),
    stages: stages.sort((a, b) => a.start - b.start),
    gates,
    marks: statusMarks(rows, gates, t0),
    finalStatus: src.run.status,
    h1: h1At === null ? null : { at: gates.find((g) => g.id === "H1")?.actedAt ?? h1At, subjects: cleanSubjects(src.approvals.find((a) => a.gate === "h1")?.subjects) },
    opportunityRef: src.run.opportunityRef,
    capUsd: Number(src.run.capUsd) || 0,
  };
}

/**
 * The run's status on the recorded clock: starting from its creation, running from its first event, parked at a
 * gate from the phase's closing event until the approval (H1: the next phase starts; H2: decided), failed from a
 * phase error until a stage starts again.
 */
function statusMarks(rows: readonly Row[], gates: readonly ReplayGate[], t0: number): StatusMark[] {
  type Step = Row | { at: number; act: GateId };
  const steps: Step[] = [...rows];
  for (const g of gates) if (g.actedAt !== null) steps.push({ at: g.actedAt, act: g.id });
  // stable: at equal times the recorded event comes before the approval
  steps.sort((a, b) => a.at - b.at);
  const marks: StatusMark[] = [{ at: t0, status: "starting" }];
  let status = "starting";
  const set = (at: number, next: string) => {
    if (next === status) return;
    status = next;
    marks.push({ at, status: next });
  };
  for (const s of steps) {
    if ("act" in s) {
      set(s.at, s.act === "H1" ? "starting" : "decided");
      continue;
    }
    const ev = s.env.event;
    if (ev.type === "RUN_FINISHED") {
      if (GATE_STATES[ev.result.state]) set(s.at, ev.result.state);
      continue;
    }
    if (ev.type === "RUN_ERROR") {
      set(s.at, "failed");
      continue;
    }
    const restart = ev.type === "STEP_STARTED" || ev.type === "RUN_STARTED";
    if (status === "starting" || (restart && !ACTIVE_RUN_STATES.has(status) && status !== "decided")) set(s.at, "running");
  }
  return marks;
}

/** The run's status at recorded time `r`: its real final status from the end of the record on. */
export function statusAt(tl: Timeline, r: number): string {
  if (r >= tl.end) return tl.finalStatus;
  let status = "starting";
  for (const m of tl.marks) {
    if (m.at > r) break;
    status = m.status;
  }
  return status;
}

/** How many envelopes were recorded by `r` (the cursor at that time). */
export function cursorAt(tl: Timeline, r: number): number {
  return countUpTo(tl.times, r);
}

/* ------------------------------------------------------------------------------------------------ playback */

export interface Knot {
  r: number;
  p: number;
}

export interface PlaybackMap {
  /** Playback length of the whole record at 1x, in ms. */
  duration: number;
  /** Playback position (ms from the start, at 1x) of a recorded time. */
  toPlay(r: number): number;
  /** Recorded time of a playback position. */
  toRecorded(p: number): number;
  knots: readonly Knot[];
  /** The gate waits that play shorter than they took. */
  collapsed: readonly ReplayGate[];
}

/** Piecewise-linear lookup along the knots (strictly increasing in both directions, first at zero playback). */
function interpolate(knots: readonly Knot[], from: "r" | "p", to: "r" | "p", x: number): number {
  let prev: Knot | null = null;
  for (const k of knots) {
    if (x <= k[from]) {
      if (prev === null) return k[to];
      const span = k[from] - prev[from];
      const rise = k[to] - prev[to];
      // machine time plays as recorded: an identity span maps exactly, with no rounding
      return rise === span ? prev[to] + (x - prev[from]) : prev[to] + ((x - prev[from]) / span) * rise;
    }
    prev = k;
  }
  return prev === null ? 0 : prev[to];
}

/**
 * Recorded time to playback time and back, piecewise linear: machine time plays as recorded; each gate wait longer
 * than `gateMs` plays in `gateMs` unless `includeWaits` is set.
 */
export function playbackMap(tl: Timeline, opts: { includeWaits: boolean; gateMs?: number }): PlaybackMap {
  const gateMs = opts.gateMs ?? GATE_PLAY_MS;
  const knots: Knot[] = [{ r: tl.t0, p: 0 }];
  const collapsed: ReplayGate[] = [];
  let r = tl.t0;
  let p = 0;
  for (const g of [...tl.gates].sort((a, b) => a.parkAt - b.parkAt)) {
    const from = Math.max(g.parkAt, r);
    const to = g.actedAt ?? tl.end;
    if (opts.includeWaits || to - from <= gateMs) continue;
    if (from > r) {
      p += from - r;
      knots.push({ r: from, p });
    }
    p += gateMs;
    knots.push({ r: to, p });
    r = to;
    collapsed.push(g);
  }
  if (tl.end > r) {
    p += tl.end - r;
    knots.push({ r: tl.end, p });
  }
  return {
    duration: p,
    knots,
    collapsed,
    toPlay: (x) => interpolate(knots, "r", "p", x),
    toRecorded: (x) => interpolate(knots, "p", "r", x),
  };
}

/* ------------------------------------------------------------------------------------------------ the store */

const ZERO_COUNTERS: Counters = { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 };

/** The view a run starts from before any of its events: bh-api's snapshot base (no lanes before H1, no stages). */
export function baseView(tl: Pick<Timeline, "runId" | "opportunityRef" | "capUsd">): WarRoomSnapshot {
  return { runId: tl.runId, opportunity: tl.opportunityRef, lanes: {}, laneOrder: [], columns: [], cells: {}, cost: { usd: 0, capUsd: tl.capUsd }, counters: { ...ZERO_COUNTERS }, stages: {} };
}

/** The firms approved at H1 as queued lanes, the way bh-api's base view holds them, when the view has none yet. */
export function withApprovedLanes(store: WarRoomStore, subjects: readonly string[]): WarRoomStore {
  const view = store.view;
  if (!view || view.laneOrder.length > 0 || subjects.length === 0) return store;
  const lanes: WarRoomSnapshot["lanes"] = {};
  for (const s of subjects) lanes[s] = { subject: s, label: s, home: false, status: "queued", fetches: 0, activity: "" };
  return { ...store, view: { ...view, lanes, laneOrder: [...subjects] } };
}

export interface ReplayCursor {
  store: WarRoomStore;
  /** Envelopes folded so far. */
  k: number;
  /** The H1 approval's lanes are in the base view. */
  lanes: boolean;
}

export function replayStart(tl: Timeline): ReplayCursor {
  return { store: { ...emptyStore(), view: baseView(tl) }, k: 0, lanes: false };
}

/**
 * Fold forward to `k` envelopes at recorded time `r` (a cursor never moves back: a seek back starts from
 * `replayStart`). The H1 approval's lanes join the base view at the approval's recorded time, between the envelopes
 * recorded before it and after it.
 */
export function advance(cur: ReplayCursor, tl: Timeline, k: number, r: number): ReplayCursor {
  const to = Math.min(tl.envs.length, Math.max(cur.k, k));
  let { store, lanes } = cur;
  let i = cur.k;
  if (!lanes && tl.h1) {
    const j = i + countUpTo(tl.times.slice(i, to), tl.h1.at);
    store = reduceAll(store, tl.envs.slice(i, j));
    i = j;
    if (i < to || r >= tl.h1.at) {
      store = withApprovedLanes(store, tl.h1.subjects);
      lanes = true;
    }
  }
  store = reduceAll(store, tl.envs.slice(i, to));
  return { store, k: to, lanes };
}

/** The store as the views read it at recorded time `r`: the run's status then (as a snapshot answer sets it). */
export function withRunStatus(store: WarRoomStore, runStatus: string): WarRoomStore {
  if (ACTIVE_RUN_STATES.has(runStatus)) {
    return store.status === "running" && store.finalState === null && store.error === null ? store : { ...store, status: "running", finalState: null, error: null };
  }
  if (runStatus === "failed") return { ...store, status: "error", error: store.error ?? "the run failed", finalState: runStatus };
  return { ...store, status: "finished", finalState: runStatus, currentStage: null, stageStartedTs: null };
}

/** The view's spend: the run's model calls by `r` (the inspector's single cost source) against the run's cap. */
export function withSpend(store: WarRoomStore, usd: number, capUsd: number): WarRoomStore {
  const view = store.view;
  if (!view) return store;
  return { ...store, view: { ...view, cost: { usd, capUsd } } };
}

/* ------------------------------------------------------------------------------------------------ spend and the run row */

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export interface SpendIndex {
  calls: { at: number; usd: number }[];
}

/** The calls' cost by their receipt's recorded time (a call with no readable time is left out). */
export function spendIndex(calls: readonly { createdAt: string | null; usd: number }[]): SpendIndex {
  return {
    calls: calls.map((c) => ({ at: parseTime(c.createdAt), usd: Number.isFinite(c.usd) ? c.usd : 0 })).filter((c) => Number.isFinite(c.at)),
  };
}

/** What the run had spent by `r`, to the ledger's six decimal places. */
export function spendAt(index: SpendIndex, r: number): number {
  return round6(index.calls.reduce((sum, c) => (c.at <= r ? sum + c.usd : sum), 0));
}

const isoOf = (ms: number) => new Date(ms).toISOString();

/** The last stage edge at or before `r` (the run row's `stage`). */
export function stageEdgeAt(tl: Timeline, r: number): RunStage | null {
  let best: { at: number; stage: RunStage } | null = null;
  for (const s of tl.stages) {
    if (s.start > r) continue;
    const done = s.end !== null && s.end.at <= r ? s.end : null;
    const at = done ? done.at : s.start;
    const stage: RunStage = done ? { id: s.id, state: "finished", outcome: done.status } : { id: s.id, state: "running" };
    if (!best || at >= best.at) best = { at, stage };
  }
  return best ? best.stage : null;
}

/** The run row and its approvals as they stood at `r` (an approval counts from its recorded time). */
export function detailAt(d: RunDetail, tl: Timeline, k: number, r: number): RunDetail {
  if (r >= tl.end) return d;
  const titled = tl.stages.some((s) => s.id === "S0" && s.end !== null && s.end.at <= r);
  const last = tl.envs[k - 1];
  return {
    ...d,
    run: {
      ...d.run,
      status: statusAt(tl, r) as RunStatus,
      lastEventSeq: last ? last.seq : 0,
      updatedAt: last ? last.ts : d.run.createdAt,
      terminalAt: null,
      title: titled ? (d.run.title ?? null) : null,
      stage: stageEdgeAt(tl, r),
    },
    approvals: d.approvals.filter((a) => parseTime(a.createdAt) <= r),
  };
}

/** The run inspector as it stood at `r`: the calls received by then, each stage's time and spend so far. */
export function inspectAt(full: Inspection, tl: Timeline, r: number): Inspection {
  if (r >= tl.end) return full;
  const status = statusAt(tl, r);
  const active = ACTIVE_RUN_STATES.has(status);
  const calls = full.calls.filter((c) => parseTime(c.createdAt) <= r);
  const stages = full.stages.flatMap((s) => {
    const mine = calls.filter((c) => c.stage === s.stage);
    // the latest attempt of the stage started by then
    const st = tl.stages.findLast((x) => x.id === s.stage && x.start <= r);
    if (!st && mine.length === 0) return [];
    const done = st?.end && st.end.at <= r ? st.end : null;
    return [
      {
        ...s,
        startedAt: st ? isoOf(st.start) : null,
        endedAt: done ? isoOf(done.at) : null,
        durationMs: st ? (done ? done.at : r) - st.start : null,
        status: done ? done.status : active ? "running" : "incomplete",
        usd: round6(mine.reduce((sum, c) => sum + c.usd, 0)),
        calls: mine.length,
      },
    ];
  });
  return {
    run: {
      ...full.run,
      status,
      endedAt: null,
      durationMs: Math.max(0, r - tl.t0),
      usd: round6(calls.reduce((sum, c) => sum + c.usd, 0)),
      calls: calls.length,
      inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
      outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    },
    stages,
    calls,
  };
}

/* ------------------------------------------------------------------------------------------------ navigation */

/** Where a stage jump can land: the run's start, each stage start, each gate (park and approval), the end. */
export function jumpMarks(tl: Timeline): number[] {
  const marks = new Set<number>([tl.t0, tl.end]);
  for (const s of tl.stages) marks.add(s.start);
  for (const g of tl.gates) {
    marks.add(g.parkAt);
    if (g.actedAt !== null) marks.add(g.actedAt);
  }
  return [...marks].sort((a, b) => a - b);
}

/** The next mark after `r`, or the previous one (a jump back from just past a mark goes to the one before it). */
export function jumpFrom(tl: Timeline, r: number, dir: 1 | -1, slackMs = 1_500): number {
  const marks = jumpMarks(tl);
  if (dir > 0) return marks.find((m) => m > r + 0.5) ?? tl.end;
  return [...marks].reverse().find((m) => m < r - slackMs) ?? tl.t0;
}

/* ------------------------------------------------------------------------------------------------ the track */

export interface TrackSegment {
  kind: "stage" | "gate";
  id: StepId;
  phase: PhaseId;
  /** Recorded span. */
  r0: number;
  r1: number;
  status: StepStatus | "waiting" | "approved" | null;
  gate: ReplayGate | null;
}

const PHASE_OF: ReadonlyMap<StepId, PhaseId> = new Map(PHASES.flatMap((p) => p.steps.map((s) => [s, p.id] as const)));

/** The scrubber's segments: one per stage that ran (to its end, or to the next stage while it never finished) and
 *  one per gate wait, in recorded order. */
export function trackSegments(tl: Timeline): TrackSegment[] {
  const out: TrackSegment[] = tl.stages.map((s, i) => {
    const r1 = s.end ? s.end.at : (tl.stages[i + 1]?.start ?? tl.end);
    return { kind: "stage", id: s.id, phase: PHASE_OF.get(s.id) ?? "intake", r0: s.start, r1: Math.max(s.start, r1), status: s.end ? s.end.status : null, gate: null };
  });
  for (const g of tl.gates) {
    out.push({ kind: "gate", id: g.id, phase: PHASE_OF.get(g.id) ?? "intake", r0: g.parkAt, r1: g.actedAt ?? tl.end, status: g.actedAt === null ? "waiting" : "approved", gate: g });
  }
  return out.sort((a, b) => a.r0 - b.r0 || (a.kind === "gate" ? 1 : -1));
}

export interface PhaseSpan {
  phase: PhaseId;
  label: string;
  r0: number;
  r1: number;
}

/** Each phase's recorded span over its segments (phases with nothing recorded are left out). */
export function phaseSpans(segments: readonly TrackSegment[]): PhaseSpan[] {
  return PHASES.flatMap((p) => {
    const mine = segments.filter((s) => s.phase === p.id);
    if (mine.length === 0) return [];
    return [{ phase: p.id, label: p.label, r0: Math.min(...mine.map((s) => s.r0)), r1: Math.max(...mine.map((s) => s.r1)) }];
  });
}

/**
 * How busy the record is along the track: the envelopes recorded in each of `n` equal stretches of playback time
 * (the scrubber draws them as a faint histogram, so the bursts of research, verification and messages show).
 */
export function activity(tl: Timeline, map: PlaybackMap, n: number): number[] {
  const buckets = new Array<number>(Math.max(1, Math.floor(n))).fill(0);
  if (map.duration <= 0) return buckets;
  for (const t of tl.times) {
    const i = Math.min(buckets.length - 1, Math.floor((map.toPlay(t) / map.duration) * buckets.length));
    buckets[i] = (buckets[i] ?? 0) + 1;
  }
  return buckets;
}

/** The segment at `r` (the latest that started by then). */
export function segmentAt(segments: readonly TrackSegment[], r: number): TrackSegment | null {
  let hit: TrackSegment | null = null;
  for (const s of segments) if (s.r0 <= r && r <= s.r1) hit = s;
  return hit;
}
