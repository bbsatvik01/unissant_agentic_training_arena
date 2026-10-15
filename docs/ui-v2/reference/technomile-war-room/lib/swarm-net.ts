/**
 * The agent swarm as a situation-room network: a deterministic layout of reserved slots (no physics), the A2A messages
 * folded into directed edges, and each edge's fixed geometry. Pure functions of a SwarmView and the run's rival pods,
 * so the view, its tests, a live run and a replay all draw the same picture.
 *
 * Layout (a 1200 x 680 world): the rival pods stand in two columns, left and right; the hubs sit on a centre spine,
 * the home analyst at the top, the red team in the middle and the evaluation board's bench at the bottom. Lead-to-hub
 * traffic runs in the open channel between the columns, and every message addressed to the board ends at one inbox on
 * the bench instead of fanning out to its evaluators. Slots come from the run's rival list, so nothing moves when an
 * agent's card arrives.
 */
import type { RivalPod } from "./office";
import type { GroupKind, SwarmItem, SwarmView } from "./swarm";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Disc extends Pt {
  r: number;
}

/** The opacity of everything outside the current focus or hover (shared with the strip and the thread). */
export const DIM = 0.3;
/** Edges stop this far outside the shapes they join. */
export const TRIM = 3;

export const WORLD = { w: 1200, h: 680 } as const;
export const COMPACT_WORLD = { w: 420, h: 640 } as const;

const SPINE = 600;
export const ANALYST: Disc = { x: SPINE, y: 72, r: 26 };
export const RED: Disc = { x: SPINE, y: 330, r: 36 };
/** Radii of the red team's task rings (one per call in flight, innermost first). */
export const RED_RINGS: readonly number[] = [42, 47, 52, 57, 62];
export const BENCH: Rect = { x: SPINE - 180, y: 500, w: 360, h: 168 };
export const INBOX: Rect = { x: SPINE - 52, y: 486, w: 104, h: 28 };
const SEAT_Y = 590;
const SEAT_R = 20;
const SEAT_X: readonly number[] = [510, 600, 690];

const POD_W = 312;
const POD_H = 152;
const POD_H_TIGHT = 132;
const POD_LEFT = 36;
const POD_RIGHT = WORLD.w - POD_LEFT - POD_W;
const HEADER_H = 28;
export const LEAD_R = 26;
const LEAD_IN = 58;
const PILL_W = 136;
const PILL_H = 28;
const PILL_PAD = 16;
const PILL_ROWS: readonly number[] = [-22, 14, 50];
const PILL_ROWS_TIGHT: readonly number[] = [-20, 11, 42];

/** Pod row centres by how many rivals a column holds. */
const ROWS: Record<number, readonly number[]> = { 1: [330], 2: [206, 454], 3: [112, 330, 548], 4: [96, 256, 416, 576] };

/** The groups a message can address as a whole: a message to one of them ends at its anchor. */
const HUB_GROUPS: ReadonlySet<string> = new Set(["board", "red_team", "analyst"]);

export const ROLE_LABEL: Record<string, string> = {
  capture_lead: "Capture lead",
  pricing: "Pricing",
  technical: "Technical",
  past_performance: "Past perf.",
  red_team: "Red team",
  analyst: "Home analyst",
  evaluator: "Evaluator",
  team: "Capture team",
};

const SPECIALISTS: readonly string[] = ["pricing", "technical", "past_performance"];
const MEMBER_ORDER: Record<string, number> = { capture_lead: -1, pricing: 0, technical: 1, past_performance: 2 };

export interface NetPod {
  key: string;
  groupId: string | null;
  label: string;
  team: number;
  side: "left" | "right";
  rect: Rect;
  cy: number;
  header: Rect;
  /** The hub slot (the capture lead, else the team's first card). */
  lead: Disc;
  /** The specialists' reserved slots, outer side, top to bottom. */
  pills: Rect[];
}

export interface NetAgent {
  id: string;
  kind: GroupKind;
  role: string;
  groupId: string;
  /** The rival's pod key (rival agents only). */
  pod: string | null;
  /** Rival team colour index; -1 for the hubs. */
  team: number;
  shape: "disc" | "pill";
  x: number;
  y: number;
  /** Disc radius; a pill's half height. */
  r: number;
  rect: Rect | null;
  /** Where a pill's edges leave it: the middle of the side that faces its lead. */
  port: Pt | null;
  side: "left" | "right" | null;
  label: string;
  /** Order inside its group (the hub first), for keyboard order and the strip's sub-rows. */
  slot: number;
}

