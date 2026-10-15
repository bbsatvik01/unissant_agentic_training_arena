import { describe, expect, it } from "vitest";

import type { AgentCard, AgentMessage, RunEventEnvelope } from "@/lib/contracts/run-events";
import { parseEvent } from "@/lib/contracts/run-events";

import { foldSwarm, type SwarmItem } from "./swarm";
import { edgeKey, filterThread, firstWords, inFocus, nodeStats, recipients, replayOrder, roundAt } from "./swarm-graph";
import { layoutNetwork } from "./swarm-net";

const card = (agentId: string, group: string, role: string, groupLabel = group.toUpperCase()): AgentCard => ({
  agentId,
  name: `${role} ${groupLabel}`,
  role,
  group,
  groupLabel,
  stage: "S9",
  skills: [],
  reads: "accepted claims about it only",
});

const usage = { inputTokens: 1000, outputTokens: 200, costUsd: 0, latencyMs: 900, model: "m", free: true };

const msg = (messageId: string, from: string, to: string[], contextId: string, round = 1, kind: AgentMessage["kind"] = "brief"): AgentMessage => ({
  messageId,
  contextId,
  taskId: `s9-${contextId}`,
  stage: "S9",
  round,
  kind,
  role: "agent",
  from,
  to,
  state: "completed",
  text: `${from} says hello to ${to.join(" and ")}`,
  reasoning: "",
  citations: [],
  dropped: 0,
  usage,
  data: {},
});

let seq = 0;
const env = (activityType: string, content: unknown): RunEventEnvelope => {
  seq += 1;
  const event = parseEvent({ type: "ACTIVITY_SNAPSHOT", messageId: `x${seq}`, activityType, content });
  if (!event) throw new Error(`off contract: ${activityType}`);
  return { seq, runId: "r", idemKey: `k${seq}`, ts: "2026-10-03T12:00:00Z", event };
};

const ROLES = ["capture_lead", "pricing", "technical", "past_performance"];
const team = (g: string) => ROLES.map((r) => env("agent_card", card(`${g}.${r}`, g, r)));

/** The shape of recorded run 966d27c7: four rivals, red team, analyst, then the three-member board at S10. */
function swarm(rivals = ["cgi", "akumen", "zen", "deloitte"], withBoard = true) {
  seq = 0;
  const envs: RunEventEnvelope[] = [env("agent_card", card("red_team", "red_team", "red_team", "Red team")), env("agent_card", card("analyst", "analyst", "analyst", "Home team"))];
  for (const g of rivals) envs.push(...team(g));
  const [a] = rivals as [string];
  envs.push(
    env("agent_message", msg("b1", `${a}.pricing`, [`${a}.capture_lead`], a)),
    env("agent_message", msg("b2", `${a}.technical`, [`${a}.capture_lead`], a)),
    env("agent_message", msg("s1", `${a}.capture_lead`, ["red_team"], a, 1, "strategy")),
    env("agent_message", msg("c1", "red_team", [`${a}.capture_lead`], a, 2, "challenge")),
    env("agent_message", msg("r1", `${a}.capture_lead`, ["board", "red_team"], a, 3, "response")),
    env("agent_message", msg("i1", `${a}.capture_lead`, ["analyst"], a, 3, "interview")),
  );
  if (withBoard) {
    for (const m of ["technical", "management", "past_performance"]) envs.push(env("agent_card", { ...card(`board.${m}`, "board", "evaluator", "Board"), stage: "S10" }));
    envs.push(env("agent_message", msg("v1", "board.technical", ["board"], "board", 4, "rating")));
  }
  return foldSwarm(envs);
}

describe("recipients", () => {
  it("expands a broadcast to its group's members, drops the sender and ids without a card", () => {
    const view = swarm();
    expect(recipients(view, { from: "cgi.capture_lead", to: ["board", "red_team"] })).toEqual(["board.technical", "board.management", "board.past_performance", "red_team"]);
    expect(recipients(view, { from: "board.technical", to: ["board"] })).toEqual(["board.management", "board.past_performance"]);
    expect(recipients(view, { from: "red_team", to: ["nobody"] })).toEqual([]);
  });

});

