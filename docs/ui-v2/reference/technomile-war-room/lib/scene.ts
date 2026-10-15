/**
 * The scene at the cursor: what the office styles may know at a display time, derived only from events recorded by
 * then. A rival is known from the frame that first named its lane (the approved plan's snapshot, or its first
 * fetch); an agent from its recorded card; a model endpoint from its first call's start. Every name, count, label
 * and filter an office style shows about rivals, agents or endpoints reads from this, never from the whole run.
 */
import type { OfficeRecord } from "./office";
import type { SwarmView } from "./swarm";

export interface SceneInput {
  record: OfficeRecord;
  view: SwarmView;
  /** Model calls on the display clock (endpoint and start), in any order. */
  calls?: readonly { endpoint: string; start: number }[];
  /** Recorded time to display time. */
  clockAt: (ts: number) => number;
  /** History boundary: a frame at or before it is in place from the start. */
  settledSeq: number;
}

export interface Scene {
  t: number;
  /** Rival pod keys named by `t`, in the order they were named. */
  rivals: string[];
  /** Agent ids whose cards are recorded by `t`, in recorded order. */
  agents: string[];
  /** Model endpoints whose first call started by `t`, in first-start order. */
  endpoints: string[];
  hasRival: (key: string) => boolean;
  hasAgent: (agentId: string) => boolean;
  /** How many agents of a group (swarm group id) have their cards recorded by `t`. */
  groupSize: (groupId: string) => number;
}

export function sceneAt(input: SceneInput, t: number): Scene {
  const { record, view, clockAt, settledSeq } = input;
  const shown = (seq: number, ts: number) => (seq <= settledSeq ? -Infinity : clockAt(ts));

  const rivals = record.lanes
    .map((l) => ({ key: l.key, at: shown(l.seq, l.ts), seq: l.seq }))
    .filter((l) => l.at <= t)
    .sort((a, b) => a.seq - b.seq)
    .map((l) => l.key);

  const agents = Object.entries(view.cardSeen)
    .map(([id, r]) => ({ id, seq: r.seq, at: shown(r.seq, Date.parse(r.ts)) }))
    .filter((a) => a.at <= t && view.cards[a.id] !== undefined)
    .sort((a, b) => a.seq - b.seq)
    .map((a) => a.id);

  const endpoints: string[] = [];
  for (const c of [...(input.calls ?? [])].sort((a, b) => a.start - b.start)) {
    if (c.start > t) break;
    if (!endpoints.includes(c.endpoint)) endpoints.push(c.endpoint);
  }

  const rivalSet = new Set(rivals);
  const agentSet = new Set(agents);
  const groups = new Map<string, number>();
  for (const id of agents) {
    const g = view.cards[id]?.group;
    if (g) groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  return {
    t,
    rivals,
    agents,
    endpoints,
    hasRival: (key) => rivalSet.has(key),
    hasAgent: (agentId) => agentSet.has(agentId),
    groupSize: (groupId) => groups.get(groupId) ?? 0,
  };
}

/** Whether a seat may show anything at the frame: seats off the rival floors always; a rival's seat (its
 *  researcher, crew and capture lead) only once that rival is named. */
export function seatKnown(seat: { pod: string | null }, scene: Pick<Scene, "hasRival">): boolean {
  return seat.pod === null || scene.hasRival(seat.pod);
}

/** Whether an open hover or focus card may stay up at the frame: only while the agent and the rival it names are
 *  still known (a seek backward past their arrival closes it). */
export function stillKnown(ref: { agentId?: string | null; rival?: string | null }, scene: Pick<Scene, "hasAgent" | "hasRival">): boolean {
  return (!ref.agentId || scene.hasAgent(ref.agentId)) && (!ref.rival || scene.hasRival(ref.rival));
}

/** Whether the office has a scene to draw: Classic needs research lanes or agent cards; the other styles also draw
 *  the early stages and the gates, from the run's first stage edge. */
export function officeHasScene(classic: boolean, record: Pick<OfficeRecord, "lanes" | "stages">, hasCards: boolean): boolean {
  return record.lanes.length > 0 || hasCards || (!classic && record.stages.length > 0);
}
