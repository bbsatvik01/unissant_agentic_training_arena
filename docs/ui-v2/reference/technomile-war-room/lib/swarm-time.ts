/**
 * The agent network over time: every frame is a pure function of one recorded instant, `swarmAt(model, t)`. `t` is
 * recorded time (ms since epoch) from one clock (the run replay, the live ledger minus a fixed lag, or the end of the
 * run), so a replay at any speed, a seek and a live run all show each message at its recorded time.
 *
 * What moves, and why: a model call is its sender "working" from `ts - latencyMs` to `ts` (clamped to the sender's
 * card); at `ts` one comet per target leaves along the edge's own curve; the target gets a landing ring; the edge heats
 * and cools. The comet's flight takes a fixed wall time (shorter at higher speeds); it is an illustration only and
 * never moves `ts`.
 */
import type { AgentMessage, AgentTaskState, BoardResult } from "@/lib/contracts/run-events";

import { edgeId, nodeOf, ROLE_LABEL, targets, type NetLayout } from "./swarm-net";
import { KIND_LABEL, shortName, type GroupKind, type SwarmItem, type SwarmView } from "./swarm";

/** A round chip seeks to the round's first message minus this lead. */
export const ROUND_LEAD_MS = 2000;
/** Wall time an edge takes to cool after its hold. */
export const HEAT_DECAY_MS = 1200;
/** Wall time of the sender's launch ripple and of a target's landing ring. */
export const LAUNCH_MS = 600;
export const LAND_MS = 500;
/** Wall time a failed message's diamond takes to fade. */
export const FAIL_FADE_MS = 1200;
/** The model's end is this far after the last recorded change (everything settled). */
export const END_PAD_MS = 950;

export interface ModelMessage {
  id: string;
  seq: number;
  /** When it is drawn: its recorded time, or (following a feed) when its comet launches. */
  ts: number;
  /** Its recorded time (captions and the strip always use this one). */
  recorded: number;
  /** When its model call is shown starting: `ts - latencyMs`, never before the sender's card. */
  start: number;
  latencyMs: number;
  /** The sender as recorded, and the node it is drawn as. */
  sender: string;
  from: string;
  /** Drawn targets (nodes or anchors), never the sender. */
  targets: string[];
  edgeKeys: string[];
  /** The sender is on the network (it has a card). */
  drawn: boolean;
  kind: AgentMessage["kind"];
  round: number;
  contextId: string;
  state: AgentTaskState;
  /** The sender's team colour index (-1 for the hubs). */
  team: number;
  /** The team of the rival thread it belongs to (a red-team challenge is tinted by its rival); -1 for the board. */
  threadTeam: number;
  /** A proposal to the board (it ticks the inbox). */
  toBoard: boolean;
  item: SwarmItem;
}

export interface ModelEdge {
  key: string;
  from: string;
  to: string;
  firstTs: number;
  messageIds: string[];
}

export interface SwarmModel {
  messages: ModelMessage[];
  byId: Record<string, ModelMessage>;
  /** Nodes on the network (agents with a card), and when each joined. */
  nodes: string[];
  nodeSeen: Record<string, number>;
  nodeKind: Record<string, GroupKind>;
  /** The rival pods by swarm group id, and when each pod's first card was recorded. */
  podSeen: Record<string, number>;
  podTeam: Record<string, number>;
  /** When the first evaluator's card was recorded (the bench convenes), and the board result. */
  benchSeen: number;
  boardSeen: number;
  board: BoardResult | null;
  /** Each round's first message, in time order. */
  roundStarts: { round: number; ts: number }[];
  /** The S9 origin: the earliest card (else the earliest call). NaN for a run with no swarm. */
  start: number;
  /** The S9 origin on the recorded clock (equal to `start` unless the model is retimed). */
  origin: number;
  /** Everything settled: the last recorded change plus a short pad. */
  end: number;
  edges: Record<string, ModelEdge>;
  rivals: number;
}

const parse = (ts: string) => Date.parse(ts);

/**
 * When to draw each recorded change, if not at its recorded time (`scheduleFeed`): a message by id, a card by agent
 * id, and the board result. Anything it does not name keeps its recorded time.
 */
export interface Retime {
  messages: Record<string, number>;
  cards: Record<string, number>;
  board: number | null;
}

