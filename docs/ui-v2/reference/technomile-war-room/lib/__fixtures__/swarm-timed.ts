/**
 * A synthetic swarm with the timing and structure of recorded run 966d27c7 (four rivals, a red team, the home
 * analyst and a three-member board): seconds below are from its first message's reference instant T0; the S9 origin
 * (the first card) is at -10.6 s. Text is placeholder; times, kinds, rounds, targets and latencies follow the record.
 */
import { parseEvent, type AgentCard, type AgentMessage, type RunEventEnvelope } from "@/lib/contracts/run-events";

import { foldSwarm, type SwarmView } from "../swarm";

export const T0 = Date.parse("2026-10-03T14:32:02.600Z");
export const at = (s: number) => new Date(T0 + Math.round(s * 1000)).toISOString();

export const RIVALS = [
  { id: "cgi", label: "CGI FEDERAL INC." },
  { id: "akumen", label: "Akumen Systems LLC" },
  { id: "zen", label: "Zenpoint Solutions" },
  { id: "deloitte", label: "Deloitte Consulting LLP" },
] as const;

const card = (agentId: string, group: string, role: string, groupLabel: string, name = `${role} ${groupLabel}`): AgentCard => ({
  agentId,
  name,
  role,
  group,
  groupLabel,
  stage: group === "board" ? "S10" : "S9",
  skills: [],
  reads: "accepted claims about it only",
});

interface Spec {
  id: string;
  from: string;
  to: string[];
  ctx: string;
  round: number;
  kind: AgentMessage["kind"];
  /** Recorded time (s from T0) and the call's latency (s). */
  s: number;
  lat: number;
  state?: AgentMessage["state"];
}

const message = (m: Spec): AgentMessage => ({
  messageId: m.id,
  contextId: m.ctx,
  taskId: `s9-${m.ctx}`,
  stage: m.round === 4 ? "S10" : "S9",
  round: m.round,
  kind: m.kind,
  role: "agent",
  from: m.from,
  to: m.to,
  state: m.state ?? "completed",
  text: `Placeholder ${m.kind} from ${m.from}. Second sentence.`,
  reasoning: "",
  citations: m.kind === "strategy" ? [{ claimId: "c1", code: "C1", text: "claim" }] : [],
  dropped: m.kind === "strategy" ? 1 : 0,
  usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.002, latencyMs: Math.round(m.lat * 1000), model: "gemini-flash", free: false },
  data: {},
});

const STRATEGY: Record<string, number> = { cgi: 42.1, akumen: 54.0, zen: 90.5, deloitte: 58.6 };
const CHALLENGE: Record<string, [number, number]> = { cgi: [87.0, 22.3], akumen: [94.8, 18.5], deloitte: [98.2, 18.8], zen: [121.4, 16.0] };
const RESPONSE: Record<string, number> = { cgi: 132.0, akumen: 139.5, deloitte: 146.2, zen: 158.3 };

export interface TimedOptions {
  /** Mark the Akumen challenge failed, and add a rejected interview. */
  faults?: boolean;
  /** Stop the record at this many seconds from T0 (an interrupted or in-progress run). */
  until?: number;
  /** Rivals to include (default all four). */
  rivals?: number;
}

/** The swarm view of the fixture run. */
export function timedSwarm(opts: TimedOptions = {}): SwarmView {
  let seq = 0;
  const envs: RunEventEnvelope[] = [];
  const push = (s: number, activityType: string, content: unknown) => {
    if (opts.until !== undefined && s > opts.until) return;
    seq += 1;
    const event = parseEvent({ type: "ACTIVITY_SNAPSHOT", messageId: `x${seq}`, activityType, content });
    if (!event) throw new Error(`off contract: ${activityType}`);
    envs.push({ seq, runId: "966d27c7", idemKey: `k${seq}`, ts: at(s), event });
  };
  const rivals = RIVALS.slice(0, opts.rivals ?? RIVALS.length);
  push(-10.6, "agent_card", card("red_team", "red_team", "red_team", "Red team", "Red team"));
  push(-10.6, "agent_card", card("analyst", "analyst", "analyst", "Home team", "Home analyst"));
  for (const r of rivals) for (const role of ["capture_lead", "pricing", "technical", "past_performance"]) push(-10.5, "agent_card", card(`${r.id}.${role}`, r.id, role, r.label));
  const specs: Spec[] = [];
  rivals.forEach((r, i) => {
    ["pricing", "technical", "past_performance"].forEach((role, j) => specs.push({ id: `${r.id}-b${j}`, from: `${r.id}.${role}`, to: [`${r.id}.capture_lead`], ctx: r.id, round: 1, kind: "brief", s: 4 + i * 2.5 + j, lat: 13 + j + i * 2.5 }));
    specs.push({ id: `${r.id}-s`, from: `${r.id}.capture_lead`, to: ["red_team"], ctx: r.id, round: 1, kind: "strategy", s: STRATEGY[r.id] ?? 60, lat: 24 });
    const [cs, cl] = CHALLENGE[r.id] ?? [100, 15];
    specs.push({ id: `${r.id}-c`, from: "red_team", to: [`${r.id}.capture_lead`], ctx: r.id, round: 2, kind: "challenge", s: cs, lat: cl, ...(opts.faults && r.id === "akumen" ? { state: "failed" as const } : {}) });
    specs.push({ id: `${r.id}-r`, from: `${r.id}.capture_lead`, to: ["board", "red_team"], ctx: r.id, round: 3, kind: "response", s: RESPONSE[r.id] ?? 150, lat: 20 });
  });
  if (opts.faults) specs.push({ id: "cgi-i", from: "cgi.capture_lead", to: ["analyst"], ctx: "cgi", round: 3, kind: "interview", s: 133.0, lat: 0, state: "rejected" });
  for (const s of specs.sort((a, b) => a.s - b.s)) push(s.s, "agent_message", message(s));
  if (rivals.length === RIVALS.length) {
    for (const m of ["technical", "management", "past_performance"]) push(164.0, "agent_card", card(`board.${m}`, "board", "evaluator", "Board", `Evaluator, ${m.replace("_", " ")}`));
    ["technical", "management", "past_performance"].forEach((m, i) =>
      push(178 + i, "agent_message", message({ id: `v-${m}`, from: `board.${m}`, to: ["board"], ctx: "board", round: 4, kind: "rating", s: 178 + i, lat: 12 + i })),
    );
    push(186.0, "board_result", {
      label: "simulated, not a forecast",
      members: 3,
      runs: 30,
      rows: rivals.map((r, i) => ({ group: r.id, label: r.label, code: String.fromCharCode(65 + i), incumbent: r.id === "cgi", share: [0.86, 0.06, 0.04, 0.04][i] ?? 0, ratings: { technical: 4 } })),
      notes: [],
      budget: { capUsd: 5, spentUsd: 1, calls: 30, maxCalls: 60, agents: 21, messages: 31 },
    });
  }
  return foldSwarm(envs);
}

/** The rival pods of the fixture, as `rivalPods` gives them for a record without research lanes. */
export const timedPods = (n = RIVALS.length) => RIVALS.slice(0, n).map((r, i) => ({ key: r.label.toUpperCase(), label: r.label, groupId: r.id, team: i }));