describe("filterThread and inFocus", () => {
  const view = swarm();
  const ids = (items: SwarmItem[]) => items.map((m) => m.messageId);

  it("filters by context, agent and edge", () => {
    expect(ids(filterThread(view, view.messages, "all"))).toEqual(ids(view.messages));
    expect(ids(filterThread(view, view.messages, "board"))).toEqual(["v1"]);
    expect(ids(filterThread(view, view.messages, "agent:red_team"))).toEqual(["s1", "c1", "r1"]);
    expect(ids(filterThread(view, view.messages, "agent:board.management"))).toEqual(["r1", "v1"]);
    expect(ids(filterThread(view, view.messages, `edge:${edgeKey("red_team", "cgi.capture_lead")}`))).toEqual(["s1", "c1", "r1"]);
    expect(ids(filterThread(view, view.messages, `edge:${edgeKey("cgi.capture_lead", "anchor:board")}`))).toEqual(["r1"]);
    // the compact layout's team nodes
    expect(ids(filterThread(view, view.messages, `edge:${edgeKey("team:cgi", "red_team")}`))).toEqual(["s1", "c1", "r1"]);
    expect(ids(filterThread(view, view.messages, `edge:${edgeKey("team:cgi", "anchor:board")}`))).toEqual(["r1"]);
  });

  it("dims nodes outside the focus", () => {
    const { byId } = layoutNetwork(view, []);
    const red = byId.red_team!;
    const lead = byId["cgi.capture_lead"]!;
    expect(inFocus("all", red)).toBe(true);
    expect(inFocus("cgi", lead)).toBe(true);
    expect(inFocus("cgi", red)).toBe(false);
    expect(inFocus("agent:red_team", red)).toBe(true);
    expect(inFocus("agent:red_team", lead)).toBe(false);
    expect(inFocus(`edge:${edgeKey("red_team", "cgi.capture_lead")}`, lead)).toBe(true);
    expect(inFocus(`edge:${edgeKey("red_team", "analyst")}`, lead)).toBe(false);
  });
});

describe("nodeStats", () => {
  it("counts sent and received messages and the sender's tokens", () => {
    const view = swarm();
    const s = nodeStats(view);
    expect(s["cgi.capture_lead"]).toEqual({ sent: 3, received: 3, inputTokens: 3000, outputTokens: 600 });
    expect(s.analyst).toEqual({ sent: 0, received: 1, inputTokens: 0, outputTokens: 0 });
    expect(nodeStats(view, [])).toEqual({});
  });
});

describe("replay", () => {
  const view = swarm();

  it("replays in ledger order whatever order the messages arrive in, ties by message id", () => {
    const shuffled = [...view.messages].reverse();
    expect(replayOrder(shuffled).map((m) => m.messageId)).toEqual(view.messages.map((m) => m.messageId));
    const [a, b] = view.messages as [SwarmItem, SwarmItem];
    const tie = [{ ...b, seq: 1, messageId: "z" }, { ...a, seq: 1, messageId: "y" }, { ...a, seq: 1, messageId: "y" }];
    expect(replayOrder(tie).map((m) => m.messageId)).toEqual(["y", "y", "z"]);
  });

  it("reports the round each replay position has reached", () => {
    const ordered = replayOrder(view.messages);
    expect(roundAt(ordered, 0)).toBe(0);
    expect(roundAt(ordered, -2)).toBe(0);
    expect(roundAt(ordered, 3)).toBe(1);
    expect(roundAt(ordered, 4)).toBe(2);
    expect(roundAt(ordered, ordered.length)).toBe(4);
  });

  it("shows a message's first words in its speech bubble", () => {
    expect(firstWords("  Bid as prime. ")).toBe("Bid as prime.");
    expect(firstWords("one two three four five", 3)).toBe("one two three...");
  });
});