/** The model a run's swarm view and network layout give; build it once per view. */
export function buildModel(view: SwarmView, layout: NetLayout, retime?: Retime): SwarmModel {
  const nodeSeen: Record<string, number> = {};
  const nodeKind: Record<string, GroupKind> = {};
  const cardSeen: Record<string, number> = {};
  const podSeen: Record<string, number> = {};
  const podTeam: Record<string, number> = {};
  for (const pod of layout.pods) if (pod.groupId) podTeam[pod.groupId] = pod.team;
  let benchSeen = Infinity;
  const origins: number[] = [];
  for (const [id, seen] of Object.entries(view.cardSeen)) {
    const recorded = parse(seen.ts);
    const card = view.cards[id];
    if (!Number.isFinite(recorded) || !card) continue;
    origins.push(recorded);
    const at = retime?.cards[id] ?? recorded;
    cardSeen[id] = at;
    const node = nodeOf(layout, id);
    if (layout.byId[node]) {
      nodeSeen[node] = Math.min(nodeSeen[node] ?? Infinity, at);
      nodeKind[node] = layout.byId[node]?.kind ?? "rival";
    }
    if (podTeam[card.group] !== undefined) podSeen[card.group] = Math.min(podSeen[card.group] ?? Infinity, at);
    if (card.group === "board") benchSeen = Math.min(benchSeen, at);
  }

  const messages: ModelMessage[] = [];
  for (const m of view.messages) {
    const recorded = parse(m.ts);
    if (!Number.isFinite(recorded)) continue;
    const ts = retime?.messages[m.messageId] ?? recorded;
    const from = nodeOf(layout, m.from);
    const drawn = layout.byId[from] !== undefined;
    const tg: string[] = [];
    if (drawn) {
      for (const t of targets(view, m)) {
        const n = nodeOf(layout, t);
        if (n !== from && !tg.includes(n) && (layout.byId[n] || layout.anchorById[n])) tg.push(n);
      }
    }
    const lat = Math.max(0, m.usage.latencyMs);
    const seen = cardSeen[m.from];
    const sender = layout.byId[from];
    const threadTeam = podTeam[m.contextId] ?? -1;
    messages.push({
      id: m.messageId,
      seq: m.seq,
      ts,
      recorded,
      start: Math.min(ts, Math.max(ts - lat, seen ?? -Infinity)),
      latencyMs: lat,
      sender: m.from,
      from,
      targets: tg,
      edgeKeys: tg.map((t) => edgeId(from, t)),
      drawn,
      kind: m.kind,
      round: m.round,
      contextId: m.contextId,
      state: m.state,
      team: sender?.team ?? -1,
      threadTeam,
      toBoard: tg.includes("anchor:board") && sender?.kind !== "board",
      item: m,
    });
  }
  messages.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const edges: Record<string, ModelEdge> = {};
  const roundFirst = new Map<number, number>();
  for (const m of messages) {
    if (!roundFirst.has(m.round)) roundFirst.set(m.round, m.ts);
    m.edgeKeys.forEach((key, i) => {
      const e = (edges[key] ??= { key, from: m.from, to: m.targets[i] ?? "", firstTs: m.ts, messageIds: [] });
      e.messageIds.push(m.id);
    });
  }
  const roundStarts = [...roundFirst.entries()].map(([round, ts]) => ({ round, ts })).sort((a, b) => a.ts - b.ts || a.round - b.round);

  const boardSeen = view.boardSeen ? (retime?.board ?? parse(view.boardSeen.ts)) : NaN;
  const cards = Object.values(cardSeen);
  const firstCall = messages.length > 0 ? Math.min(...messages.map((m) => m.start)) : NaN;
  const start = cards.length > 0 ? Math.min(...cards) : firstCall;
  const firstRecorded = messages.length > 0 ? Math.min(...messages.map((m) => m.recorded - m.latencyMs)) : NaN;
  const origin = origins.length > 0 ? Math.min(...origins) : firstRecorded;
  const lastChange = Math.max(-Infinity, ...messages.map((m) => m.ts), ...cards, Number.isFinite(boardSeen) ? boardSeen : -Infinity);
  return {
    messages,
    byId: Object.fromEntries(messages.map((m) => [m.id, m])),
    nodes: Object.keys(nodeSeen),
    nodeSeen,
    nodeKind,
    podSeen,
    podTeam,
    benchSeen,
    boardSeen: Number.isFinite(boardSeen) ? boardSeen : Infinity,
    board: view.board,
    roundStarts,
    start,
    origin,
    end: Number.isFinite(lastChange) ? lastChange + END_PAD_MS : NaN,
    edges,
    rivals: layout.pods.length,
  };
}

