/**
 * The run's own record, folded for the office styles that show more than the Classic floor: every S4 fetch with its
 * host and tier, every S7 verdict attributed to its rival, the lanes' recorded activity lines (S4-S7), stage edges
 * with how they ended, the human-gate parks and the run's errors. Pure functions, so a view, its tests and a replay
 * see the same values.
 *
 * Nothing is guessed. A verdict names its rival only through the `:delta` frame recorded with it (the cells it
 * changed); a verdict without one is counted as unattributed. A lane line is the text the run wrote to
 * `/lanes/<rival>/activity`, never a narration.
 */
import type { FetchActivity, RunEventEnvelope, SourceTier, StepStatus } from "@/lib/contracts/run-events";
import type { Approvals } from "@/lib/pipeline/rail";
import type { StageId } from "@/lib/stages";

import { podKey, STAMP_GAP_MS, STAMP_MS, VERDICT, type BeatClock, type Verdict } from "./office";

/* ------------------------------------------------------------------------------------------------ the record */

export interface CmdFetch {
  seq: number;
  ts: number;
  /** The rival's pod key (`podKey` of the fetch's subject). */
  lane: string;
  label: string;
  host: string;
  status: FetchActivity["status"];
  tier: SourceTier;
  sourceType: string;
  column: string;
  evidenceId: string;
}

export interface CmdVerdict {
  seq: number;
  ts: number;
  claimId: string;
  claim: string;
  verdict: Verdict;
  unreachable: boolean;
  /** The rival whose cells the verdict's own delta changed; null when the record does not say (never guessed). */
  lane: string | null;
  /** The evidence-matrix columns that delta changed. */
  columns: string[];
}

export interface CmdLine {
  seq: number;
  ts: number;
  lane: string;
  label: string;
  text: string;
}

export interface CmdStage {
  seq: number;
  ts: number;
  stage: StageId;
  edge: "started" | "finished";
  /** How a finished stage ended (null on a start). */
  status: StepStatus | null;
}

export type Gate = "H1" | "H2";

export interface CmdPark {
  seq: number;
  ts: number;
  gate: Gate;
}

export interface CmdError {
  seq: number;
  ts: number;
  code: string;
  message: string;
}

export interface CommandRecord {
  /** The recorded time of the run's first event (its lowest seq), null before any. */
  runStart: number | null;
  /** The latest snapshot's opportunity title. */
  opportunity: string | null;
  /** Where the run's latest snapshot sits (S4 opens the approved plan's evidence lanes with it). */
  snapshot: { seq: number; ts: number } | null;
  fetches: CmdFetch[];
  verdicts: CmdVerdict[];
  lines: CmdLine[];
  stages: CmdStage[];
  parks: CmdPark[];
  errors: CmdError[];
  lastSeq: number;
}

const PARK_GATE: Readonly<Record<string, Gate>> = {
  awaiting_plan_approval: "H1",
  awaiting_decision: "H2",
  awaiting_review: "H2",
};

const LANE_ACTIVITY = /^\/lanes\/(.+)\/activity$/;

/** An RFC 6901 pointer token as written (`~1` is `/`, then `~0` is `~`). */
export function unescapePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The rival and matrix columns a verdict's delta changed: the `/cells/` ops whose value names a subject and column. */
function cellsOf(ops: readonly { path: string; value: unknown }[]): { lane: string | null; columns: string[] } {
  const cells = ops.filter((op) => op.path.startsWith("/cells/") && isRecord(op.value) && typeof op.value.subject === "string" && typeof op.value.column === "string");
  const first = cells[0]?.value as { subject: string } | undefined;
  const columns = [...new Set(cells.map((op) => (op.value as { column: string }).column))];
  return { lane: first ? podKey(first.subject) : null, columns };
}

/**
 * Fold envelopes (any order, duplicates allowed) into the record. A frame with no readable time is skipped; parks at
 * the same gate with no stage edge between them are one park (the run records its closing state twice).
 */
