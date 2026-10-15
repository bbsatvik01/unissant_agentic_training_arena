/**
 * The S9-S10 agent swarm as the War Room shows it: a pure fold of the run's recorded swarm events (agent cards,
 * A2A messages, the board result) into groups of agents, a message thread and the board. bh-api serves the same
 * envelopes the stream carries (`GET /runs/{id}/swarm`), so a page opened after the run and a page that watched it
 * hold the same view.
 */
import {
  parseEvent,
  type AgentCard,
  type AgentMessage,
  type BoardResult,
  type RunEventEnvelope,
} from "@/lib/contracts/run-events";

import { ACTIVE_RUN_STATES } from "./state";

export type GroupKind = "rival" | "red_team" | "board" | "analyst";

export const SWARM_POLL_MS = 2000;
/** A run parked at a human gate can be approved in another tab: it is re-read slowly, so the panel (and the agent
 *  office's feed, which follows the run's state) notices when it runs again. */
export const PARKED_POLL_MS = 15_000;
/** Run states a run can come back from: parked at a human gate (H1, H2) until someone approves, in this tab or
 *  another, or interrupted until someone resumes it (`POST /runs/{id}/resume`). */
export const PARKED_STATES: ReadonlySet<string> = new Set(["awaiting_plan_approval", "awaiting_decision", "awaiting_review", "interrupted"]);

/** When to re-read the swarm after a read that found the run in `status`: soon while it runs, slowly while it waits at a
 *  human gate, never once it has ended. */
export function swarmPollDelay(status: string): number | null {
  if (ACTIVE_RUN_STATES.has(status)) return SWARM_POLL_MS;
  return PARKED_STATES.has(status) ? PARKED_POLL_MS : null;
}

export interface SwarmGroup {
  id: string;
  label: string;
  kind: GroupKind;
  agents: AgentCard[];
}

export interface SwarmItem extends AgentMessage {
  seq: number;
  ts: string;
}

export interface SwarmTotals {
  agents: number;
  messages: number;
  rounds: number[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  free: number;
  failed: number;
  rejected: number;
  latencyMs: number;
}

/** Where an event sits in the ledger: its sequence number and recorded time. */
export interface Recorded {
  seq: number;
  ts: string;
}

export interface SwarmView {
  cards: Record<string, AgentCard>;
  /** When each agent's card was first recorded (the agent joined the swarm). */
  cardSeen: Record<string, Recorded>;
  groups: SwarmGroup[];
  messages: SwarmItem[];
  board: BoardResult | null;
  /** When the board result was recorded. */
  boardSeen: Recorded | null;
  totals: SwarmTotals;
}

const KIND_ORDER: Record<GroupKind, number> = { rival: 0, red_team: 1, analyst: 2, board: 3 };

function groupKind(group: string): GroupKind {
  if (group === "red_team" || group === "board" || group === "analyst") return group;
  return "rival";
}

/** Fold envelopes (any order, duplicates allowed) into the view; off-contract frames are skipped. */
export function foldSwarm(envs: readonly RunEventEnvelope[]): SwarmView {
  const cards: Record<string, AgentCard> = {};
  const cardSeen: Record<string, Recorded> = {};
  const byId = new Map<string, SwarmItem>();
  const firstSeen = new Map<string, number>();
  let board: BoardResult | null = null;
  let boardSeen: Recorded | null = null;
  for (const env of [...envs].sort((a, b) => a.seq - b.seq)) {
    const ev = env.event;
    if (ev.type !== "ACTIVITY_SNAPSHOT") continue;
    if (ev.activityType === "agent_card") {
      cards[ev.content.agentId] = ev.content;
      cardSeen[ev.content.agentId] ??= { seq: env.seq, ts: env.ts };
      if (!firstSeen.has(ev.content.group)) firstSeen.set(ev.content.group, env.seq);
    } else if (ev.activityType === "agent_message") {
      byId.set(ev.content.messageId, { ...ev.content, seq: env.seq, ts: env.ts });
    } else if (ev.activityType === "board_result") {
      board = ev.content;
      boardSeen = { seq: env.seq, ts: env.ts };
    }
  }
  const groups = new Map<string, SwarmGroup>();
  for (const card of Object.values(cards)) {
    const g = groups.get(card.group) ?? { id: card.group, label: card.groupLabel, kind: groupKind(card.group), agents: [] };
    g.agents.push(card);
    groups.set(card.group, g);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0),
  );
  const messages = [...byId.values()].sort((a, b) => a.seq - b.seq);
  return { cards, cardSeen, groups: ordered, messages, board, boardSeen, totals: totals(Object.keys(cards).length, messages) };
}

