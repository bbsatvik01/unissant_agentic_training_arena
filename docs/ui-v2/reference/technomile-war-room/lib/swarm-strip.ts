/**
 * The time strip under the agent graph: one lane per rival (pod order), then the red team, the home analyst and the
 * board, on a linear scale of recorded time. Every call is a bar from `ts - latencyMs` to `ts`; every message is a
 * tick at its recorded time with a connector to each target lane. Pure functions of the recorded model.
 */
import { formatSince, type SwarmModel } from "./swarm-time";
import type { NetLayout } from "./swarm-net";
import type { AgentMessage, AgentTaskState } from "@/lib/contracts/run-events";

export interface StripLane {
  id: string;
  label: string;
  /** Rival team colour index; -1 for the hubs. */
  team: number;
  kind: "rival" | "red_team" | "analyst" | "board";
}

export interface StripBar {
  messageId: string;
  lane: string;
  /** Sub-row inside the lane (concurrent calls stack). */
  row: number;
  start: number;
  end: number;
  team: number;
}

export interface StripTick {
  messageId: string;
  lane: string;
  ts: number;
  targets: string[];
  team: number;
  state: AgentTaskState;
  kind: AgentMessage["kind"];
  dropped: number;
}

export interface Strip {
  lanes: StripLane[];
  bars: StripBar[];
  ticks: StripTick[];
  /** Sub-rows per lane. */
  rows: Record<string, number>;
  /** The window, recorded ms: the S9 origin minus 1 s to the last change plus 3 s. */
  from: number;
  to: number;
  /** Each round's first message. */
  rounds: { round: number; ts: number }[];
}

/** The lane a drawn node or anchor belongs to (null when it has none). */
export function laneOf(layout: NetLayout, node: string): string | null {
  if (node.startsWith("anchor:")) return node.slice(7);
  if (node.startsWith("team:")) return node.slice(5);
  const a = layout.byId[node];
  if (!a) return null;
  return a.kind === "rival" ? a.groupId : a.kind;
}

/** Interval sub-rows: each bar takes the first row whose previous bar has ended. */
function stack(bars: Omit<StripBar, "row">[]): { bars: StripBar[]; rows: number } {
  const ends: number[] = [];
  const out = [...bars]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((b) => {
      let row = ends.findIndex((e) => e <= b.start);
      if (row < 0) row = ends.length;
      ends[row] = b.end;
      return { ...b, row };
    });
  return { bars: out, rows: Math.max(1, ends.length) };
}

/** The strip of a recorded (never retimed) model. */
export function buildStrip(model: SwarmModel, layout: NetLayout): Strip {
  const lanes: StripLane[] = layout.pods.filter((p) => p.groupId !== null).map((p) => ({ id: p.groupId ?? "", label: p.label, team: p.team, kind: "rival" as const }));
  lanes.push({ id: "red_team", label: "Red team", team: -1, kind: "red_team" }, { id: "analyst", label: "Home analyst", team: -1, kind: "analyst" }, { id: "board", label: "Board", team: -1, kind: "board" });
  const known = new Set(lanes.map((l) => l.id));
  const raw = new Map<string, Omit<StripBar, "row">[]>();
  const ticks: StripTick[] = [];
  for (const m of model.messages) {
    const lane = laneOf(layout, m.from);
    if (!lane || !known.has(lane)) continue;
    const team = model.nodeKind[m.from] === "red_team" ? m.threadTeam : m.team;
    if (m.latencyMs > 0 && m.state !== "rejected") {
      const list = raw.get(lane) ?? [];
      list.push({ messageId: m.id, lane, start: m.recorded - m.latencyMs, end: m.recorded, team });
      raw.set(lane, list);
    }
    const targets = [...new Set(m.targets.map((t) => laneOf(layout, t)).filter((l): l is string => l !== null && l !== lane && known.has(l)))];
    ticks.push({ messageId: m.id, lane, ts: m.recorded, targets, team, state: m.state, kind: m.kind, dropped: m.item.dropped });
  }
  const bars: StripBar[] = [];
  const rows: Record<string, number> = {};
  for (const l of lanes) {
    const s = stack(raw.get(l.id) ?? []);
    bars.push(...s.bars);
    rows[l.id] = s.rows;
  }
  ticks.sort((a, b) => a.ts - b.ts);
  // the window closes after the last message or the board's result, whichever is later
  const last = Math.max(model.origin, ...ticks.map((t) => t.ts), Number.isFinite(model.boardSeen) ? model.boardSeen : -Infinity);
  return { lanes, bars, ticks, rows, from: model.origin - 1000, to: last + 3000, rounds: roundStarts(model) };
}

function roundStarts(model: SwarmModel): { round: number; ts: number }[] {
  const first = new Map<number, number>();
  for (const m of model.messages) if (!first.has(m.round) || (first.get(m.round) ?? Infinity) > m.recorded) first.set(m.round, m.recorded);
  return [...first.entries()].map(([round, ts]) => ({ round, ts })).sort((a, b) => a.ts - b.ts);
}

/** Pixel positions nudged apart so marks closer than `gap` stay distinguishable; each moves at most `gap`. Order kept. */
export function nudge(xs: readonly number[], gap = 3): number[] {
  const out: number[] = [];
  for (const [i, x] of xs.entries()) {
    const prev = out[i - 1];
    out.push(prev !== undefined && x - prev < gap ? Math.min(x + gap, prev + gap) : x);
  }
  return out;
}

/** The tick nearest to `ts` (null when there are none). */
export function nearestTick(ticks: readonly StripTick[], ts: number): StripTick | null {
  let best: StripTick | null = null;
  for (const t of ticks) if (!best || Math.abs(t.ts - ts) < Math.abs(best.ts - ts)) best = t;
  return best;
}

/** The previous or next tick from `ts` (null at the ends). */
export function stepTick(ticks: readonly StripTick[], ts: number, dir: 1 | -1): StripTick | null {
  if (dir > 0) return ticks.find((t) => t.ts > ts + 1) ?? null;
  return [...ticks].reverse().find((t) => t.ts < ts - 1) ?? null;
}

/** The slider's spoken value: time since S9 and the round reached. */
export function sliderText(strip: Strip, origin: number, t: number): string {
  const round = strip.rounds.filter((r) => r.ts <= t).at(-1)?.round ?? 0;
  return `${formatSince(t - origin)}, ${round === 0 ? "before the first message" : round === 4 ? "board" : `round ${round}`}`;
}