/* ------------------------------------------------------------------------------------------------ timing */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Wall time of one comet's flight at a replay speed (shorter at higher speeds, never under 260 ms). */
export function flightWallMs(speed: number): number {
  return clamp(950 / Math.sqrt(Math.max(speed, 0.01)), 260, 950);
}

/** Wall time an edge stays hot after a message. */
export function heatHoldMs(speed: number): number {
  return clamp(2500 / Math.sqrt(Math.max(speed, 0.01)), 600, 2500);
}

export interface Lod {
  /** Comet tail dots. */
  tail: number;
  /** The message kind's glyph on the comet's head. */
  glyph: boolean;
  /** The sender's launch ripple (landing rings stay at every speed). */
  ripple: boolean;
}

/** Level of detail by speed: everything up to 2x; a shorter tail at 4x; no glyph or launch ripple at 8x; the comet's
 *  head only at 16x. */
export function lod(speed: number): Lod {
  if (speed <= 2) return { tail: 12, glyph: true, ripple: true };
  if (speed <= 4) return { tail: 8, glyph: true, ripple: true };
  if (speed <= 8) return { tail: 4, glyph: false, ripple: false };
  return { tail: 0, glyph: false, ripple: false };
}

export function easeInOutCubic(x: number): number {
  const v = clamp(x, 0, 1);
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
}

/* ------------------------------------------------------------------------------------------------ frames */

export type AgentStatus = "absent" | "idle" | "working" | "sending" | "receiving";

export interface Task {
  messageId: string;
  contextId: string;
  /** When the call is shown starting (live: when it became known), and when its message was recorded. */
  start: number;
  end: number;
  /** The share of the recorded call done at `t` (always against the full recorded latency). */
  progress: number;
  /** Elapsed of the recorded call at `t`, and its recorded length, in ms. */
  elapsed: number;
  latencyMs: number;
  team: number;
}

export interface AgentFrame {
  present: boolean;
  status: AgentStatus;
  tasks: Task[];
  failed: boolean;
  rejected: boolean;
  sent: number;
  received: number;
}

export interface EdgeFrame {
  count: number;
  lastTs: number;
  /** 1 while hot, falling to 0 as it cools. */
  heat: number;
  failed: boolean;
}

export interface Flight {
  messageId: string;
  edgeKey: string;
  from: string;
  to: string;
  /** Position along the edge, 0 (sender's rim) to 1 (target's rim). */
  u: number;
  kind: AgentMessage["kind"];
  failed: boolean;
  /** A failed comet's diamond: 1 when it stops, falling to 0 as it fades. */
  fade: number;
  team: number;
}

export interface Ripple {
  key: string;
  at: string;
  kind: "launch" | "land";
  /** 0..1 through the ripple. */
  p: number;
  team: number;
}

export interface PodFrame {
  present: boolean;
  count: number;
  round: number;
  result: { code: string; share: number; incumbent: boolean } | null;
}

export interface BoardFrame {
  convened: boolean;
  /** Proposals received (responses addressed to the board) and the pods that sent them. */
  proposals: number;
  from: string[];
  ratings: number;
  status: "waiting" | "scoring" | "scored";
  result: BoardResult | null;
}

export interface SwarmFrame {
  t: number;
  agents: Record<string, AgentFrame>;
  edges: Record<string, EdgeFrame>;
  flights: Flight[];
  ripples: Ripple[];
  pods: Record<string, PodFrame>;
  board: BoardFrame;
  /** The latest message recorded by `t`. */
  latest: ModelMessage | null;
  round: number;
  /** Model calls in flight (all, and the red team's). */
  inFlight: number;
  redInFlight: number;
  /** Messages recorded by `t`. */
  sent: number;
  /** Messages whose comet is in the air. */
  flying: string[];
}

