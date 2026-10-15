/**
 * Builds the recorded `run_events` stream for a War Room replay from a finished run's artifacts:
 * every fetch is a real evidence row (its host, source type and tier), every verdict is a real
 * claim-level verification result. Only the pacing and the dollar figures are synthetic: spend is
 * drawn down from the SPEC stage budgets, and the UI labels it that way.
 *
 * Deterministic: the same input always yields byte-identical envelopes.
 */
import {
  cellKey,
  type Cell,
  type CellState,
  type Counters,
  type JsonPatchOp,
  type Lane,
  type MatrixColumn,
  type RunEvent,
  type RunEventEnvelope,
  type SourceTier,
  type WarRoomSnapshot,
} from "@/lib/contracts/run-events";
import { STAGES, type StageId, type StageStatus } from "@/lib/stages";

export interface ScriptRow {
  id: string;
  column: string;
  tier: SourceTier;
  host: string;
  sourceType: string;
}

export interface ScriptSubject {
  slug: string;
  label: string;
  home: boolean;
  rows: ScriptRow[];
}

export interface ScriptClaim {
  claimId: string;
  claim: string;
  evidenceIds: string[];
  verdict: "supported" | "partially_supported" | "unsupported";
  sourceUnreachable: boolean;
  /** Sources of corrections recorded after this verdict (see statements.laterFindings). */
  laterCorrections?: string[];
}

export interface ScriptInput {
  runId: string;
  opportunity: string;
  startTs: string;
  columns: MatrixColumn[];
  subjects: ScriptSubject[];
  claims: ScriptClaim[];
  capUsd: number;
  /** Lanes in flight at once (REQ-RUN-02 `max_concurrency`). */
  concurrency?: number;
}

export const PACE = {
  rowMs: 260,
  claimMs: 170,
  stageMs: 650,
} as const;

/** Share of each stage budget the replay draws down; the rest is headroom under the cap. */
const SPEND_SHARE = 0.8;

