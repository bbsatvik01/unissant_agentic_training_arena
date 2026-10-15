/**
 * `run_events` contract (SPEC REQ-RUN-10): one row per event, per-run `seq`, unique `idem_key`,
 * AG-UI 1.0 event types, no REASONING_* events, <= 16 KB each. The SSE stream carries one envelope
 * per frame with `id: <seq>`, so a reconnect resumes with `seq > Last-Event-ID`.
 *
 * Deltas carry ABSOLUTE values (a counter's new total, a cell's new state), never increments, so
 * re-applying an event is idempotent and a missed event is repaired by any later event or snapshot.
 */
import type { StageId, StageStatus } from "@/lib/stages";

export const MAX_EVENT_BYTES = 16 * 1024;

export type CellState = "pending" | "anchored" | "verified" | "contested" | "withheld";
/** `ended`: the lane recorded its end with no outcome (a stub lane): never shown as research done. */
export type LaneStatus = "queued" | "running" | "done" | "degraded" | "ended";
export type SourceTier = "federal_primary" | "sec_filing" | "company_owned" | "news" | "other";

export interface MatrixColumn {
  key: string;
  label: string;
}

export interface Lane {
  subject: string;
  label: string;
  home: boolean;
  status: LaneStatus;
  fetches: number;
  /** Last activity line, rendered from a real tool call (never narrated). */
  activity: string;
}

export interface Cell {
  subject: string;
  column: string;
  state: CellState;
  rows: number;
  /** Claim-level verdict counts behind the state. */
  supported: number;
  partial: number;
  unsupported: number;
}

export interface Counters {
  fetches: number;
  rows: number;
  claimsChecked: number;
  supported: number;
  partial: number;
  unsupported: number;
  withheld: number;
}

export interface WarRoomSnapshot {
  runId: string;
  opportunity: string;
  lanes: Record<string, Lane>;
  laneOrder: string[];
  columns: MatrixColumn[];
  cells: Record<string, Cell>;
  cost: { usd: number; capUsd: number };
  counters: Counters;
  stages: Partial<Record<StageId, StageStatus>>;
}

export interface FetchActivity {
  subject: string;
  evidenceId: string;
  host: string;
  sourceType: string;
  tier: SourceTier;
  status: "ok" | "blocked" | "error";
  column: string;
}

export interface VerifyActivity {
  claimId: string;
  claim: string;
  verdict: "supported" | "partially_supported" | "unsupported";
  sourceUnreachable: boolean;
  /** Optional: sources of corrections a later stage recorded against this claim's wording. */
  laterCorrections?: string[];
}

/**
 * The S9-S10 agent swarm (A2A-shaped, recorded in-process; docs/research/swarm/A2A.md). One `agent_card` per agent,
 * one `agent_message` per agent turn (an A2A message: role `agent`, a text part, a data part, its task state), one
 * `board_result` when the simulated board is unblinded. `reasoning` is the agent's own short summary field, never
 * raw model thinking (SPEC OBS-01).
 */
export interface AgentCard {
  agentId: string;
  name: string;
  role: string;
  /** A rival key, `red_team`, `board` or `analyst`. */
  group: string;
  groupLabel: string;
  stage: StageId;
  skills: string[];
  /** What the agent may read (REQ-WAR-02 inputs_read). */
  reads: string;
}

export type AgentMessageKind = "brief" | "strategy" | "challenge" | "response" | "interview" | "rating";
export type AgentTaskState = "completed" | "failed" | "rejected";

export interface AgentCitation {
  /** The evidence code the agent saw (E1, E2, ...). */
  code: string;
  claimId: string;
  text: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
  /** Served on a free tier (cost 0 for a real call), not an error. */
  free: boolean;
}

export interface AgentMessage {
  messageId: string;
  contextId: string;
  taskId: string;
  stage: StageId;
  round: number;
  kind: AgentMessageKind;
  role: "agent";
  from: string;
  to: string[];
  state: AgentTaskState;
  text: string;
  reasoning: string;
  citations: AgentCitation[];
  /** Points dropped (or interview statements withheld) by cite-or-drop. */
  dropped: number;
  usage: AgentUsage;
  data: Record<string, unknown>;
}

