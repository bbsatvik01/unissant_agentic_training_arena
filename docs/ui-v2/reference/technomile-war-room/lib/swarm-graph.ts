/**
 * The swarm's thread filters and counts, shared by the agent graph (components/war-room/swarm-graph-view.tsx, laid
 * out by swarm-net.ts), the agent office and the Pipeline's step canvas. Pure functions of a SwarmView.
 */
import { targets } from "./swarm-net";
import type { SwarmItem, SwarmView } from "./swarm";

/** Who a message reaches: named agents as they are, a group id (a broadcast, e.g. "board") as every agent of that
 *  group; never the sender itself, and ids with no card yet are dropped. */
export function recipients(view: SwarmView, m: Pick<SwarmItem, "from" | "to">): string[] {
  const out = new Set<string>();
  for (const t of m.to) {
    if (view.cards[t]) out.add(t);
    else for (const a of view.groups.find((g) => g.id === t)?.agents ?? []) out.add(a.agentId);
  }
  out.delete(m.from);
  return [...out];
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

/**
 * The thread filter the graph and the filter bar share, as one string: "all", a context id (a rival team or
 * "board"), "agent:<id>" (everything an agent sent or received) or "edge:<a~b>" (the messages on one edge).
 */
export type Focus = string;

export function filterThread(view: SwarmView, items: readonly SwarmItem[], focus: Focus): SwarmItem[] {
  if (focus === "all") return [...items];
  if (focus.startsWith("agent:")) {
    const id = focus.slice(6);
    return items.filter((m) => m.from === id || recipients(view, m).includes(id));
  }
  if (focus.startsWith("edge:")) {
    const key = focus.slice(5);
    // an edge joins two agents, or an agent and a group's anchor ("anchor:board") on the network
    // ... or, in the compact layout, two whole teams ("team:<group>")
    return items.filter((m) => {
      const froms = [m.from, ...teamOf(view, m.from)];
      const tos = [...recipients(view, m), ...targets(view, m)].flatMap((r) => [r, ...teamOf(view, r)]);
      return froms.some((f) => tos.some((r) => r !== f && edgeKey(f, r) === key));
    });
  }
  return items.filter((m) => m.contextId === focus);
}

/** The compact layout's team node for a rival agent or a rival group's anchor (none for the hubs). */
function teamOf(view: SwarmView, id: string): string[] {
  const group = id.startsWith("anchor:") ? id.slice(7) : view.cards[id]?.group;
  return group && view.groups.some((g) => g.id === group && g.kind === "rival") ? [`team:${group}`] : [];
}

/** Whether a network node (an agent, a team disc or an anchor, with its group) is inside the focus (others dim). */
export function inFocus(focus: Focus, node: { id: string; groupId: string }): boolean {
  if (focus === "all") return true;
  if (focus.startsWith("agent:")) return node.id === focus.slice(6);
  if (focus.startsWith("edge:")) return focus.slice(5).split("~").includes(node.id);
  return node.groupId === focus;
}

export interface NodeStats {
  sent: number;
  received: number;
  inputTokens: number;
  outputTokens: number;
}

export function nodeStats(view: SwarmView, messages: readonly SwarmItem[] = view.messages): Record<string, NodeStats> {
  const out: Record<string, NodeStats> = {};
  const get = (id: string) => (out[id] ??= { sent: 0, received: 0, inputTokens: 0, outputTokens: 0 });
  for (const m of messages) {
    const s = get(m.from);
    s.sent += 1;
    s.inputTokens += m.usage.inputTokens;
    s.outputTokens += m.usage.outputTokens;
    for (const r of recipients(view, m)) get(r).received += 1;
  }
  return out;
}

/** The order a recorded conversation replays in: by ledger sequence, ties by message id. */
export function replayOrder(messages: readonly SwarmItem[]): SwarmItem[] {
  return [...messages].sort((a, b) => a.seq - b.seq || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
}

/** The latest round reached by the first `k` replayed messages (0 before the first). */
export function roundAt(ordered: readonly SwarmItem[], k: number): number {
  let r = 0;
  for (const m of ordered.slice(0, Math.max(0, k))) r = Math.max(r, m.round);
  return r;
}

/** A message's first words (the office's speech bubbles). */
export function firstWords(text: string, n = 9): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= n ? words.join(" ") : `${words.slice(0, n).join(" ")}...`;
}

export const ROUND_SHORT: Record<number, string> = { 1: "Briefs and strategy", 2: "Red-team challenge", 3: "Response and interview", 4: "Board scoring" };