export interface FrameOptions {
  speed?: number;
  /** A live run: a call shows only once its message is known (`knownAt`, on the same clock as `t`). */
  live?: boolean;
  knownAt?: (messageId: string) => number | undefined;
  /** Reduced motion: no comets, ripples or heat; a sender is filled for the flight window instead. */
  reduced?: boolean;
}

/** Everything on the network at recorded time `t`. */
export function swarmAt(model: SwarmModel, t: number, opts: FrameOptions = {}): SwarmFrame {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  const reduced = opts.reduced ?? false;
  const flightRec = flightWallMs(speed) * speed;
  const holdRec = heatHoldMs(speed) * speed;
  const decayRec = HEAT_DECAY_MS * speed;
  const launchRec = LAUNCH_MS * speed;
  const landRec = LAND_MS * speed;
  const fadeRec = FAIL_FADE_MS * speed;
  const detail = lod(speed);

  const agents: Record<string, AgentFrame> = {};
  for (const id of model.nodes) {
    const present = t >= (model.nodeSeen[id] ?? Infinity);
    agents[id] = { present, status: present ? "idle" : "absent", tasks: [], failed: false, rejected: false, sent: 0, received: 0 };
  }
  const sending = new Set<string>();
  const receiving = new Set<string>();
  const edges: Record<string, EdgeFrame> = {};
  const flights: Flight[] = [];
  const ripples: Ripple[] = [];
  const pods: Record<string, PodFrame> = {};
  for (const g of Object.keys(model.podTeam)) {
    pods[g] = { present: t >= (model.podSeen[g] ?? Infinity), count: 0, round: 0, result: null };
  }
  const board: BoardFrame = { convened: t >= model.benchSeen, proposals: 0, from: [], ratings: 0, status: "waiting", result: null };
  let latest: ModelMessage | null = null;
  let round = 0;
  let sent = 0;

  for (const m of model.messages) {
    const own = agents[m.from];
    // the call: from its start to its message (live: only once the message is known)
    if (own && m.drawn && t >= m.start && t < m.ts) {
      const known = opts.live ? (opts.knownAt?.(m.id) ?? Infinity) : -Infinity;
      if (t >= known) {
        const span = Math.max(1, m.ts - m.start);
        own.tasks.push({
          messageId: m.id,
          contextId: m.contextId,
          start: Math.max(m.start, known),
          end: m.ts,
          progress: clamp((t - m.start) / span, 0, 1),
          elapsed: t - m.start,
          latencyMs: m.latencyMs,
          team: model.nodeKind[m.from] === "red_team" ? m.threadTeam : m.team,
        });
      }
    }
    if (m.ts > t) continue;
    sent += 1;
    // the latest by recorded order (a feed can draw a late-arriving older message after a newer one)
    if (!latest || m.recorded > latest.recorded || (m.recorded === latest.recorded && m.seq > latest.seq)) latest = m;
    round = Math.max(round, m.round);
    const pod = pods[m.contextId];
    if (pod) {
      pod.count += 1;
      pod.round = Math.max(pod.round, m.round);
    }
    if (m.toBoard) {
      board.proposals += 1;
      if (!board.from.includes(m.contextId)) board.from.push(m.contextId);
    }
    if (m.kind === "rating") board.ratings += 1;
    if (!m.drawn) continue;
    if (own) {
      own.sent += 1;
      if (m.state === "failed") own.failed = true;
      if (m.state === "rejected") own.rejected = true;
    }
    for (const target of m.targets) {
      const a = agents[target];
      if (a) a.received += 1;
    }
    m.edgeKeys.forEach((key) => {
      const e = (edges[key] ??= { count: 0, lastTs: m.ts, heat: 0, failed: false });
      e.count += 1;
      e.lastTs = m.ts;
      if (m.state === "failed") e.failed = true;
    });
    if (m.state === "rejected") continue;
    const dt = t - m.ts;
    // the sender is filled for its comet's flight (reduced motion keeps this as the only sign of sending)
    if (dt < flightRec) sending.add(m.from);
    if (reduced) continue;
    if (detail.ripple && dt < launchRec) ripples.push({ key: `launch:${m.id}`, at: m.from, kind: "launch", p: dt / launchRec, team: m.team });
    const p = dt / flightRec;
    if (m.state === "failed") {
      if (p < 0.5) m.edgeKeys.forEach((key, i) => flights.push({ messageId: m.id, edgeKey: key, from: m.from, to: m.targets[i] ?? "", u: easeInOutCubic(p), kind: m.kind, failed: true, fade: 1, team: m.team }));
      else {
        const f = (dt - flightRec * 0.5) / fadeRec;
        if (f < 1) m.edgeKeys.forEach((key, i) => flights.push({ messageId: m.id, edgeKey: key, from: m.from, to: m.targets[i] ?? "", u: 0.5, kind: m.kind, failed: true, fade: 1 - f, team: m.team }));
      }
      continue;
    }
    if (p < 1) m.edgeKeys.forEach((key, i) => flights.push({ messageId: m.id, edgeKey: key, from: m.from, to: m.targets[i] ?? "", u: easeInOutCubic(p), kind: m.kind, failed: false, fade: 1, team: m.team }));
    else if (dt < flightRec + landRec) {
      for (const target of m.targets) {
        receiving.add(target);
        ripples.push({ key: `land:${m.id}:${target}`, at: target, kind: "land", p: (dt - flightRec) / landRec, team: m.team });
      }
    }
  }

  for (const e of Object.values(edges)) {
    const dt = t - e.lastTs;
    e.heat = reduced ? 0 : dt < holdRec ? 1 : clamp(1 - (dt - holdRec) / decayRec, 0, 1);
  }
  let inFlight = 0;
  let redInFlight = 0;
  for (const [id, a] of Object.entries(agents)) {
    inFlight += a.tasks.length;
    if (model.nodeKind[id] === "red_team") redInFlight += a.tasks.length;
    if (!a.present) continue;
    a.status = sending.has(id) ? "sending" : a.tasks.length > 0 ? "working" : receiving.has(id) ? "receiving" : "idle";
  }
  if (t >= model.boardSeen && model.board) {
    board.result = model.board;
    for (const row of model.board.rows) {
      const pod = pods[row.group];
      if (pod) pod.result = { code: row.code, share: row.share, incumbent: row.incumbent };
    }
  }
  board.status = board.result ? "scored" : board.convened ? "scoring" : "waiting";
  const flying = [...new Set(flights.map((f) => f.messageId))];
  return { t, agents, edges, flights, ripples, pods, board, latest, round, inFlight, redInFlight, sent, flying };
}

