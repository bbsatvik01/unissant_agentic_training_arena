import { describe, expect, it } from "vitest";

import type { AgentCard, AgentMessage, BoardResult, RunEventEnvelope } from "@/lib/contracts/run-events";
import { isAgentCard, isAgentMessage, isBoardResult, parseEvent } from "@/lib/contracts/run-events";

import { emptyStore, reduceAll } from "./state";
import { agentName, finalPosition, foldSwarm, formatUsd, interviewOf, PARKED_POLL_MS, parseSwarmBody, shortName, SWARM_POLL_MS, swarmPollDelay } from "./swarm";

const card = (agentId: string, group: string, role = "capture_lead", groupLabel = group.toUpperCase()): AgentCard => ({
  agentId,
  name: `${role} ${groupLabel}`,
  role,
  group,
  groupLabel,
  stage: "S9",
  skills: ["bid strategy"],
  reads: "accepted claims about it only",
});

const usage = { inputTokens: 900, outputTokens: 120, costUsd: 0, latencyMs: 2100, model: "gpt-oss-120b", free: true };

const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  messageId: "m",
  contextId: "caci",
  taskId: "s9-caci",
  stage: "S9",
  round: 1,
  kind: "strategy",
  role: "agent",
  from: "caci.capture_lead",
  to: ["red_team"],
  state: "completed",
  text: "Bid: bid_as_prime.",
  reasoning: "It holds the current work.",
  citations: [{ code: "E1", claimId: "c1", text: "CACI holds the order." }],
  dropped: 0,
  usage,
  data: {},
  ...over,
});

const board: BoardResult = {
  label: "simulated board, not a forecast",
  members: 3,
  runs: 9,
  rows: [{ group: "caci", label: "CACI", code: "B", incumbent: true, share: 0.6, ratings: { technical: 4 } }],
  notes: [],
  budget: { capUsd: 0.3, spentUsd: 0.01, calls: 38, maxCalls: 80, agents: 25, messages: 38 },
};

let seq = 0;
const env = (activityType: string, content: unknown): RunEventEnvelope => {
  seq += 1;
  const event = parseEvent({ type: "ACTIVITY_SNAPSHOT", messageId: `x${seq}`, activityType, content });
  if (!event) throw new Error(`off contract: ${activityType}`);
  return { seq, runId: "r", idemKey: `k${seq}`, ts: "2026-10-03T12:00:00Z", event };
};

describe("agent activity contract", () => {
  it("accepts the swarm's cards, messages and board result", () => {
    expect(isAgentCard(card("a", "caci"))).toBe(true);
    expect(isAgentMessage(msg({}))).toBe(true);
    expect(isBoardResult(board)).toBe(true);
  });

  it("refuses an off-contract message, card or board", () => {
    expect(isAgentMessage(msg({ kind: "gossip" as AgentMessage["kind"] }))).toBe(false);
    expect(isAgentMessage(msg({ role: "user" as "agent" }))).toBe(false);
    expect(isAgentMessage(msg({ state: "working" as AgentMessage["state"] }))).toBe(false);
    expect(isAgentMessage(msg({ usage: { ...usage, free: "yes" as unknown as boolean } }))).toBe(false);
    expect(isAgentMessage(msg({ citations: [{ code: "E1" } as AgentMessage["citations"][number]] }))).toBe(false);
    expect(isAgentMessage(msg({ round: 1.5 }))).toBe(false);
    expect(isAgentCard({ ...card("a", "caci"), stage: "nine" })).toBe(false);
    expect(isBoardResult({ ...board, budget: { ...board.budget, calls: -1 } })).toBe(false);
    expect(isBoardResult({ ...board, rows: [{ ...board.rows[0], incumbent: "yes" }] })).toBe(false);
    expect(parseEvent({ type: "ACTIVITY_SNAPSHOT", messageId: "m", activityType: "agent_message", content: { text: "x" } })).toBeNull();
  });

  it("keeps agent activity out of the War Room ticker (the swarm panel renders it)", () => {
    const s = reduceAll(emptyStore(), [env("agent_card", card("a", "caci")), env("agent_message", msg({}))]);
    expect(s.feed).toEqual([]);
    expect(s.unrendered).toBe(0);
  });
});