export interface BoardRow {
  group: string;
  label: string;
  /** The de-identified code the board saw ("" when the rival never reached the board). */
  code: string;
  incumbent: boolean;
  share: number;
  ratings: Record<string, number>;
}

export interface BoardResult {
  label: string;
  members: number;
  runs: number;
  /** How the runs became shares (a softmax vote per run); absent on runs recorded before it was sent. */
  method?: string;
  rows: BoardRow[];
  notes: string[];
  budget: { capUsd: number; spentUsd: number; calls: number; maxCalls: number; agents: number; messages: number };
}

export interface JsonPatchOp {
  op: "replace" | "add";
  path: string;
  value: unknown;
}

export type RunEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string; phase: "prepare" | "execute" }
  | { type: "RUN_FINISHED"; threadId: string; runId: string; result: { state: string } }
  | { type: "RUN_ERROR"; message: string; code?: string }
  | { type: "STEP_STARTED"; stepName: StageId }
  | { type: "STEP_FINISHED"; stepName: StageId; status?: StepStatus }
  | { type: "STATE_SNAPSHOT"; snapshot: WarRoomSnapshot }
  | { type: "STATE_DELTA"; delta: JsonPatchOp[] }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: "fetch"; content: FetchActivity }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: "verify"; content: VerifyActivity }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: "agent_card"; content: AgentCard }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: "agent_message"; content: AgentMessage }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: "board_result"; content: BoardResult }
  /**
   * AG-UI CUSTOM: a recorded event with no display contract yet. bh-api sends it with the event type and
   * the stage id only (never a recorded free-text field), so the sequence stays gap-free and the War Room
   * can say how many recorded events it does not render.
   */
  | { type: "CUSTOM"; name: string; value: { stage?: StageId; oversize?: true } };

/** How a finished stage ended. A stub stage is `not_built` and must never be shown as done. */
export type StepStatus = "done" | "not_built" | "degraded" | "failed";

export type RunEventType = RunEvent["type"];