export interface NetAnchor {
  id: string;
  x: number;
  y: number;
  r: number;
  rect: Rect | null;
}

export interface NetBench {
  rect: Rect;
  inbox: Rect;
  seats: Disc[];
}

export interface NetLayout {
  world: { w: number; h: number };
  compact: boolean;
  pods: NetPod[];
  agents: NetAgent[];
  byId: Record<string, NetAgent>;
  anchors: NetAnchor[];
  anchorById: Record<string, NetAnchor>;
  /** Agent ids drawn as another node: the compact layout draws a rival's whole team as one disc. */
  alias: Record<string, string>;
  bench: NetBench;
  analyst: Disc;
  red: Disc;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which node a recorded id is drawn as (itself, unless the layout folds it into another). */
export function nodeOf(layout: Pick<NetLayout, "alias">, id: string): string {
  return layout.alias[id] ?? id;
}

/** Group ids a message can address as a whole: every swarm group plus the fixed hubs (the board exists as a target
 *  before its evaluators' cards are recorded). */
function groupIds(view: SwarmView): Set<string> {
  const out = new Set(HUB_GROUPS);
  for (const g of view.groups) out.add(g.id);
  return out;
}

/**
 * Who a message reaches on the network: a recipient with a card stays an agent id; a group id becomes that group's
 * anchor (`anchor:board`), never fanned out to its members; never the sender; unknown ids are dropped; no duplicates.
 */
export function targets(view: SwarmView, m: Pick<SwarmItem, "from" | "to">): string[] {
  const groups = groupIds(view);
  const out = new Set<string>();
  for (const t of m.to) {
    if (view.cards[t]) out.add(t);
    else if (groups.has(t)) out.add(`anchor:${t}`);
  }
  out.delete(m.from);
  return [...out];
}

function memberRank(role: string): number {
  return MEMBER_ORDER[role] ?? 9;
}

function evaluatorLabel(name: string): string {
  const m = /^evaluator,\s*(.+)$/i.exec(name.trim());
  if (!m?.[1]) return "Evaluator";
  const s = m[1].trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Pod rectangles for `n` rivals: the left column takes ceil(n/2), top to bottom, the right column the rest. */
function podSlots(rivals: readonly RivalPod[]): NetPod[] {
  const left = Math.ceil(rivals.length / 2);
  return rivals.map((r, i) => {
    const side: "left" | "right" = i < left ? "left" : "right";
    const col = side === "left" ? left : rivals.length - left;
    const row = side === "left" ? i : i - left;
    const k = clamp(col, 1, 4);
    const tight = k >= 4;
    const h = tight ? POD_H_TIGHT : POD_H;
    const rows = ROWS[k] ?? [330];
    // more than four rivals in a column (nine or more in all) share the column's height evenly
    const cy = col <= 4 ? (rows[row] ?? 330) : round1(40 + h / 2 + (row * (WORLD.h - 80 - h)) / Math.max(1, col - 1));
    const x = side === "left" ? POD_LEFT : POD_RIGHT;
    const rect = { x, y: round1(cy - h / 2), w: POD_W, h };
    const inner = side === "left" ? x + POD_W : x;
    const leadX = side === "left" ? inner - LEAD_IN : inner + LEAD_IN;
    const pillX = side === "left" ? x + PILL_PAD : x + POD_W - PILL_PAD - PILL_W;
    const pills = (tight ? PILL_ROWS_TIGHT : PILL_ROWS).map((dy) => ({ x: pillX, y: round1(cy + dy - PILL_H / 2), w: PILL_W, h: PILL_H }));
    return {
      key: r.key,
      groupId: r.groupId,
      label: r.label,
      team: r.team,
      side,
      rect,
      cy,
      header: { x, y: rect.y, w: POD_W, h: HEADER_H },
      lead: { x: leadX, y: cy + 12, r: LEAD_R },
      pills,
    };
  });
}

function pillAgent(id: string, role: string, groupId: string, pod: NetPod, rect: Rect, slot: number, label: string): NetAgent {
  const port = pod.side === "left" ? { x: rect.x + rect.w, y: rect.y + rect.h / 2 } : { x: rect.x, y: rect.y + rect.h / 2 };
  return { id, kind: "rival", role, groupId, pod: pod.key, team: pod.team, shape: "pill", x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, r: rect.h / 2, rect, port, side: pod.side, label, slot };
}

function discAgent(id: string, kind: GroupKind, role: string, groupId: string, d: Disc, slot: number, label: string, pod: NetPod | null = null): NetAgent {
  return { id, kind, role, groupId, pod: pod?.key ?? null, team: pod?.team ?? -1, shape: "disc", x: d.x, y: d.y, r: d.r, rect: null, port: null, side: pod?.side ?? null, label, slot };
}

/** Members of a hub group in one row on their slot. */
function row(n: number, i: number, centre: number, gap: number): number {
  return round1(centre + (i - (n - 1) / 2) * gap);
}

/**
 * Where everything sits. `rivals` is the run's rival list (`rivalPods`: research lanes first, then swarm-only groups);
 * a rival group the list does not name is appended, so every card has a place. Reserved slots never depend on which
 * cards exist: a pod, its lead and its specialists' slots are drawn from the list alone, the board's bench and inbox
 * from the start.
 */
export function layoutNetwork(view: SwarmView, rivals: readonly RivalPod[], opts: { compact?: boolean } = {}): NetLayout {
  const known = new Set(rivals.map((r) => r.groupId).filter((g): g is string => g !== null));
  const extra = view.groups.filter((g) => g.kind === "rival" && !known.has(g.id));
  const all: RivalPod[] = [...rivals, ...extra.map((g, i) => ({ key: `group:${g.id}`, label: g.label, groupId: g.id, team: (rivals.length + i) % 6 }))];
  return opts.compact ? compactLayout(view, all) : fullLayout(view, all);
}

function fullLayout(view: SwarmView, rivals: readonly RivalPod[]): NetLayout {
  const pods = podSlots(rivals);
  const agents: NetAgent[] = [];
  const anchors: NetAnchor[] = [
    { id: "anchor:board", x: INBOX.x + INBOX.w / 2, y: INBOX.y + INBOX.h / 2, r: INBOX.h / 2, rect: INBOX },
    { id: "anchor:red_team", ...RED, rect: null },
    { id: "anchor:analyst", ...ANALYST, rect: null },
  ];
  for (const pod of pods) {
    if (pod.groupId) anchors.push({ id: `anchor:${pod.groupId}`, ...pod.lead, rect: null });
    const group = pod.groupId ? view.groups.find((g) => g.id === pod.groupId) : undefined;
    if (!group) continue;
    const ordered = [...group.agents].sort((a, b) => memberRank(a.role) - memberRank(b.role));
    const hub = ordered[0];
    if (!hub) continue;
    agents.push(discAgent(hub.agentId, "rival", hub.role, group.id, pod.lead, 0, ROLE_LABEL[hub.role] ?? hub.role, pod));
    // the three specialists keep their reserved rows; anything else (an unknown role, a second card of one role) takes
    // the free rows in order; a team larger than the rows stacks evenly in the pod's outer column
    const rest = ordered.slice(1);
    const rowOf = new Map<string, number>();
    for (const a of rest) {
      const s = SPECIALISTS.indexOf(a.role);
      if (s >= 0 && ![...rowOf.values()].includes(s)) rowOf.set(a.agentId, s);
    }
    const free = [0, 1, 2].filter((i) => ![...rowOf.values()].includes(i));
    const others = rest.filter((a) => !rowOf.has(a.agentId));
    if (others.length <= free.length) {
      others.forEach((a, j) => rowOf.set(a.agentId, free[j] ?? 0));
      for (const a of rest) {
        const slot = rowOf.get(a.agentId) ?? 0;
        const rect = pod.pills[slot];
        if (rect) agents.push(pillAgent(a.agentId, a.role, group.id, pod, rect, slot + 1, ROLE_LABEL[a.role] ?? a.role));
      }
    } else {
      const rects = stackRects(pod, rest.length);
      rest.forEach((a, i) => {
        const rect = rects[i];
        if (rect) agents.push(pillAgent(a.agentId, a.role, group.id, pod, rect, i + 1, ROLE_LABEL[a.role] ?? a.role));
      });
    }
  }
  const groupOf = (kind: GroupKind) => view.groups.filter((g) => g.kind === kind).flatMap((g) => g.agents);
  const red = groupOf("red_team");
  red.forEach((c, i) => agents.push(discAgent(c.agentId, "red_team", c.role, c.group, { x: row(red.length, i, RED.x, 84), y: RED.y, r: RED.r }, i, ROLE_LABEL.red_team ?? "Red team")));
  const analyst = groupOf("analyst");
  analyst.forEach((c, i) => agents.push(discAgent(c.agentId, "analyst", c.role, c.group, { x: row(analyst.length, i, ANALYST.x, 64), y: ANALYST.y, r: ANALYST.r }, i, ROLE_LABEL.analyst ?? "Home analyst")));
  const board = groupOf("board");
  const seats: Disc[] = board.length <= SEAT_X.length ? SEAT_X.map((x) => ({ x, y: SEAT_Y, r: SEAT_R })) : board.map((_, i) => ({ x: row(board.length, i, SPINE, Math.min(90, 320 / board.length)), y: SEAT_Y, r: SEAT_R }));
  board.forEach((c, i) => {
    const seat = seats[i];
    if (seat) agents.push(discAgent(c.agentId, "board", c.role, c.group, seat, i, evaluatorLabel(c.name)));
  });
  return finish({ w: WORLD.w, h: WORLD.h }, false, pods, agents, anchors, {}, { rect: BENCH, inbox: INBOX, seats }, ANALYST, RED);
}

/** `n` pill slots stacked evenly in a pod's outer column (a team with more members than the three specialists). */
function stackRects(pod: NetPod, n: number): Rect[] {
  const top = pod.rect.y + HEADER_H + 2;
  const bottom = pod.rect.y + pod.rect.h - 6;
  const h = Math.min(PILL_H, (bottom - top - 2 * (n - 1)) / n);
  const gap = n > 1 ? (bottom - top - n * h) / (n - 1) : 0;
  const x = pod.pills[0]?.x ?? pod.rect.x + PILL_PAD;
  return Array.from({ length: n }, (_, i) => ({ x, y: round1(top + i * (h + gap)), w: PILL_W, h: round1(h) }));
}

/* ------------------------------------------------------------------------------------------------ compact */

const C_SPINE = COMPACT_WORLD.w / 2;
const C_ANALYST: Disc = { x: C_SPINE, y: 46, r: 20 };
const C_RED: Disc = { x: C_SPINE, y: 300, r: 30 };
const C_BENCH: Rect = { x: C_SPINE - 150, y: 470, w: 300, h: 120 };
const C_INBOX: Rect = { x: C_SPINE - 46, y: 457, w: 92, h: 26 };
const C_ROWS: Record<number, readonly number[]> = { 1: [290], 2: [150, 330], 3: [90, 230, 370], 4: [70, 175, 280, 385] };
const C_TEAM_R = 24;

/**
 * The compact Teams layout for a narrow container: one disc per rival (its whole capture team) on two columns beside
 * the same spine. A team's own briefs stay inside its disc (they have no edge); everything else is drawn as in the full
 * layout, from the team.
 */
function compactLayout(view: SwarmView, rivals: readonly RivalPod[]): NetLayout {
  const left = Math.ceil(rivals.length / 2);
  const pods: NetPod[] = [];
  const agents: NetAgent[] = [];
  const alias: Record<string, string> = {};
  const anchors: NetAnchor[] = [
    { id: "anchor:board", x: C_INBOX.x + C_INBOX.w / 2, y: C_INBOX.y + C_INBOX.h / 2, r: C_INBOX.h / 2, rect: C_INBOX },
    { id: "anchor:red_team", ...C_RED, rect: null },
    { id: "anchor:analyst", ...C_ANALYST, rect: null },
  ];
  rivals.forEach((r, i) => {
    const side: "left" | "right" = i < left ? "left" : "right";
    const col = side === "left" ? left : rivals.length - left;
    const rowI = side === "left" ? i : i - left;
    const rows = C_ROWS[clamp(col, 1, 4)] ?? [290];
    const cy = col <= 4 ? (rows[rowI] ?? 290) : round1(70 + (rowI * 315) / Math.max(1, col - 1));
    const x = side === "left" ? 62 : COMPACT_WORLD.w - 62;
    const lead = { x, y: cy, r: C_TEAM_R };
    const rect = { x: x - 54, y: cy - 34, w: 108, h: 96 };
    const pod: NetPod = { key: r.key, groupId: r.groupId, label: r.label, team: r.team, side, rect, cy, header: { x: rect.x, y: rect.y + rect.h - 26, w: rect.w, h: 26 }, lead, pills: [] };
    pods.push(pod);
    if (!r.groupId) return;
    const id = `team:${r.groupId}`;
    anchors.push({ id: `anchor:${r.groupId}`, ...lead, rect: null });
    alias[`anchor:${r.groupId}`] = id;
    const group = view.groups.find((g) => g.id === r.groupId);
    if (!group || group.agents.length === 0) return;
    for (const a of group.agents) alias[a.agentId] = id;
    agents.push(discAgent(id, "rival", "team", r.groupId, lead, 0, ROLE_LABEL.team ?? "Capture team", pod));
  });
  const groupOf = (kind: GroupKind) => view.groups.filter((g) => g.kind === kind).flatMap((g) => g.agents);
  // several red-team or analyst members fold into the first one's disc
  for (const [kind, disc] of [
    ["red_team", C_RED],
    ["analyst", C_ANALYST],
  ] as const) {
    const members = groupOf(kind);
    const first = members[0];
    if (!first) continue;
    agents.push(discAgent(first.agentId, kind, first.role, first.group, disc, 0, ROLE_LABEL[kind] ?? kind));
    for (const m of members.slice(1)) alias[m.agentId] = first.agentId;
  }
  const board = groupOf("board");
  const seatX = board.length <= 3 ? [C_SPINE - 72, C_SPINE, C_SPINE + 72] : board.map((_, i) => row(board.length, i, C_SPINE, Math.min(72, 260 / board.length)));
  const seats: Disc[] = seatX.map((x) => ({ x, y: C_BENCH.y + 74, r: 16 }));
  board.forEach((c, i) => {
    const seat = seats[i];
    if (seat) agents.push(discAgent(c.agentId, "board", c.role, c.group, seat, i, evaluatorLabel(c.name)));
  });
  return finish({ w: COMPACT_WORLD.w, h: COMPACT_WORLD.h }, true, pods, agents, anchors, alias, { rect: C_BENCH, inbox: C_INBOX, seats }, C_ANALYST, C_RED);
}

function finish(world: { w: number; h: number }, compact: boolean, pods: NetPod[], agents: NetAgent[], anchors: NetAnchor[], alias: Record<string, string>, bench: NetBench, analyst: Disc, red: Disc): NetLayout {
  return {
    world,
    compact,
    pods,
    agents,
    byId: Object.fromEntries(agents.map((a) => [a.id, a])),
    anchors,
    anchorById: Object.fromEntries(anchors.map((a) => [a.id, a])),
    alias,
    bench,
    analyst,
    red,
  };
}

/* ------------------------------------------------------------------------------------------------ edges */

export interface NetEdge {
  /** `from>to`, directed, between drawn nodes. */
  key: string;
  from: string;
  to: string;
  /** The messages it carries, in recorded order. */
  messageIds: string[];
}

export function edgeId(from: string, to: string): string {
  return `${from}>${to}`;
}

/** The undirected key of the pair an edge joins (both directions light up together under an edge focus). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

/**
 * Messages folded into directed edges between drawn nodes: one per (sender, target) pair, a group as its anchor, in
 * the order of each edge's first message. A message from an agent without a card draws nothing; a message between two
 * agents drawn as one node (a team's own brief in the compact layout) has no edge.
 */
export function netEdges(view: SwarmView, layout: Pick<NetLayout, "alias"> = { alias: {} }): NetEdge[] {
  const edges = new Map<string, NetEdge>();
  const ordered = [...view.messages].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq);
  for (const m of ordered) {
    if (!view.cards[m.from]) continue;
    const from = nodeOf(layout, m.from);
    for (const t of targets(view, m)) {
      const to = nodeOf(layout, t);
      if (to === from) continue;
      const key = edgeId(from, to);
      const e = edges.get(key) ?? { key, from, to, messageIds: [] };
      if (!e.messageIds.includes(m.messageId)) e.messageIds.push(m.messageId);
      edges.set(key, e);
    }
  }
  return [...edges.values()];
}

/* ------------------------------------------------------------------------------------------------ geometry */

type Curve = { kind: "Q"; p: [Pt, Pt, Pt] } | { kind: "C"; p: [Pt, Pt, Pt, Pt] };

type Shape = { kind: "disc"; c: Pt; r: number } | { kind: "rect"; rect: Rect; c: Pt };

export type EdgeShape = "lens" | "hub" | "brief" | "rating";

export interface EdgeGeometry {
  shape: EdgeShape;
  /** The centre line as an SVG path (the hit area follows it). */
  d: string;
  /** A tapered ribbon: `w` wide at the sender's rim, 45% of that at the target's. */
  ribbon: (w: number) => string;
  /** The point at fraction `u` of the edge's length, from the sender's rim (0) to the target's (1). */
  pointAt: (u: number) => Pt;
  midpoint: Pt;
  start: Pt;
  end: Pt;
  length: number;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function curveAt(c: Curve, t: number): Pt {
  if (c.kind === "Q") {
    const [p0, p1, p2] = c.p;
    return lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
  }
  const [p0, p1, p2, p3] = c.p;
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const d = lerp(p2, p3, t);
  return lerp(lerp(a, b, t), lerp(b, d, t), t);
}

function curveTangent(c: Curve, t: number): Pt {
  if (c.kind === "Q") {
    const [p0, p1, p2] = c.p;
    return { x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y) };
  }
  const [p0, p1, p2, p3] = c.p;
  const a = 3 * (1 - t) * (1 - t);
  const b = 6 * (1 - t) * t;
  const d = 3 * t * t;
  return { x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + d * (p3.x - p2.x), y: a * (p1.y - p0.y) + b * (p2.y - p1.y) + d * (p3.y - p2.y) };
}

/** The part of a curve between parameters `a` and `b`, as a curve of the same degree (blossoms). */
function subCurve(c: Curve, a: number, b: number): Curve {
  if (c.kind === "Q") {
    const [p0, p1, p2] = c.p;
    const bl = (t1: number, t2: number): Pt => {
      const w0 = (1 - t1) * (1 - t2);
      const w1 = (1 - t1) * t2 + t1 * (1 - t2);
      const w2 = t1 * t2;
      return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y };
    };
    return { kind: "Q", p: [bl(a, a), bl(a, b), bl(b, b)] };
  }
  const [p0, p1, p2, p3] = c.p;
  const bl = (t1: number, t2: number, t3: number): Pt => {
    const w0 = (1 - t1) * (1 - t2) * (1 - t3);
    const w1 = t1 * (1 - t2) * (1 - t3) + (1 - t1) * t2 * (1 - t3) + (1 - t1) * (1 - t2) * t3;
    const w2 = t1 * t2 * (1 - t3) + t1 * (1 - t2) * t3 + (1 - t1) * t2 * t3;
    const w3 = t1 * t2 * t3;
    return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
  };
  return { kind: "C", p: [bl(a, a, a), bl(a, a, b), bl(a, b, b), bl(b, b, b)] };
}