export function cellStateFor(cell: Pick<Cell, "rows" | "supported" | "partial" | "unsupported">): CellState {
  if (cell.unsupported > 0) return "withheld";
  if (cell.partial > 0) return "contested";
  if (cell.supported > 0) return "verified";
  if (cell.rows > 0) return "anchored";
  return "pending";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function budgetOf(id: StageId): number {
  return STAGES.find((s) => s.id === id)?.budgetUsd ?? 0;
}

export function buildScript(input: ScriptInput): RunEventEnvelope[] {
  const start = Date.parse(input.startTs);
  if (Number.isNaN(start)) throw new Error(`bad startTs: ${input.startTs}`);
  const concurrency = Math.max(1, input.concurrency ?? 3);
  const timed: { at: number; kind: string; event: RunEvent }[] = [];
  const emit = (at: number, kind: string, event: RunEvent) => timed.push({ at, kind, event });

  // ---- initial snapshot: prepare (S0-S3) is done, H1 approved, execute begins.
  const lanes: Record<string, Lane> = {};
  const cells: Record<string, Cell> = {};
  for (const s of input.subjects) {
    lanes[s.slug] = { subject: s.slug, label: s.label, home: s.home, status: "queued", fetches: 0, activity: "Waiting for a lane" };
    for (const c of input.columns) {
      cells[cellKey(s.slug, c.key)] = { subject: s.slug, column: c.key, state: "pending", rows: 0, supported: 0, partial: 0, unsupported: 0 };
    }
  }
  const stages: Partial<Record<StageId, StageStatus>> = {};
  for (const st of STAGES) stages[st.id] = st.phase === "prepare" ? "done" : "not_started";
  const counters: Counters = { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 };
  let cost = round2(budgetOf("S0") * SPEND_SHARE + budgetOf("S2") * SPEND_SHARE + budgetOf("S3") * SPEND_SHARE);
  const snapshot: WarRoomSnapshot = {
    runId: input.runId,
    opportunity: input.opportunity,
    lanes,
    laneOrder: input.subjects.map((s) => s.slug),
    columns: input.columns,
    cells,
    cost: { usd: cost, capUsd: input.capUsd },
    counters: { ...counters },
    stages,
  };
  emit(0, "run", { type: "RUN_STARTED", threadId: `run:${input.runId}`, runId: input.runId, phase: "execute" });
  emit(0, "snapshot", { type: "STATE_SNAPSHOT", snapshot: structuredClone(snapshot) });

  // ---- S4 evidence: lanes under a concurrency cap, one fetch per evidence row.
  let t = 300;
  emit(t, "step", { type: "STEP_STARTED", stepName: "S4" });
  const totalRows = input.subjects.reduce((n, s) => n + s.rows.length, 0);
  const perFetch = totalRows > 0 ? (budgetOf("S4") * SPEND_SHARE) / totalRows : 0;
  const workers = Array.from({ length: Math.min(concurrency, input.subjects.length) }, () => t + 200);
  const liveCells = new Map<string, Cell>(Object.entries(cells).map(([k, v]) => [k, { ...v }]));

  // Phase A: schedule every lane event in time. Nothing cumulative is computed here, because lanes
  // interleave: totals computed in lane order would run ahead of the clock once sorted.
  type Planned =
    | { at: number; seq: number; kind: "start" | "done"; subject: ScriptSubject; fetches: number }
    | { at: number; seq: number; kind: "fetch"; subject: ScriptSubject; row: ScriptRow; fetches: number };
  const planned: Planned[] = [];
  let s4End = t;
  for (const subject of input.subjects) {
    const w = workers.indexOf(Math.min(...workers));
    let clock = workers[w] ?? t;
    planned.push({ at: clock, seq: planned.length, kind: "start", subject, fetches: 0 });
    subject.rows.forEach((row, i) => {
      clock += PACE.rowMs;
      planned.push({ at: clock, seq: planned.length, kind: "fetch", subject, row, fetches: i + 1 });
    });
    clock += 200;
    planned.push({ at: clock, seq: planned.length, kind: "done", subject, fetches: subject.rows.length });
    workers[w] = clock;
    s4End = Math.max(s4End, clock);
  }
  planned.sort((x, y) => x.at - y.at || x.seq - y.seq);

  // Phase B: walk the timeline in order, so every running total is what the clock has reached.
  let fetchTotal = 0;
  let spent = cost;
  for (const p of planned) {
    const slug = p.subject.slug;
    if (p.kind !== "fetch") {
      const starting = p.kind === "start";
      emit(p.at, "lane", {
        type: "STATE_DELTA",
        delta: [
          { op: "replace", path: `/lanes/${slug}/status`, value: starting ? "running" : "done" },
          {
            op: "replace",
            path: `/lanes/${slug}/activity`,
            value: starting ? `Planning ${p.subject.rows.length} fetches` : `${p.fetches} rows kept, quotes matched`,
          },
        ],
      });
      continue;
    }
    const row = p.row;
    fetchTotal += 1;
    spent += perFetch;
    const key = cellKey(slug, row.column);
    const cell = liveCells.get(key);
    emit(p.at, "fetch", {
      type: "ACTIVITY_SNAPSHOT",
      messageId: `fetch-${row.id}`,
      activityType: "fetch",
      content: { subject: slug, evidenceId: row.id, host: row.host, sourceType: row.sourceType, tier: row.tier, status: "ok", column: row.column },
    });
    const delta: JsonPatchOp[] = [
      { op: "replace", path: `/lanes/${slug}/fetches`, value: p.fetches },
      { op: "replace", path: `/lanes/${slug}/activity`, value: `GET ${row.host} (${row.sourceType})` },
      { op: "replace", path: "/counters/fetches", value: fetchTotal },
      { op: "replace", path: "/counters/rows", value: fetchTotal },
      { op: "replace", path: "/cost/usd", value: round2(spent) },
    ];
    if (cell) {
      cell.rows += 1;
      cell.state = cellStateFor(cell);
      delta.push({ op: "replace", path: `/cells/${key}/rows`, value: cell.rows });
      delta.push({ op: "replace", path: `/cells/${key}/state`, value: cell.state });
    }
    emit(p.at, "delta", { type: "STATE_DELTA", delta });
  }
  cost = round2(spent);
  t = s4End + 300;
  emit(t, "step", { type: "STEP_FINISHED", stepName: "S4" });

  // ---- S5 rows and S6 dossiers: deterministic checks, then one dossier per subject.
  for (const id of ["S5", "S6"] as const) {
    emit(t, "step", { type: "STEP_STARTED", stepName: id });
    t += PACE.stageMs;
    cost = round2(cost + budgetOf(id) * SPEND_SHARE);
    emit(t, "cost", { type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: cost }] });
    emit(t, "step", { type: "STEP_FINISHED", stepName: id });
  }

  // ---- S7 verify: claim-level verdicts move cells to verified / contested / withheld.
  emit(t, "step", { type: "STEP_STARTED", stepName: "S7" });
  const rowCell = new Map<string, string>();
  for (const s of input.subjects) for (const r of s.rows) rowCell.set(r.id, cellKey(s.slug, r.column));
  const perClaim = input.claims.length > 0 ? (budgetOf("S7") * SPEND_SHARE) / input.claims.length : 0;
  const tally = { ...counters, fetches: fetchTotal, rows: fetchTotal };
  const withheldCells = new Set<string>();
  for (const claim of input.claims) {
    t += PACE.claimMs;
    cost = round2(cost + perClaim);
    tally.claimsChecked += 1;
    if (claim.verdict === "supported") tally.supported += 1;
    else if (claim.verdict === "partially_supported") tally.partial += 1;
    else tally.unsupported += 1;
    emit(t, "verify", {
      type: "ACTIVITY_SNAPSHOT",
      messageId: `verify-${claim.claimId}`,
      activityType: "verify",
      content: {
        claimId: claim.claimId,
        claim: claim.claim,
        verdict: claim.verdict,
        sourceUnreachable: claim.sourceUnreachable,
        ...(claim.laterCorrections && claim.laterCorrections.length > 0 ? { laterCorrections: claim.laterCorrections } : {}),
      },
    });
    const delta: JsonPatchOp[] = [];
    const touched = new Set(claim.evidenceIds.map((id) => rowCell.get(id)).filter((k): k is string => k !== undefined));
    for (const key of touched) {
      const cell = liveCells.get(key);
      if (!cell) continue;
      if (claim.verdict === "supported") cell.supported += 1;
      else if (claim.verdict === "partially_supported") cell.partial += 1;
      else cell.unsupported += 1;
      cell.state = cellStateFor(cell);
      if (cell.state === "withheld") withheldCells.add(key);
      delta.push({ op: "replace", path: `/cells/${key}`, value: { ...cell } });
    }
    tally.withheld = withheldCells.size;
    delta.push(
      { op: "replace", path: "/counters", value: { ...tally } },
      { op: "replace", path: "/cost/usd", value: cost },
    );
    emit(t, "delta", { type: "STATE_DELTA", delta });
  }
  t += 300;
  emit(t, "step", { type: "STEP_FINISHED", stepName: "S7" });

  // ---- S8-S15: analytics, role-play, board, counters, decision, brief, check, export.
  for (const st of STAGES.filter((s) => stageNumber(s.id) >= 8)) {
    emit(t, "step", { type: "STEP_STARTED", stepName: st.id });
    t += PACE.stageMs;
    cost = round2(cost + st.budgetUsd * SPEND_SHARE);
    emit(t, "cost", { type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: cost }] });
    emit(t, "step", { type: "STEP_FINISHED", stepName: st.id });
  }
  t += 300;
  emit(t, "run", { type: "RUN_FINISHED", threadId: `run:${input.runId}`, runId: input.runId, result: { state: "awaiting_decision" } });

  // Stable order: by time, then by emission order (Array.prototype.sort is stable).
  const ordered = timed.map((e, i) => ({ ...e, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  return ordered.map((e, idx) => ({
    seq: idx + 1,
    runId: input.runId,
    idemKey: `${input.runId}/g0/execute/${e.kind}/${idx + 1}`,
    ts: new Date(start + e.at).toISOString(),
    event: e.event,
  }));
}

function stageNumber(id: StageId): number {
  return Number(id.slice(1));
}

/** Milliseconds from the first envelope; the replay player paces by this. */
export function offsetsOf(envs: readonly RunEventEnvelope[]): number[] {
  const first = envs[0];
  if (!first) return [];
  const t0 = Date.parse(first.ts);
  return envs.map((e) => Date.parse(e.ts) - t0);
}