/** Past every comet, ring and cooling edge at any speed (16x: 4.2 s flight, 10 s hold, 19.2 s decay, recorded). */
export const SETTLED_MS = 60_000;

/**
 * A frame on a recorded clock (a run-level replay's cursor, or the graph's own replay): pure in the cursor, so a
 * paused seek draws exactly what was recorded by then and seeking back undoes it. At the end of the record every
 * transient has settled.
 */
export function replayFrame(model: SwarmModel, at: number, opts: { speed: number; ended: boolean; reduced?: boolean }): SwarmFrame {
  return swarmAt(model, opts.ended ? Math.max(at, model.end) + SETTLED_MS : at, { speed: opts.speed, reduced: opts.reduced ?? false });
}

/* ------------------------------------------------------------------------------------------------ stepping */

/**
 * Where a step from `t` lands: the previous or next message (its recorded time, so its comet is at launch), or the
 * previous or next round (its first message minus the round lead). Null at the ends.
 */
export function stepTarget(model: SwarmModel, t: number, dir: 1 | -1, unit: "message" | "round"): number | null {
  const times = unit === "message" ? model.messages.map((m) => m.ts) : model.roundStarts.map((r) => r.ts - ROUND_LEAD_MS);
  // a step back from just after a round start goes to the round before, not to the same start again
  const back = unit === "round" ? 1500 : 1;
  if (dir > 0) return times.find((x) => x > t + 1) ?? null;
  for (let i = times.length - 1; i >= 0; i--) {
    const x = times[i];
    if (x !== undefined && x < t - back) return x;
  }
  return null;
}

/** The seek target of a round chip: the round's first message minus the lead, or null if the round never ran. */
export function roundSeek(model: SwarmModel, round: number): number | null {
  const r = model.roundStarts.find((s) => s.round === round);
  return r ? r.ts - ROUND_LEAD_MS : null;
}