function inside(s: Shape, p: Pt): boolean {
  if (s.kind === "disc") return Math.hypot(p.x - s.c.x, p.y - s.c.y) < s.r + TRIM;
  const { x, y, w, h } = s.rect;
  return p.x > x - TRIM && p.x < x + w + TRIM && p.y > y - TRIM && p.y < y + h + TRIM;
}

/** The first parameter at which the curve has left `s` (searching from `from` toward `to`). */
function exitParam(c: Curve, s: Shape, from: number, to: number): number {
  const steps = 64;
  let prev = from;
  for (let i = 1; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    if (!inside(s, curveAt(c, t))) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2;
        if (inside(s, curveAt(c, mid))) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    prev = t;
  }
  return to;
}

function shapeOf(layout: NetLayout, id: string): Shape | null {
  const a = layout.byId[id];
  if (a) return a.rect ? { kind: "rect", rect: a.rect, c: { x: a.x, y: a.y } } : { kind: "disc", c: { x: a.x, y: a.y }, r: a.r };
  const n = layout.anchorById[id];
  if (!n) return null;
  return n.rect ? { kind: "rect", rect: n.rect, c: { x: n.x, y: n.y } } : { kind: "disc", c: { x: n.x, y: n.y }, r: n.r };
}

const isRed = (layout: NetLayout, id: string) => id === "anchor:red_team" || layout.byId[id]?.kind === "red_team";
const isSeat = (layout: NetLayout, id: string) => layout.byId[id]?.kind === "board";