function totals(agents: number, messages: readonly SwarmItem[]): SwarmTotals {
  const t: SwarmTotals = { agents, messages: messages.length, rounds: [], costUsd: 0, inputTokens: 0, outputTokens: 0, free: 0, failed: 0, rejected: 0, latencyMs: 0 };
  const rounds = new Set<number>();
  for (const m of messages) {
    rounds.add(m.round);
    t.costUsd += m.usage.costUsd;
    t.inputTokens += m.usage.inputTokens;
    t.outputTokens += m.usage.outputTokens;
    t.latencyMs += m.usage.latencyMs;
    if (m.usage.free) t.free += 1;
    if (m.state === "failed") t.failed += 1;
    if (m.state === "rejected") t.rejected += 1;
  }
  t.rounds = [...rounds].sort((a, b) => a - b);
  return t;
}

/** Parse bh-api's `/swarm` body ({status, events: envelope[]}); frames off the contract are dropped. */
export function parseSwarmBody(body: unknown): { status: string; envelopes: RunEventEnvelope[] } {
  if (typeof body !== "object" || body === null) return { status: "", envelopes: [] };
  const { status, events } = body as { status?: unknown; events?: unknown };
  const envelopes: RunEventEnvelope[] = [];
  if (Array.isArray(events)) {
    for (const raw of events) {
      if (typeof raw !== "object" || raw === null) continue;
      const { seq, runId, idemKey, ts, event } = raw as Record<string, unknown>;
      const parsed = parseEvent(event);
      if (parsed && typeof seq === "number" && typeof runId === "string" && typeof idemKey === "string" && typeof ts === "string") {
        envelopes.push({ seq, runId, idemKey, ts, event: parsed });
      }
    }
  }
  return { status: typeof status === "string" ? status : "", envelopes };
}

export const ROUND_LABEL: Record<number, string> = {
  1: "Round 1: briefs and draft strategy",
  2: "Round 2: red-team challenge",
  3: "Round 3: response and interview",
  4: "Board: de-identified scoring",
};

export const KIND_LABEL: Record<AgentMessage["kind"], string> = {
  brief: "Brief",
  strategy: "Strategy",
  challenge: "Challenge",
  response: "Response",
  interview: "Interview",
  rating: "Rating",
};

export function agentName(view: SwarmView, id: string): string {
  if (id === "board") return "Evaluation board";
  return view.cards[id]?.name ?? id;
}

/** The latest completed strategy or response of one rival (its final position). */
export function finalPosition(view: SwarmView, rival: string): SwarmItem | null {
  const own = view.messages.filter((m) => m.contextId === rival && m.state === "completed" && (m.kind === "response" || m.kind === "strategy"));
  return own.at(-1) ?? null;
}

export interface InterviewStatement {
  text: string;
  codes: string[];
}

export interface InterviewQa {
  question: string;
  statements: InterviewStatement[];
  withheld: number;
}

/** The interview turns carried in an interview message's data part (shape-checked; anything else is dropped). */
export function interviewOf(m: AgentMessage | null | undefined): InterviewQa[] {
  const raw = m?.data.interview;
  if (!Array.isArray(raw)) return [];
  const out: InterviewQa[] = [];
  for (const t of raw) {
    if (typeof t !== "object" || t === null) continue;
    const { question, statements, withheld } = t as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(statements) || typeof withheld !== "number") continue;
    const ok = statements.filter(
      (s): s is InterviewStatement =>
        typeof s === "object" && s !== null && typeof (s as InterviewStatement).text === "string" && Array.isArray((s as InterviewStatement).codes),
    );
    out.push({ question, statements: ok, withheld });
  }
  return out;
}

/** A rival's short name for chips and graph labels: its first two words, without punctuation or a lone "&". */
export function shortName(label: string): string {
  const words = label.split(/[\s,.]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.slice(0, 2).join(" ");
}

export function formatUsd(v: number): string {
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