describe("foldSwarm", () => {
  const envs = [
    env("agent_card", card("board.technical", "board", "evaluator", "Evaluation board")),
    env("agent_card", card("red_team", "red_team", "red_team", "Red team")),
    env("agent_card", card("caci.capture_lead", "caci")),
    env("agent_card", card("caci.pricing", "caci", "pricing")),
    env("agent_card", card("bae.capture_lead", "bae")),
    env("agent_message", msg({ messageId: "s1", kind: "strategy" })),
    env("agent_message", msg({ messageId: "c1", kind: "challenge", round: 2, from: "red_team", to: ["caci.capture_lead"], usage: { ...usage, free: false, costUsd: 0.002 } })),
    env("agent_message", msg({ messageId: "r1", kind: "response", round: 3, to: ["board", "red_team"] })),
    env("agent_message", msg({ messageId: "f1", contextId: "bae", from: "bae.capture_lead", state: "failed", text: "Model call failed." })),
    env("agent_message", msg({ messageId: "x1", contextId: "bae", from: "bae.capture_lead", kind: "interview", state: "rejected" })),
    env("board_result", board),
  ];

  it("groups the agents (rivals first, in arrival order) and orders the thread by seq", () => {
    const view = foldSwarm([...envs].reverse());
    expect(view.groups.map((g) => g.id)).toEqual(["caci", "bae", "red_team", "board"]);
    expect(view.groups[0]?.agents.map((a) => a.role)).toEqual(["capture_lead", "pricing"]);
    expect(view.messages.map((m) => m.messageId)).toEqual(["s1", "c1", "r1", "f1", "x1"]);
    expect(view.board?.rows[0]?.code).toBe("B");
  });

  it("totals tokens, spend, free-tier calls and failures", () => {
    const t = foldSwarm(envs).totals;
    expect(t).toMatchObject({ agents: 5, messages: 5, rounds: [1, 2, 3], free: 4, failed: 1, rejected: 1, inputTokens: 4500 });
    expect(t.costUsd).toBeCloseTo(0.002);
  });

  it("names agents and the board, and finds a rival's final position", () => {
    const view = foldSwarm(envs);
    expect(agentName(view, "board")).toBe("Evaluation board");
    expect(agentName(view, "red_team")).toBe("red_team Red team");
    expect(agentName(view, "nobody")).toBe("nobody");
    expect(finalPosition(view, "caci")?.messageId).toBe("r1");
    expect(finalPosition(view, "bae")).toBeNull();
  });

  it("dedupes a message recorded twice (the latest frame wins)", () => {
    const again = env("agent_message", msg({ messageId: "s1", text: "revised" }));
    const view = foldSwarm([...envs, again]);
    expect(view.messages.filter((m) => m.messageId === "s1")).toHaveLength(1);
    expect(view.messages.at(-1)?.text).toBe("revised");
  });
});

describe("parseSwarmBody and interviewOf", () => {
  it("keeps only contract frames from bh-api's body", () => {
    const good = envs0();
    const body = { status: "running", events: [good, { ...good, seq: "2" }, { ...good, event: { type: "NOPE" } }, null, 7] };
    const out = parseSwarmBody(body);
    expect(out.status).toBe("running");
    expect(out.envelopes).toHaveLength(1);
    expect(parseSwarmBody(null)).toEqual({ status: "", envelopes: [] });
    expect(parseSwarmBody({ events: "x", status: 3 })).toEqual({ status: "", envelopes: [] });
  });

  it("reads the interview turns from the data part and drops malformed ones", () => {
    const m = msg({
      kind: "interview",
      data: {
        interview: [
          { question: "Will you bid?", statements: [{ text: "We bid as prime", codes: ["E1"] }, { text: 3 }], withheld: 0 },
          { question: "Weakest?", statements: [], withheld: 1 },
          { question: 4 },
          null,
        ],
      },
    });
    expect(interviewOf(m)).toEqual([
      { question: "Will you bid?", statements: [{ text: "We bid as prime", codes: ["E1"] }], withheld: 0 },
      { question: "Weakest?", statements: [], withheld: 1 },
    ]);
    expect(interviewOf(msg({}))).toEqual([]);
    expect(interviewOf(null)).toEqual([]);
  });

  it("shortens a rival's name to its first two words", () => {
    expect(shortName("DELOITTE & TOUCHE LLP")).toBe("DELOITTE TOUCHE");
    expect(shortName("AKUMEN, INC.")).toBe("AKUMEN INC");
    expect(shortName("CGI")).toBe("CGI");
  });

  it("formats spend", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.25)).toBe("$0.25");
  });
});

describe("swarmPollDelay", () => {
  it("follows a running run closely, a run waiting at a gate slowly (so a resume is noticed), an ended run never", () => {
    // running -> parked at H1 -> approved elsewhere and running again: the panel keeps reading through the gate
    expect(swarmPollDelay("running")).toBe(SWARM_POLL_MS);
    expect(swarmPollDelay("awaiting_plan_approval")).toBe(PARKED_POLL_MS);
    expect(swarmPollDelay("awaiting_decision")).toBe(PARKED_POLL_MS);
    expect(swarmPollDelay("awaiting_review")).toBe(PARKED_POLL_MS);
    expect(swarmPollDelay("interrupted")).toBe(PARKED_POLL_MS);
    expect(swarmPollDelay("decided")).toBeNull();
    expect(swarmPollDelay("failed")).toBeNull();
    expect(swarmPollDelay("")).toBeNull();
  });
});

function envs0(): Record<string, unknown> {
  return { seq: 1, runId: "r", idemKey: "k", ts: "t", event: { type: "ACTIVITY_SNAPSHOT", messageId: "m", activityType: "agent_message", content: msg({}) } };
}