export interface RunEventEnvelope {
  seq: number;
  runId: string;
  idemKey: string;
  /** ISO timestamp the event was recorded. */
  ts: string;
  event: RunEvent;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<RunEventType>([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "STEP_STARTED",
  "STEP_FINISHED",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "ACTIVITY_SNAPSHOT",
  "CUSTOM",
]);
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>(["done", "not_built", "degraded", "failed"]);

const FORBIDDEN = /^REASONING_/;

const CELL_STATES: ReadonlySet<string> = new Set<CellState>(["pending", "anchored", "verified", "contested", "withheld"]);
const LANE_STATUSES: ReadonlySet<string> = new Set<LaneStatus>(["queued", "running", "done", "degraded", "ended"]);
const STAGE_STATUSES: ReadonlySet<string> = new Set(["not_started", "running", "done", "degraded", "failed", "not_built"]);
const TIERS: ReadonlySet<string> = new Set<SourceTier>(["federal_primary", "sec_filing", "company_owned", "news", "other"]);
const COUNTER_KEYS = ["fetches", "rows", "claimsChecked", "supported", "partial", "unsupported", "withheld"] as const;
const CELL_COUNTS = ["rows", "supported", "partial", "unsupported"] as const;
const STAGE_ID = /^S\d{1,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";

function isCounters(v: unknown): boolean {
  return isRecord(v) && COUNTER_KEYS.every((k) => isCount(v[k]));
}

function isCell(v: unknown): boolean {
  return isRecord(v) && isStr(v.subject) && isStr(v.column) && isStr(v.state) && CELL_STATES.has(v.state) && CELL_COUNTS.every((k) => isCount(v[k]));
}

function isLane(v: unknown): boolean {
  return (
    isRecord(v) && isStr(v.subject) && isStr(v.label) && typeof v.home === "boolean" && isStr(v.status) && LANE_STATUSES.has(v.status) && isCount(v.fetches) && isStr(v.activity)
  );
}

function isSnapshot(v: unknown): v is WarRoomSnapshot {
  if (!isRecord(v) || !isStr(v.runId) || !isStr(v.opportunity)) return false;
  if (!Array.isArray(v.laneOrder) || !v.laneOrder.every(isStr)) return false;
  if (!Array.isArray(v.columns) || !v.columns.every((c) => isRecord(c) && isStr(c.key) && isStr(c.label))) return false;
  if (!isRecord(v.cost) || !isCount(v.cost.usd) || !isCount(v.cost.capUsd)) return false;
  if (!isCounters(v.counters)) return false;
  if (!isRecord(v.lanes) || !Object.values(v.lanes).every(isLane)) return false;
  if (!isRecord(v.cells) || !Object.values(v.cells).every(isCell)) return false;
  if (!isRecord(v.stages) || !Object.entries(v.stages).every(([k, s]) => STAGE_ID.test(k) && isStr(s) && STAGE_STATUSES.has(s))) return false;
  return v.laneOrder.every((s) => Object.hasOwn(v.lanes as object, s));
}

function isFetch(v: unknown): boolean {
  return (
    isRecord(v) &&
    isStr(v.subject) &&
    isStr(v.evidenceId) &&
    isStr(v.host) &&
    isStr(v.sourceType) &&
    isStr(v.tier) &&
    TIERS.has(v.tier) &&
    (v.status === "ok" || v.status === "blocked" || v.status === "error") &&
    isStr(v.column)
  );
}

function isVerify(v: unknown): boolean {
  return (
    isRecord(v) &&
    isStr(v.claimId) &&
    isStr(v.claim) &&
    (v.verdict === "supported" || v.verdict === "partially_supported" || v.verdict === "unsupported") &&
    typeof v.sourceUnreachable === "boolean" &&
    (v.laterCorrections === undefined || (Array.isArray(v.laterCorrections) && v.laterCorrections.every(isStr)))
  );
}

const AGENT_KINDS: ReadonlySet<string> = new Set<AgentMessageKind>(["brief", "strategy", "challenge", "response", "interview", "rating"]);
const AGENT_STATES: ReadonlySet<string> = new Set<AgentTaskState>(["completed", "failed", "rejected"]);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isStage = (v: unknown): v is StageId => isStr(v) && STAGE_ID.test(v);

export function isAgentCard(v: unknown): v is AgentCard {
  return (
    isRecord(v) &&
    ["agentId", "name", "role", "group", "groupLabel", "reads"].every((k) => isStr(v[k])) &&
    isStage(v.stage) &&
    isStrs(v.skills)
  );
}

function isUsage(v: unknown): v is AgentUsage {
  return (
    isRecord(v) &&
    ["inputTokens", "outputTokens", "costUsd", "latencyMs"].every((k) => isCount(v[k])) &&
    isStr(v.model) &&
    typeof v.free === "boolean"
  );
}

export function isAgentMessage(v: unknown): v is AgentMessage {
  return (
    isRecord(v) &&
    ["messageId", "contextId", "taskId", "from", "text", "reasoning"].every((k) => isStr(v[k])) &&
    isStage(v.stage) &&
    isStr(v.kind) &&
    AGENT_KINDS.has(v.kind) &&
    v.role === "agent" &&
    isStr(v.state) &&
    AGENT_STATES.has(v.state) &&
    Number.isInteger(v.round) &&
    isCount(v.round) &&
    isStrs(v.to) &&
    Array.isArray(v.citations) &&
    v.citations.every((c) => isRecord(c) && isStr(c.code) && isStr(c.claimId) && isStr(c.text)) &&
    isCount(v.dropped) &&
    isUsage(v.usage) &&
    isRecord(v.data)
  );
}

function isBoardRow(v: unknown): v is BoardRow {
  return (
    isRecord(v) &&
    isStr(v.group) &&
    isStr(v.label) &&
    isStr(v.code) &&
    typeof v.incumbent === "boolean" &&
    isCount(v.share) &&
    isRecord(v.ratings) &&
    Object.values(v.ratings).every(isCount)
  );
}

export function isBoardResult(v: unknown): v is BoardResult {
  const b = isRecord(v) ? v.budget : undefined;
  return (
    isRecord(v) &&
    isStr(v.label) &&
    isCount(v.members) &&
    isCount(v.runs) &&
    Array.isArray(v.rows) &&
    v.rows.every(isBoardRow) &&
    isStrs(v.notes) &&
    isRecord(b) &&
    ["capUsd", "spentUsd", "calls", "maxCalls", "agents", "messages"].every((k) => isCount(b[k]))
  );
}

function isPatchOp(value: unknown): value is JsonPatchOp {
  return (
    isRecord(value) &&
    (value.op === "replace" || value.op === "add") &&
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    "value" in value
  );
}

/**
 * The only state paths a delta may write, each with the value type it must carry. A delta that
 * breaks this is dropped (and counted) instead of putting a shape into the view that the
 * components cannot render.
 */
export function isValidPatch(op: JsonPatchOp): boolean {
  const p = op.path.split("/").slice(1);
  const v = op.value;
  switch (p[0]) {
    case "cost":
      return p.length === 2 && p[1] === "usd" && isCount(v);
    case "counters":
      if (p.length === 1) return isCounters(v);
      return p.length === 2 && (COUNTER_KEYS as readonly string[]).includes(p[1] ?? "") && isCount(v);
    case "lanes":
      if (p.length !== 3) return false;
      if (p[2] === "status") return isStr(v) && LANE_STATUSES.has(v);
      if (p[2] === "activity") return isStr(v);
      return p[2] === "fetches" && isCount(v);
    case "cells":
      if (p.length === 2) return isCell(v);
      if (p.length !== 3) return false;
      if (p[2] === "state") return isStr(v) && CELL_STATES.has(v);
      return (CELL_COUNTS as readonly string[]).includes(p[2] ?? "") && isCount(v);
    case "stages":
      return p.length === 2 && STAGE_ID.test(p[1] ?? "") && isStr(v) && STAGE_STATUSES.has(v);
    default:
      return false;
  }
}

/** Structural check of one event body; null when the stream carried something off-contract. */
export function parseEvent(value: unknown): RunEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (FORBIDDEN.test(value.type) || !EVENT_TYPES.has(value.type)) return null;
  switch (value.type) {
    case "RUN_STARTED":
      return isStr(value.runId) && isStr(value.threadId) && (value.phase === "prepare" || value.phase === "execute") ? (value as RunEvent) : null;
    case "RUN_FINISHED":
      return isStr(value.runId) && isStr(value.threadId) && isRecord(value.result) && isStr(value.result.state) ? (value as RunEvent) : null;
    case "RUN_ERROR":
      return isStr(value.message) ? (value as RunEvent) : null;
    case "STEP_STARTED":
      return isStr(value.stepName) && STAGE_ID.test(value.stepName) ? (value as RunEvent) : null;
    case "STEP_FINISHED":
      if (!isStr(value.stepName) || !STAGE_ID.test(value.stepName)) return null;
      return value.status === undefined || (isStr(value.status) && STEP_STATUSES.has(value.status)) ? (value as RunEvent) : null;
    case "CUSTOM":
      return isStr(value.name) &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(value.name) &&
        isRecord(value.value) &&
        Object.keys(value.value).every((k) => k === "stage" || k === "oversize") &&
        (value.value.stage === undefined || (isStr(value.value.stage) && STAGE_ID.test(value.value.stage))) &&
        (value.value.oversize === undefined || value.value.oversize === true)
        ? (value as RunEvent)
        : null;
    case "STATE_SNAPSHOT":
      return isSnapshot(value.snapshot) ? (value as RunEvent) : null;
    case "STATE_DELTA":
      return Array.isArray(value.delta) && value.delta.every(isPatchOp) ? (value as RunEvent) : null;
    default:
      if (!isStr(value.messageId)) return null;
      if (value.activityType === "fetch") return isFetch(value.content) ? (value as RunEvent) : null;
      if (value.activityType === "verify") return isVerify(value.content) ? (value as RunEvent) : null;
      if (value.activityType === "agent_card") return isAgentCard(value.content) ? (value as RunEvent) : null;
      if (value.activityType === "agent_message") return isAgentMessage(value.content) ? (value as RunEvent) : null;
      if (value.activityType === "board_result") return isBoardResult(value.content) ? (value as RunEvent) : null;
      return null;
  }
}

/** Parse one SSE frame's JSON. Rejects oversize frames, bad seq and off-contract events. */
export function parseEnvelope(raw: string): RunEventEnvelope | null {
  if (raw.length > MAX_EVENT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { seq, runId, idemKey, ts } = value;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (typeof runId !== "string" || typeof idemKey !== "string" || typeof ts !== "string") return null;
  const event = parseEvent(value.event);
  if (!event) return null;
  return { seq, runId, idemKey, ts, event };
}

export function cellKey(subject: string, column: string): string {
  return `${subject}:${column}`;
}