/* ------------------------------------------------------------------------------------------------ words */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Time since the S9 origin: `S9+01:27.0` (tenths, never rounded up), or `S9+01:27.012` for tooltips. */
export function formatSince(ms: number, precise = false): string {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms);
  if (precise) {
    const whole = Math.floor(abs);
    return `S9${sign}${pad2(Math.floor(whole / 60000))}:${pad2(Math.floor((whole % 60000) / 1000))}.${String(whole % 1000).padStart(3, "0")}`;
  }
  const tenths = Math.floor(abs / 100);
  return `S9${sign}${pad2(Math.floor(tenths / 600))}:${pad2(Math.floor((tenths % 600) / 10))}.${tenths % 10}`;
}

/** A span as `m:ss` (`3:16`). */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** The first sentence of a message, at most `max` characters. */
export function firstSentence(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? clean.slice(0, end + 1) : clean;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 3).trimEnd()}...`;
}

/** Who an id is, in a caption: a rival's agent by its team and role, a hub by name, an anchor by its group. */
export function speaker(view: SwarmView, id: string): string {
  if (id === "anchor:board" || id === "board") return "the board";
  if (id.startsWith("anchor:")) return speaker(view, id.slice(7));
  if (id.startsWith("team:")) {
    const g = view.groups.find((x) => x.id === id.slice(5));
    return g ? `${shortName(g.label)} team` : id.slice(5);
  }
  const card = view.cards[id];
  if (!card) {
    const g = view.groups.find((x) => x.id === id);
    return g ? (g.kind === "rival" ? `${shortName(g.label)} team` : g.label) : id;
  }
  if (card.group === "red_team") return "Red team";
  if (card.group === "analyst") return "Home analyst";
  if (card.group === "board") return card.name.replace(/^evaluator,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase()) + " evaluator";
  return `${shortName(card.groupLabel)} ${(ROLE_LABEL[card.role] ?? card.role).toLowerCase()}`;
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface Caption {
  kind: "message" | "working" | "board" | "none";
  line: string;
  detail: string;
  messageId: string | null;
  team: number;
}

/** The caption under the network at a frame: the newest message while it is fresh, else the calls in flight, else the
 *  latest message; the board's result once it is up. */
export function captionFor(frame: SwarmFrame, model: SwarmModel, view: SwarmView, speed = 1): Caption {
  const result = frame.board.result;
  if (result) {
    const top = [...result.rows].sort((a, b) => b.share - a.share)[0];
    const line = top
      ? `Board scored: ${shortName(top.label)} ${Math.round(top.share * 100)}% of the simulated vote. Simulated, never an input to the bid decision.`
      : "Board scored. Simulated, never an input to the bid decision.";
    return { kind: "board", line, detail: "", messageId: null, team: -1 };
  }
  const m = frame.latest;
  const fresh = m !== null && frame.t - m.ts <= Math.max(heatHoldMs(speed), flightWallMs(speed)) * speed;
  if (m && (fresh || frame.inFlight === 0)) return messageCaption(m, model, view);
  if (frame.inFlight > 0) {
    const calls = `${frame.inFlight} ${frame.inFlight === 1 ? "call" : "calls"} in flight`;
    return { kind: "working", line: `Working: ${calls}${frame.redInFlight > 0 ? ` (red team ${frame.redInFlight})` : ""}`, detail: "", messageId: null, team: -1 };
  }
  return { kind: "none", line: "", detail: "", messageId: null, team: -1 };
}

/** One message as a caption line: kind, sender, targets, recorded time since S9, call length, citations, model. */
export function messageCaption(m: ModelMessage, model: SwarmModel, view: SwarmView): Caption {
  const parts = [
    KIND_LABEL[m.kind],
    `${speaker(view, m.sender)} -> ${list(m.item.to.map((t) => speaker(view, t)))}`,
    formatSince(m.recorded - model.origin),
  ];
  if (m.latencyMs > 0) parts.push(`${(m.latencyMs / 1000).toFixed(1)} s`);
  if (m.state === "rejected") parts.push("not run: budget");
  else if (m.state === "failed") parts.push("failed");
  else parts.push(`${m.item.citations.length} cited${m.item.dropped > 0 ? `, ${m.item.dropped} dropped` : ""}`);
  if (m.item.usage.model) parts.push(m.item.usage.model);
  return { kind: "message", line: parts.join(" · "), detail: firstSentence(m.item.text), messageId: m.id, team: m.kind === "challenge" ? m.threadTeam : m.team };
}

/** An agent's accessible name at a frame; it changes only when its counts, status or badges do. */
export function ariaFor(view: SwarmView, id: string, frame: SwarmFrame): string {
  const a = frame.agents[id];
  const name = id.startsWith("team:") ? `${view.groups.find((g) => g.id === id.slice(5))?.label ?? id.slice(5)} capture team` : (view.cards[id]?.name ?? id);
  if (!a || !a.present) return `${name}: not in the swarm yet`;
  const bits = [`${a.sent} sent`, `${a.received} received`];
  const task = a.tasks[0];
  if (a.status === "working" && task) bits.push(`working on a ${(task.latencyMs / 1000).toFixed(1)} s model call`);
  if (a.tasks.length > 1) bits.push(`${a.tasks.length} calls in flight`);
  if (a.status === "sending") bits.push("sending");
  if (a.failed) bits.push("a call failed");
  if (a.rejected) bits.push("a call was not run (budget)");
  return `${name}: ${bits.join(", ")}`;
}

/* ------------------------------------------------------------------------------------------------ feed */

/** A message that arrives on the feed launches this long after it arrives (its sender's call finishes first). */
export const FEED_LEAD_MS = 700;
/** A batch of messages read at once is spread over at most this much wall time, in recorded order. */
export const FEED_SPREAD_MS = 2500;
/** A batch spanning more recorded time than this is a jump (a seek, a reconnect), drawn settled, not animated. */
export const FEED_JUMP_MS = 15_000;

/**
 * When the graph draws each recorded change while it follows a feed (a live run, or a run-level replay that feeds
 * the swarm view as of its cursor): a message is drawn when it arrives, not at its recorded time, so the graph
 * animates only messages it has actually received. Everything in the first read is history (time 0: settled).
 */
export interface FeedSchedule extends Retime {
  /** Wall time each message became known (its call shows from then until it launches). */
  known: Record<string, number>;
  /** The latest launch scheduled. */
  last: number;
}

/** The schedule after the feed delivered `view` at wall time `now` (`prev` null: the first read). */
export function scheduleFeed(prev: FeedSchedule | null, view: SwarmView, now: number): FeedSchedule {
  // `last` is rebuilt from the messages still in the view: a replay seeking back drops later ones, and their launches
  // must not hold back what arrives next
  const out: FeedSchedule = { messages: {}, cards: {}, board: null, known: {}, last: 0 };
  const fresh: SwarmItem[] = [];
  for (const m of view.messages) {
    const at = prev?.messages[m.messageId];
    if (at === undefined) fresh.push(m);
    else {
      out.messages[m.messageId] = at;
      out.known[m.messageId] = prev?.known[m.messageId] ?? 0;
      out.last = Math.max(out.last, at);
    }
  }
  for (const id of Object.keys(view.cardSeen)) out.cards[id] = prev ? (prev.cards[id] ?? now) : 0;
  const times = fresh.map((m) => parse(m.ts)).filter(Number.isFinite);
  const lo = times.length > 0 ? Math.min(...times) : 0;
  const span = times.length > 0 ? Math.max(...times) - lo : 0;
  const history = prev === null || span > FEED_JUMP_MS;
  const scale = span > FEED_SPREAD_MS ? FEED_SPREAD_MS / span : 1;
  const ordered = [...fresh].sort((a, b) => parse(a.ts) - parse(b.ts) || a.seq - b.seq);
  for (const m of ordered) {
    if (history) {
      out.messages[m.messageId] = 0;
      out.known[m.messageId] = 0;
      continue;
    }
    const at = Math.max(now + FEED_LEAD_MS + ((parse(m.ts) || lo) - lo) * scale, out.last);
    out.messages[m.messageId] = at;
    out.known[m.messageId] = now;
    out.last = at;
  }
  if (view.boardSeen) out.board = prev?.board ?? (history ? 0 : Math.max(now + FEED_LEAD_MS, out.last));
  return out;
}

/** When everything a schedule launched has played out (flight, landing and the edge cooling, at 1x). */
export function feedSettledAt(s: FeedSchedule): number {
  return Math.max(s.last, s.board ?? 0) + flightWallMs(1) + LAND_MS + heatHoldMs(1) + HEAT_DECAY_MS;
}