function fmt(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/**
 * The fixed geometry of the edge `from -> to` (null when either end has no slot). Quadratic curves trimmed 3 px
 * outside both rims: an edge touching the red team bends to the left of travel (so a lead's edge to the red team and
 * the red team's edge back form a lens, and neither moves when the other appears); other hub edges bend away from the
 * red team's centre; a specialist's brief is a cubic flow curve that leaves its port horizontally into its lead; an
 * evaluator's rating is a short arc into the inbox.
 */
export function edgeGeometry(layout: NetLayout, from: string, to: string): EdgeGeometry | null {
  const a = shapeOf(layout, from);
  const b = shapeOf(layout, to);
  if (!a || !b) return null;
  const src = layout.byId[from];
  const dst = layout.byId[to];
  let curve: Curve;
  let shape: EdgeShape;
  let startShape: Shape = a;
  if (src?.port && dst && src.pod !== null && src.pod === dst.pod && dst.shape === "disc") {
    // a brief: from the pill's port, leaving horizontally, into the lead
    const p0 = src.port;
    const p3 = { x: dst.x, y: dst.y };
    const dx = p3.x - p0.x;
    curve = { kind: "C", p: [p0, { x: p0.x + dx * 0.55, y: p0.y }, { x: p3.x - dx * 0.45, y: p3.y }, p3] };
    shape = "brief";
    startShape = { kind: "rect", rect: src.rect ?? { x: p0.x, y: p0.y, w: 0, h: 0 }, c: p0 };
  } else {
    const s = a.c;
    const e = b.c;
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const left = { x: dy / len, y: -dx / len };
    let n = left;
    let bend: number;
    if (isSeat(layout, from) && to === "anchor:board") {
      shape = "rating";
      const centre = layout.bench.rect.x + layout.bench.rect.w / 2;
      const outward = s.x < centre - 1 ? -1 : s.x > centre + 1 ? 1 : 0;
      // bow away from the bench's middle; the middle seat bows left
      n = outward === 0 || left.x * outward > 0 ? left : { x: -left.x, y: -left.y };
      bend = clamp(0.18 * len, 10, 22);
    } else if (isRed(layout, from) || isRed(layout, to)) {
      shape = "lens";
      bend = clamp(0.1 * len, 12, 34);
    } else {
      shape = "hub";
      const mid = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 };
      const away = (mid.x - layout.red.x) * left.x + (mid.y - layout.red.y) * left.y;
      n = away >= 0 ? left : { x: -left.x, y: -left.y };
      bend = clamp(0.14 * len, 14, 64);
    }
    // a quadratic's apex sits half its control offset from the chord: the offset is twice the bend
    const c = { x: (s.x + e.x) / 2 + n.x * bend * 2, y: (s.y + e.y) / 2 + n.y * bend * 2 };
    curve = { kind: "Q", p: [s, c, e] };
  }
  const t0 = exitParam(curve, startShape, 0, 1);
  const t1 = exitParam(curve, b, 1, t0);
  const part = subCurve(curve, t0, Math.max(t0, t1));

  // an arc-length table for pointAt (48 samples)
  const N = 48;
  const pts: Pt[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= N; i++) pts.push(curveAt(part, i / N));
  for (let i = 1; i <= N; i++) {
    const p = pts[i] ?? pts[0]!;
    const q = pts[i - 1] ?? p;
    cum.push((cum[i - 1] ?? 0) + Math.hypot(p.x - q.x, p.y - q.y));
  }
  const length = cum[N] ?? 0;
  const pointAt = (u: number): Pt => {
    const target = clamp(u, 0, 1) * length;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] ?? 0) <= target) lo = mid;
      else hi = mid;
    }
    const l0 = cum[lo] ?? 0;
    const l1 = cum[hi] ?? l0;
    const k = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    return lerp(pts[lo] ?? pts[0]!, pts[hi] ?? pts[N]!, k);
  };

  const d =
    part.kind === "Q"
      ? `M${fmt(part.p[0].x)} ${fmt(part.p[0].y)}Q${fmt(part.p[1].x)} ${fmt(part.p[1].y)} ${fmt(part.p[2].x)} ${fmt(part.p[2].y)}`
      : `M${fmt(part.p[0].x)} ${fmt(part.p[0].y)}C${fmt(part.p[1].x)} ${fmt(part.p[1].y)} ${fmt(part.p[2].x)} ${fmt(part.p[2].y)} ${fmt(part.p[3].x)} ${fmt(part.p[3].y)}`;

  const ribbon = (w: number): string => {
    const S = 24;
    const fwd: string[] = [];
    const back: string[] = [];
    for (let i = 0; i < S; i++) {
      const t = i / (S - 1);
      const p = curveAt(part, t);
      const tan = curveTangent(part, t);
      const tl = Math.hypot(tan.x, tan.y) || 1;
      const nx = -tan.y / tl;
      const ny = tan.x / tl;
      const half = (w * (1 - 0.55 * t)) / 2;
      fwd.push(`${fmt(p.x + nx * half)} ${fmt(p.y + ny * half)}`);
      back.push(`${fmt(p.x - nx * half)} ${fmt(p.y - ny * half)}`);
    }
    return `M${fwd.join("L")}L${back.reverse().join("L")}Z`;
  };

  return { shape, d, ribbon, pointAt, midpoint: pointAt(0.5), start: pts[0] ?? a.c, end: pts[N] ?? b.c, length };
}