export function foldCommand(envs: readonly RunEventEnvelope[]): CommandRecord {
  const out: CommandRecord = { runStart: null, opportunity: null, snapshot: null, fetches: [], verdicts: [], lines: [], stages: [], parks: [], errors: [], lastSeq: 0 };
  const ordered: RunEventEnvelope[] = [];
  const seen = new Set<number>();
  for (const env of [...envs].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(env.seq)) continue;
    seen.add(env.seq);
    out.lastSeq = Math.max(out.lastSeq, env.seq);
    if (Number.isFinite(Date.parse(env.ts))) ordered.push(env);
  }
  const deltas = new Map<string, { path: string; value: unknown }[]>();
  for (const env of ordered) if (env.event.type === "STATE_DELTA" && env.idemKey.endsWith(":delta")) deltas.set(env.idemKey, env.event.delta);

  let edgeSinceLastPark = true;
  for (const env of ordered) {
    const ts = Date.parse(env.ts);
    out.runStart ??= ts;
    const ev = env.event;
    switch (ev.type) {
      case "STATE_SNAPSHOT":
        out.opportunity = ev.snapshot.opportunity;
        out.snapshot = { seq: env.seq, ts };
        break;
      case "STEP_STARTED":
      case "STEP_FINISHED":
        out.stages.push({ seq: env.seq, ts, stage: ev.stepName, edge: ev.type === "STEP_STARTED" ? "started" : "finished", status: ev.type === "STEP_FINISHED" ? (ev.status ?? "done") : null });
        edgeSinceLastPark = true;
        break;
      case "RUN_FINISHED": {
        const gate = PARK_GATE[ev.result.state];
        if (!gate) break;
        if (!edgeSinceLastPark && out.parks.at(-1)?.gate === gate) break;
        out.parks.push({ seq: env.seq, ts, gate });
        edgeSinceLastPark = false;
        break;
      }
      case "RUN_ERROR":
        out.errors.push({ seq: env.seq, ts, code: ev.code ?? "unrecorded", message: ev.message });
        break;
      case "STATE_DELTA":
        for (const op of ev.delta) {
          const m = LANE_ACTIVITY.exec(op.path);
          if (!m?.[1] || typeof op.value !== "string") continue;
          const label = unescapePointer(m[1]);
          out.lines.push({ seq: env.seq, ts, lane: podKey(label), label, text: op.value });
        }
        break;
      case "ACTIVITY_SNAPSHOT":
        if (ev.activityType === "fetch") {
          const c = ev.content;
          out.fetches.push({ seq: env.seq, ts, lane: podKey(c.subject), label: c.subject, host: c.host, status: c.status, tier: c.tier, sourceType: c.sourceType, column: c.column, evidenceId: c.evidenceId });
        } else if (ev.activityType === "verify") {
          const c = ev.content;
          const { lane, columns } = cellsOf(deltas.get(`${env.idemKey}:delta`) ?? []);
          out.verdicts.push({ seq: env.seq, ts, claimId: c.claimId, claim: c.claim, verdict: VERDICT[c.verdict], unreachable: c.sourceUnreachable, lane, columns });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** The extra frames these styles keep from a run's stream: verdict deltas, lane activity lines, phase ends, errors. */
export function isCommandEvent(env: RunEventEnvelope): boolean {
  const ev = env.event;
  if (ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") return true;
  if (ev.type !== "STATE_DELTA") return false;
  const k = env.idemKey;
  if (k.endsWith(":delta") && k.includes(":S7:") && k.includes(":verdict:")) return true;
  return ev.delta.some((op) => LANE_ACTIVITY.test(op.path));
}

/* ------------------------------------------------------------------------------------------------ at a display time */

/** How a view places recorded items on its clock: `settledSeq` and older are history (shown at once, never animated). */
export interface DisplayCtx {
  clock: BeatClock;
  settledSeq: number;
}

/** An item counts at display time `t` once its display time has passed, or at once when it is history. */
export function shownAt(item: { seq: number; ts: number }, t: number, ctx: DisplayCtx): boolean {
  return item.seq <= ctx.settledSeq || ctx.clock.at(item.ts) <= t;
}

export interface FetchCounts {
  total: number;
  ok: number;
  blocked: number;
  error: number;
}

/** A rival's fetches shown at `t`, newest first, with counts by status and by source tier. */
export function fetchesAt(cmd: CommandRecord, lane: string, t: number, ctx: DisplayCtx): { cards: CmdFetch[]; counts: FetchCounts; tiers: Partial<Record<SourceTier, number>> } {
  const cards = cmd.fetches.filter((f) => f.lane === lane && shownAt(f, t, ctx)).reverse();
  const counts: FetchCounts = { total: cards.length, ok: 0, blocked: 0, error: 0 };
  const tiers: Partial<Record<SourceTier, number>> = {};
  for (const f of cards) {
    counts[f.status] += 1;
    tiers[f.tier] = (tiers[f.tier] ?? 0) + 1;
  }
  return { cards, counts, tiers };
}

export type VerdictCounts = Record<Verdict, number>;

const zero = (): VerdictCounts => ({ supported: 0, partly: 0, withheld: 0 });

/** Verdicts shown at `t`: per rival, unattributed, and in total. */
export function tallyAt(cmd: CommandRecord, t: number, ctx: DisplayCtx): { lanes: Record<string, VerdictCounts>; unattributed: number; total: VerdictCounts } {
  const lanes: Record<string, VerdictCounts> = {};
  const total = zero();
  let unattributed = 0;
  for (const v of cmd.verdicts) {
    if (!shownAt(v, t, ctx)) continue;
    total[v.verdict] += 1;
    if (v.lane === null) unattributed += 1;
    else (lanes[v.lane] ??= zero())[v.verdict] += 1;
  }
  return { lanes, unattributed, total };
}

/**
 * The latest withheld or partly claim of a rival shown at `t` (the claim worth reading). With `stepMs` the time is
 * read in steps, so the text changes at most once per step during a burst.
 */
export function notableAt(cmd: CommandRecord, lane: string, t: number, ctx: DisplayCtx, stepMs = 0): CmdVerdict | null {
  const tq = stepMs > 0 && Number.isFinite(t) ? Math.floor(t / stepMs) * stepMs : t;
  let hit: CmdVerdict | null = null;
  for (const v of cmd.verdicts) if (v.lane === lane && v.verdict !== "supported" && shownAt(v, tq, ctx)) hit = v;
  return hit;
}

/** A rival's latest recorded activity line shown at `t`. */
export function lineAt(cmd: CommandRecord, lane: string, t: number, ctx: DisplayCtx): CmdLine | null {
  let hit: CmdLine | null = null;
  for (const l of cmd.lines) if (l.lane === lane && shownAt(l, t, ctx)) hit = l;
  return hit;
}

/** Every rival's latest line shown at `t`. */
export function linesAt(cmd: CommandRecord, t: number, ctx: DisplayCtx): Record<string, CmdLine> {
  const out: Record<string, CmdLine> = {};
  for (const l of cmd.lines) if (shownAt(l, t, ctx)) out[l.lane] = l;
  return out;
}

export interface StampBeat {
  id: string;
  lane: string;
  verdict: Verdict;
  /** Display time of the beat's first verdict; the stamp lands then. */
  start: number;
  /** Display time of its last verdict. */
  last: number;
  /** When the slam itself is over. */
  end: number;
  count: number;
  /** Display time of each verdict in the beat (the stamp's count ticks with them). */
  ats: number[];
  /** False for history: it sets the scene and never animates. */
  fresh: boolean;
}

/**
 * One stamp per burst of a rival's verdicts: verdicts of one rival closer than `STAMP_GAP_MS` on the display clock,
 * with the same verdict, land as one stamp whose count ticks with them. A change of verdict is a new stamp.
 * Unattributed verdicts stamp no rival.
 */
export function stampBeats(cmd: CommandRecord, ctx: DisplayCtx): StampBeat[] {
  const beats: StampBeat[] = [];
  const open = new Map<string, StampBeat>();
  const placed = cmd.verdicts
    .filter((v): v is CmdVerdict & { lane: string } => v.lane !== null)
    .map((v) => ({ v, at: ctx.clock.at(v.ts) }))
    .sort((a, b) => a.at - b.at || a.v.seq - b.v.seq);
  for (const { v, at } of placed) {
    const cur = open.get(v.lane);
    if (cur && cur.verdict === v.verdict && at - cur.last < STAMP_GAP_MS) {
      cur.last = at;
      cur.count += 1;
      cur.ats.push(at);
      continue;
    }
    const beat: StampBeat = { id: `stamp:${v.lane}:${v.seq}`, lane: v.lane, verdict: v.verdict, start: at, last: at, end: at + STAMP_MS, count: 1, ats: [at], fresh: v.seq > ctx.settledSeq };
    open.set(v.lane, beat);
    beats.push(beat);
  }
  return beats;
}

/** How many of a beat's verdicts have landed by `t`. */
export function stampCountAt(beat: StampBeat, t: number): number {
  let n = 0;
  for (const at of beat.ats) if (at <= t) n += 1;
  return n;
}

export type StageState = "running" | StepStatus;

/** Each stage's state at `t`: running from its start, then how it finished; absent before it starts. A restarted
 *  stage keeps its latest start. */
export function stageStatesAt(cmd: CommandRecord, t: number, ctx: DisplayCtx): Partial<Record<StageId, { state: StageState; start: number; end: number | null }>> {
  const out: Partial<Record<StageId, { state: StageState; start: number; end: number | null }>> = {};
  for (const s of cmd.stages) {
    if (!shownAt(s, t, ctx)) continue;
    if (s.edge === "started") out[s.stage] = { state: "running", start: s.ts, end: null };
    else out[s.stage] = { state: s.status ?? "done", start: out[s.stage]?.start ?? s.ts, end: s.ts };
  }
  // a recorded run error ends every stage still running at it: the stage failed, it is not still at work
  const err = cmd.errors.filter((e) => shownAt(e, t, ctx)).at(-1);
  if (err) for (const st of Object.values(out)) if (st && st.state === "running" && st.start <= err.ts) Object.assign(st, { state: "failed", end: err.ts });
  return out;
}

/* ------------------------------------------------------------------------------------------------ gates and the clock */

export interface Hold {
  gate: Gate;
  start: number;
  /** When the person acted (Infinity while still waiting). */
  end: number;
  /** True when no approval row was read and the end is the first stage the run started after the park. */
  inferred: boolean;
}

const LATER_STAGES: ReadonlySet<string> = new Set(["S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15"]);

function approvalAt(approvals: Approvals | null, gate: Gate): number | null {
  const a = gate === "H1" ? approvals?.h1 : approvals?.h2;
  if (!a?.at) return null;
  const ms = Date.parse(a.at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The run's holds at human gates: from each park to the person's recorded approval; without one, an H1 hold ends
 * when a stage from S4 on starts after it, and an H2 hold when any stage starts after it (else it stays open).
 */
export function holdsOf(cmd: CommandRecord, approvals: Approvals | null): Hold[] {
  return cmd.parks.map((p) => {
    const acted = approvalAt(approvals, p.gate);
    if (acted !== null && acted >= p.ts) return { gate: p.gate, start: p.ts, end: acted, inferred: false };
    const resumed = cmd.stages.find((s) => s.edge === "started" && s.ts >= p.ts && (p.gate === "H2" || LATER_STAGES.has(s.stage)));
    return resumed ? { gate: p.gate, start: p.ts, end: resumed.ts, inferred: true } : { gate: p.gate, start: p.ts, end: Infinity, inferred: false };
  });
}

/** Run time at recorded time `R`: wall time since the run's first event, standing still during holds. */
export function runClock(cmd: CommandRecord, approvals: Approvals | null, R: number): { tPlus: number | null; wall: number } {
  if (cmd.runStart === null || !Number.isFinite(R)) return { tPlus: null, wall: R };
  let held = 0;
  for (const h of holdsOf(cmd, approvals)) held += Math.max(0, Math.min(R, h.end) - h.start);
  return { tPlus: Math.max(0, R - cmd.runStart - held), wall: R };
}

export interface GateView {
  state: "none" | "waiting" | "approved";
  parkTs: number | null;
  /** When the person acted (or, inferred, when the run resumed). */
  actedTs: number | null;
  heldMs: number | null;
  inferred: boolean;
}

/** Each gate at recorded time `R`. */
export function gatesAt(cmd: CommandRecord, approvals: Approvals | null, R: number): Record<Gate, GateView> {
  const holds = holdsOf(cmd, approvals);
  const view = (gate: Gate): GateView => {
    const hold = [...holds].reverse().find((h) => h.gate === gate && h.start <= R);
    const none: GateView = { state: "none", parkTs: null, actedTs: null, heldMs: null, inferred: false };
    if (!hold) {
      // an approval recorded with no park in this record (an older run, or a feed that started late)
      const a = gate === "H1" ? approvals?.h1 : approvals?.h2;
      const acted = approvalAt(approvals, gate);
      if (!a || (acted !== null && acted > R)) return none;
      return { ...none, state: "approved", actedTs: acted };
    }
    if (hold.end <= R) return { state: "approved", parkTs: hold.start, actedTs: hold.end, heldMs: hold.end - hold.start, inferred: hold.inferred };
    return { state: "waiting", parkTs: hold.start, actedTs: null, heldMs: R - hold.start, inferred: false };
  };
  return { H1: view("H1"), H2: view("H2") };
}

/* ------------------------------------------------------------------------------------------------ formatting */

/** Run time as "mm:ss.s" ("h:mm:ss.s" past an hour), rounded to tenths. */
export function formatTPlus(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const h = Math.floor(tenths / 36_000);
  const m = Math.floor((tenths % 36_000) / 600);
  const s = (tenths % 600) / 10;
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

/** A hold as "m:ss.s". */
export function formatHeld(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

/** A recorded time as the War Room writes it: 24-hour, the viewer's time zone, to the second. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A recorded time as the War Room writes it (24-hour, the viewer's time zone) plus tenths of a second. */
export function formatWall(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const rounded = Math.round(ms / 100) * 100;
  const d = new Date(rounded);
  const base = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${base}.${Math.floor((((rounded % 1000) + 1000) % 1000) / 100)}`;
}