/** An edge ribbon's width at its sender for `count` messages carried. */
export function ribbonWidth(count: number): number {
  return 1.4 + 1.6 * Math.sqrt(Math.max(0, count));
}

/** Each node's neighbours on the given edges (its ego network). */
export function neighbours(edges: readonly Pick<NetEdge, "from" | "to">[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const e of edges) {
    (out[e.from] ??= new Set()).add(e.to);
    (out[e.to] ??= new Set()).add(e.from);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

export interface Highlight {
  /** Something is focused or hovered: everything not lit is drawn dimmed. */
  dimming: boolean;
  lit: (node: string) => boolean;
  litEdge: (from: string, to: string) => boolean;
}

/**
 * What a focus or hover string lights on the drawn network: an agent's ego network ("agent:<id>", or a compact team
 * "team:<group>"), one conversation ("edge:<a~b>"), or a whole group (a rival group id, "board"). Ids are resolved
 * through the layout's aliases, so a focus set in the full layout still lights the compact one.
 */
export function highlight(focus: string | null, layout: Pick<NetLayout, "alias" | "agents">, nbrs: Record<string, string[]>): Highlight {
  if (!focus || focus === "all") return { dimming: false, lit: () => true, litEdge: () => true };
  // the drawn nodes an id stands for: itself (through the aliases), or, for a compact team in the full layout, the
  // team's agents and its anchor
  const drawn = (raw: string): Set<string> => {
    const id = nodeOf(layout, raw);
    if (!id.startsWith("team:") || layout.agents.some((a) => a.id === id)) return new Set([id]);
    const g = id.slice(5);
    return new Set([...layout.agents.filter((a) => a.groupId === g).map((a) => a.id), `anchor:${g}`]);
  };
  const set = new Set<string>();
  if (focus.startsWith("agent:") || focus.startsWith("team:")) {
    const ids = drawn(focus.startsWith("agent:") ? focus.slice(6) : focus);
    for (const id of ids) {
      set.add(id);
      for (const n of nbrs[id] ?? []) set.add(n);
    }
    return { dimming: true, lit: (n) => set.has(n), litEdge: (from, to) => ids.has(from) || ids.has(to) };
  }
  if (focus.startsWith("edge:")) {
    const [a = "", b = ""] = focus.slice(5).split("~");
    const A = drawn(a);
    const B = drawn(b);
    for (const id of [...A, ...B]) set.add(id);
    return { dimming: true, lit: (n) => set.has(n), litEdge: (from, to) => (A.has(from) && B.has(to)) || (A.has(to) && B.has(from)) };
  }
  for (const a of layout.agents) if (a.groupId === focus) set.add(a.id);
  set.add(`anchor:${focus}`);
  return { dimming: true, lit: (n) => set.has(n), litEdge: (from, to) => set.has(from) || set.has(to) };
}
