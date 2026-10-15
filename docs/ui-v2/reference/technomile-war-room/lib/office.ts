/**
 * The agent office: the run's recorded events drawn as a 2.5D office floor where each agent has a desk. Pure
 * functions, so the view, its tests and a replay all see the same picture:
 *
 * - `foldOffice` keeps the events the office shows that the swarm read does not carry: the research lanes, S4
 *   fetches, S7 verdicts and stage edges.
 * - `planOffice` places the furniture: one pod of desks per rival (its S4 researcher plus its swarm agents), the
 *   red-team corner, the home analyst's desk, the verification desk, the web terminal and the board room.
 * - `buildSchedule` turns events into beats on a display clock (a compressed replay of the recorded times, or the
 *   live clock), and `frameAt` says where every agent is and what it is doing at one instant.
 *
 * Every beat comes from a recorded event: a message is its sender at the desk for the model call's recorded latency,
 * then a speech bubble and an envelope to each recipient; a burst of fetches is the rival's researcher walking to the
 * web terminal and back; a verdict is a stamp at the verification desk; a board card is an evaluator walking into the
 * board room. Nothing else moves.
 */
import type { FetchActivity, RunEventEnvelope, SourceTier, StepStatus, VerifyActivity } from "@/lib/contracts/run-events";
import type { StageId } from "@/lib/stages";

import { ACTIVE_RUN_STATES } from "./state";
import { PARKED_STATES, type SwarmItem, type SwarmView } from "./swarm";

/* ------------------------------------------------------------------------------------------------ the record */

export type Verdict = "supported" | "partly" | "withheld";

export const VERDICT: Record<VerifyActivity["verdict"], Verdict> = {
  supported: "supported",
  partially_supported: "partly",
  unsupported: "withheld",
};

export interface OfficeLane {
  key: string;
  label: string;
  home: boolean;
  /** The frame that first named the lane (the run's snapshot or a fetch): nothing about the rival shows before it. */
  seq: number;
  ts: number;
}

export interface OfficeFetch {
  seq: number;
  ts: number;
  lane: string;
  host: string;
  status: FetchActivity["status"];
  /** The source tier the fetch was filed under (the Playhouse's archive shelf). */
  tier: SourceTier;
}

export interface OfficeVerify {
  seq: number;
  ts: number;
  verdict: Verdict;
  /** The claim as recorded (the Playhouse's prompter slip shows its first words). */
  claim: string;
  /** The rival the claim belongs to, from the verdict's paired cell delta (`<idem key>:delta`, path
   *  `/cells/<subject>:<column>`); null while that delta is not recorded. */
  lane: string | null;
}

export interface OfficeStage {
  seq: number;
  ts: number;
  stage: StageId;
  edge: "started" | "finished";
  /** How a finished stage ended, as recorded (finished edges only). */
  status?: StepStatus;
}

/** A phase end: the run state it parked in (awaiting_plan_approval at H1, awaiting_decision at H2, ...). */
export interface OfficePark {
  seq: number;
  ts: number;
  state: string;
}

/** A research lane's activity line as recorded (`/lanes/<subject>/activity`): the tool call or step it is on. */
export interface OfficeNote {
  seq: number;
  ts: number;
  lane: string;
  text: string;
}

export interface OfficeRecord {
  lanes: OfficeLane[];
  fetches: OfficeFetch[];
  verifies: OfficeVerify[];
  stages: OfficeStage[];
  parks: OfficePark[];
  notes: OfficeNote[];
  lastSeq: number;
}

/** A rival's key on the floor: its name as the ledger spells it, case and spacing folded (fetches name the rival by
 *  its label, agent cards by group id and label). */
export function podKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Keep the office's events from any envelopes (any order, duplicates allowed); a frame with no readable time is
 *  skipped. Lanes come from the run's snapshot, in its lane order, plus any lane a fetch names. */
export function foldOffice(envs: readonly RunEventEnvelope[]): OfficeRecord {
  const out: OfficeRecord = { lanes: [], fetches: [], verifies: [], stages: [], parks: [], notes: [], lastSeq: 0 };
  const lanes = new Map<string, OfficeLane>();
  const seen = new Set<number>();
  // a verdict's rival comes from its paired cell delta (idem key + ":delta"), recorded just after it
  const verdictByKey = new Map<string, OfficeVerify>();
  const laneByKey = new Map<string, string>();
  for (const env of [...envs].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(env.seq)) continue;
    seen.add(env.seq);
    out.lastSeq = Math.max(out.lastSeq, env.seq);
    const ts = Date.parse(env.ts);
    if (!Number.isFinite(ts)) continue;
    const ev = env.event;
    if (ev.type === "STATE_SNAPSHOT") {
      for (const subject of ev.snapshot.laneOrder) {
        const lane = ev.snapshot.lanes[subject];
        if (lane && !lanes.has(podKey(lane.subject))) lanes.set(podKey(lane.subject), { key: podKey(lane.subject), label: lane.label, home: lane.home, seq: env.seq, ts });
      }
    } else if (ev.type === "STEP_STARTED" || ev.type === "STEP_FINISHED") {
      out.stages.push({
        seq: env.seq,
        ts,
        stage: ev.stepName,
        edge: ev.type === "STEP_STARTED" ? "started" : "finished",
        ...(ev.type === "STEP_FINISHED" ? { status: ev.status ?? "done" } : {}),
      });
    } else if (ev.type === "RUN_FINISHED") {
      out.parks.push({ seq: env.seq, ts, state: ev.result.state });
    } else if (ev.type === "STATE_DELTA") {
      for (const op of ev.delta) {
        const note = laneActivity(op.path);
        if (note !== null && typeof op.value === "string") out.notes.push({ seq: env.seq, ts, lane: podKey(note), text: op.value });
      }
      const subject = env.idemKey.endsWith(DELTA_SUFFIX) ? ev.delta.map((op) => cellSubject(op.path)).find((s) => s !== null) : undefined;
      if (subject) {
        const base = env.idemKey.slice(0, -DELTA_SUFFIX.length);
        const verdict = verdictByKey.get(base);
        if (verdict) verdict.lane = podKey(subject);
        else laneByKey.set(base, podKey(subject));
      }
    } else if (ev.type === "ACTIVITY_SNAPSHOT" && ev.activityType === "fetch") {
      const key = podKey(ev.content.subject);
      if (!lanes.has(key)) lanes.set(key, { key, label: ev.content.subject, home: false, seq: env.seq, ts });
      out.fetches.push({ seq: env.seq, ts, lane: key, host: ev.content.host, status: ev.content.status, tier: ev.content.tier });
    } else if (ev.type === "ACTIVITY_SNAPSHOT" && ev.activityType === "verify") {
      const v: OfficeVerify = { seq: env.seq, ts, verdict: VERDICT[ev.content.verdict], claim: ev.content.claim, lane: laneByKey.get(env.idemKey) ?? null };
      verdictByKey.set(env.idemKey, v);
      out.verifies.push(v);
    }
  }
  out.lanes = [...lanes.values()];
  return out;
}

/** The idem key suffix of the cell delta recorded with each S7 verdict. */
const DELTA_SUFFIX = ":delta";

/** One JSON-pointer segment, unescaped (`~1` is "/", `~0` is "~"). */
function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The subject of a lane's activity path (`/lanes/<subject>/activity`), else null. */
function laneActivity(path: string): string | null {
  const parts = path.split("/");
  return parts.length === 4 && parts[1] === "lanes" && parts[3] === "activity" && parts[2] ? unescapePointer(parts[2]) : null;
}

/** The subject of a cell path (`/cells/<subject>:<column>`, or deeper), else null. */
function cellSubject(path: string): string | null {
  const parts = path.split("/");
  if (parts[1] !== "cells" || !parts[2]) return null;
  const key = unescapePointer(parts[2]);
  const cut = key.lastIndexOf(":");
  return (cut > 0 ? key.slice(0, cut) : key) || null;
}

/** The events the office keeps from a live stream (everything else is dropped before it is held): stage edges, the
 *  snapshot, fetches and verdicts, plus the deltas that carry a lane's activity line or pair a verdict with its rival. */
export function isOfficeEvent(env: RunEventEnvelope): boolean {
  const ev = env.event;
  if (ev.type === "STATE_SNAPSHOT" || ev.type === "STEP_STARTED" || ev.type === "STEP_FINISHED") return true;
  if (ev.type === "STATE_DELTA") {
    return ev.delta.some((op) => laneActivity(op.path) !== null || (env.idemKey.endsWith(DELTA_SUFFIX) && cellSubject(op.path) !== null));
  }
  return ev.type === "ACTIVITY_SNAPSHOT" && (ev.activityType === "fetch" || ev.activityType === "verify");
}

/* ------------------------------------------------------------------------------------------------ the floor */

export interface Pt {
  x: number;
  y: number;
}

/** Floor size in tiles: x runs to the lower right of the screen, y to the lower left. */
export const FLOOR_W = 22;
export const FLOOR_D = 15;
/** Tile size on screen (a 2:1 isometric diamond) and the back walls' height. */
export const TILE_W = 64;
export const TILE_H = 32;
export const WALL_H = 110;
const PAD = 24;
export const OFFICE_W = (FLOOR_W + FLOOR_D) * (TILE_W / 2) + PAD * 2;
export const OFFICE_H = (FLOOR_W + FLOOR_D) * (TILE_H / 2) + WALL_H + PAD * 2;
const OX = FLOOR_D * (TILE_W / 2) + PAD;
const OY = WALL_H + PAD;

/** A floor point on screen (z lifts it, in screen pixels). */
export function iso(p: Pt, z = 0): { sx: number; sy: number } {
  return { sx: round1((p.x - p.y) * (TILE_W / 2) + OX), sy: round1((p.x + p.y) * (TILE_H / 2) + OY - z) };
}

/** Painter's order: things further back (smaller x + y) are drawn first. */
export function depth(p: Pt): number {
  return p.x + p.y;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export type Role = "researcher" | "capture_lead" | "pricing" | "technical" | "past_performance" | "red_team" | "analyst" | "evaluator" | "verifier";

export type Zone = "pod" | "red_team" | "analyst" | "board" | "verify";

export interface Seat {
  id: string;
  role: Role;
  zone: Zone;
  /** The rival's pod key (pods only). */
  pod: string | null;
  /** Team colour index (rival pods: 0..5), -1 for everyone else. */
  team: number;
  at: Pt;
  /** The swarm agent at this desk, once its card is recorded. */
  agentId: string | null;
}

export interface PodPlan {
  key: string;
  label: string;
  /** The swarm group id (the thread filter's context id), once the rival's cards are recorded. */
  groupId: string | null;
  team: number;
  center: Pt;
  seats: string[];
}

export interface OfficePlan {
  pods: PodPlan[];
  seats: Record<string, Seat>;
  /** Seat ids in painter's order. */
  order: string[];
  byAgent: Record<string, string>;
  kioskSlots: Pt[];
  verifyDesk: Pt;
  boardTable: Pt;
  door: Pt;
}

export const TEAM_COLOURS = 6;
export const KIOSK_SLOTS: readonly Pt[] = [3.55, 4.65, 5.75, 6.85, 7.95, 9.05].map((y) => ({ x: 1.15, y }));
export const VERIFY_SEAT: Pt = { x: 5.2, y: 0.9 };
export const ANALYST_SEAT: Pt = { x: 9.6, y: 0.9 };
export const HOME_LANE_SEAT: Pt = { x: 11.1, y: 0.9 };
export const DOOR: Pt = { x: 13.1, y: 0.25 };
export const BOARD_TABLE: Pt = { x: 17.9, y: 2.75 };
export const RED_SEAT: Pt = { x: 2.3, y: 12.4 };
/** The corridor between the back zone and the pods: walkers use it so they never cross a desk. */
export const AISLE_Y = 5.25;
const BOARD_SEATS: readonly Pt[] = [16.6, 17.9, 19.2].map((x) => ({ x, y: 1.95 }));

/** Seat offsets in a pod, by role: the researcher at the end nearest the web terminal, the specialists in the back
 *  row, the capture lead in front. */
const POD_SLOTS: Record<string, Pt> = {
  researcher: { x: -2.35, y: 0.1 },
  pricing: { x: -1.25, y: -0.85 },
  technical: { x: 0, y: -0.85 },
  past_performance: { x: 1.25, y: -0.85 },
  capture_lead: { x: 0, y: 1.1 },
};
const EXTRA_SLOTS: readonly Pt[] = [
  { x: 1.4, y: 1.1 },
  { x: -1.4, y: 1.1 },
  { x: 2.4, y: 0.1 },
];
const POD_ROLES: readonly Role[] = ["researcher", "pricing", "technical", "past_performance", "capture_lead"];

function asRole(role: string): Role {
  const known: readonly string[] = ["capture_lead", "pricing", "technical", "past_performance", "red_team", "analyst", "evaluator"];
  return (known.includes(role) ? role : "analyst") as Role;
}

/** Pod centres: one row for up to three rivals, two rows beyond that. */
export function podCentres(n: number): Pt[] {
  if (n <= 0) return [];
  const rows = n <= 3 ? 1 : 2;
  const cols = Math.ceil(n / rows);
  const x0 = 5.6;
  const span = FLOOR_W - 0.6 - x0;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const x = x0 + ((c + 0.5) * span) / inRow;
    const y = rows === 1 ? 10.1 : 7.6 + r * 5;
    return { x: round1(x), y };
  });
}

/** A rival as every view of the run places it: its pod key, name, swarm group (once its cards are recorded) and team
 *  colour index. */
export interface RivalPod {
  key: string;
  label: string;
  groupId: string | null;
  team: number;
}

/** Every rival the run names, keyed by pod key: the research lanes in lane order, then rivals that only appear as swarm
 *  groups; the home lane is kept (flagged) so the office can seat its researcher. */
function rivalEntries(view: SwarmView, record: OfficeRecord): [string, { label: string; groupId: string | null; home: boolean }][] {
  const rivals = new Map<string, { label: string; groupId: string | null; home: boolean }>();
  for (const lane of record.lanes) rivals.set(lane.key, { label: lane.label, groupId: null, home: lane.home });
  for (const g of view.groups) {
    if (g.kind !== "rival") continue;
    const key = podKey(g.label);
    const known = rivals.get(key);
    rivals.set(key, { label: known?.label ?? g.label, groupId: g.id, home: known?.home ?? false });
  }
  return [...rivals.entries()];
}

/**
 * The rival pods in the order every view draws them (the office floor and the agent graph): research lanes first, in
 * lane order, then rivals that only appear as swarm groups. A rival keeps its team colour (`i % TEAM_COLOURS`) in both
 * views, and its place does not move when its agents' cards arrive.
 */
export function rivalPods(view: SwarmView, record: OfficeRecord): RivalPod[] {
  return rivalEntries(view, record)
    .filter(([, r]) => !r.home)
    .map(([key, r], i) => ({ key, label: r.label, groupId: r.groupId, team: i % TEAM_COLOURS }));
}

/**
 * The floor for a run: a pod per rival in lane order (rivals that only appear as swarm groups follow), the home lane's
 * researcher beside the analyst, and the fixed rooms. Desks exist from the start; a chair is filled when the agent's
 * card is recorded.
 */
export function planOffice(view: SwarmView, record: OfficeRecord): OfficePlan {
  const seats: Record<string, Seat> = {};
  const byAgent: Record<string, string> = {};
  const add = (seat: Seat) => {
    seats[seat.id] = seat;
    if (seat.agentId) byAgent[seat.agentId] = seat.id;
  };

  const homeLanes = rivalEntries(view, record).filter(([, r]) => r.home);
  const rivals = rivalPods(view, record);
  const centres = podCentres(rivals.length);

  const pods: PodPlan[] = rivals.map(({ key, label, groupId, team }, i) => {
    const center = centres[i] ?? { x: 10, y: 10 };
    const group = groupId ? view.groups.find((g) => g.id === groupId) : undefined;
    const ids: string[] = [];
    const place = (role: Role, agentId: string | null, offset: Pt, suffix: string) => {
      const id = `${key}:${suffix}`;
      add({ id, role, zone: "pod", pod: key, team, at: { x: center.x + offset.x, y: center.y + offset.y }, agentId });
      ids.push(id);
    };
    for (const role of POD_ROLES) {
      const card = role === "researcher" ? undefined : group?.agents.find((a) => a.role === role);
      place(role, card?.agentId ?? null, POD_SLOTS[role] ?? { x: 0, y: 0 }, role === "researcher" ? "lane" : role);
    }
    // a card with a role the pod has no desk for still gets a desk of its own
    (group?.agents ?? [])
      .filter((a) => !POD_ROLES.includes(a.role as Role))
      .slice(0, EXTRA_SLOTS.length)
      .forEach((a, j) => place(asRole(a.role), a.agentId, EXTRA_SLOTS[j] ?? { x: 0, y: 0 }, `x${j}`));
    return { key, label, groupId, team, center, seats: ids };
  });

  homeLanes.slice(0, 1).forEach(([key]) => add({ id: `${key}:lane`, role: "researcher", zone: "analyst", pod: key, team: -1, at: HOME_LANE_SEAT, agentId: null }));

  const group = (kind: string) => view.groups.find((g) => g.kind === kind)?.agents ?? [];
  const red = group("red_team");
  add({ id: "red_team", role: "red_team", zone: "red_team", pod: null, team: -1, at: RED_SEAT, agentId: red[0]?.agentId ?? null });
  red.slice(1, 3).forEach((a, i) => add({ id: `red_team:${i + 1}`, role: "red_team", zone: "red_team", pod: null, team: -1, at: { x: RED_SEAT.x + 1.3 * (i + 1), y: RED_SEAT.y + 0.6 }, agentId: a.agentId }));
  const analyst = group("analyst");
  add({ id: "analyst", role: "analyst", zone: "analyst", pod: null, team: -1, at: ANALYST_SEAT, agentId: analyst[0]?.agentId ?? null });
  const board = group("board");
  BOARD_SEATS.forEach((at, i) => add({ id: `board:${i}`, role: "evaluator", zone: "board", pod: null, team: -1, at, agentId: board[i]?.agentId ?? null }));
  add({ id: "verifier", role: "verifier", zone: "verify", pod: null, team: -1, at: VERIFY_SEAT, agentId: null });

  const order = Object.values(seats)
    .sort((a, b) => depth(a.at) - depth(b.at) || a.at.x - b.at.x)
    .map((s) => s.id);
  return { pods, seats, order, byAgent, kioskSlots: [...KIOSK_SLOTS], verifyDesk: VERIFY_SEAT, boardTable: BOARD_TABLE, door: DOOR };
}

/** The seats a message reaches: named agents at their desks, a group id as every seated member of that group. A
 *  message to the board before its evaluators have cards is addressed to the board room table (`"board"`). */
export function recipientSeats(plan: OfficePlan, view: SwarmView, m: Pick<SwarmItem, "from" | "to">): string[] {
  const out = new Set<string>();
  for (const t of m.to) {
    const direct = plan.byAgent[t];
    if (direct) {
      out.add(direct);
      continue;
    }
    const members = (view.groups.find((g) => g.id === t)?.agents ?? []).map((a) => plan.byAgent[a.agentId]).filter((s): s is string => s !== undefined);
    if (members.length > 0) members.forEach((s) => out.add(s));
    else if (t === "board") out.add("board");
  }
  const own = plan.byAgent[m.from];
  if (own) out.delete(own);
  return [...out];
}

/* ------------------------------------------------------------------------------------------------ clocks */

/** Maps a recorded time (ms since epoch) to the display clock; `typingStart` is when a model call is shown starting. */
export interface BeatClock {
  at(ts: number): number;
  typingStart(ts: number, latencyMs: number): number;
}

export interface WarpKey {
  t: number;
  /** The least display time this key adds after the previous one (spreads a burst so each event can be seen). */
  minStep?: number;
}

export const REPLAY_RATE = 8;
export const REPLAY_MAX_GAP_MS = 6000;
export const REPLAY_LEAD_MS = 600;

/**
 * A replay clock over the recorded times: the run plays `rate` times faster, a quiet stretch longer than `maxGap`
 * is cut to it, and a key with `minStep` is held apart from the one before it. Monotonic: a later recorded time is
 * never shown earlier. `recordedAt` is the inverse (the recorded time a display time shows), piecewise linear over
 * the same keys; it saturates where `at` does (before the lead-in and past the last cut gap), and is NaN with no keys.
 */
export function replayClock(
  keys: readonly WarpKey[],
  rate = REPLAY_RATE,
  maxGap = REPLAY_MAX_GAP_MS,
): BeatClock & { span: number; recordedAt(display: number): number } {
  const merged = new Map<number, number>();
  for (const k of keys) if (Number.isFinite(k.t)) merged.set(k.t, Math.max(merged.get(k.t) ?? 0, k.minStep ?? 0));
  const ts = [...merged.keys()].sort((a, b) => a - b);
  const ds: number[] = [];
  ts.forEach((t, i) => {
    const prevT = ts[i - 1];
    const prevD = ds[i - 1];
    ds.push(prevT === undefined || prevD === undefined ? REPLAY_LEAD_MS : prevD + Math.max(merged.get(t) ?? 0, Math.min(t - prevT, maxGap) / rate));
  });
  const at = (t: number): number => {
    const first = ts[0];
    const last = ts.at(-1);
    if (first === undefined || last === undefined) return REPLAY_LEAD_MS;
    if (t <= first) return Math.max(0, REPLAY_LEAD_MS - (first - t) / rate);
    if (t >= last) return (ds.at(-1) ?? 0) + Math.min(t - last, maxGap) / rate;
    let lo = 0;
    let hi = ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((ts[mid] ?? 0) <= t) lo = mid;
      else hi = mid;
    }
    const t0 = ts[lo] ?? 0;
    const t1 = ts[hi] ?? 0;
    const d0 = ds[lo] ?? 0;
    const d1 = ds[hi] ?? 0;
    return d0 + ((t - t0) / (t1 - t0)) * (d1 - d0);
  };
  const recordedAt = (d: number): number => {
    const first = ts[0];
    const last = ts.at(-1);
    const dFirst = ds[0];
    const dLast = ds.at(-1);
    if (first === undefined || last === undefined || dFirst === undefined || dLast === undefined) return NaN;
    if (d <= dFirst) return first - (dFirst - Math.max(0, d)) * rate;
    if (d >= dLast) return last + Math.min((d - dLast) * rate, maxGap);
    let lo = 0;
    let hi = ds.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((ds[mid] ?? 0) <= d) lo = mid;
      else hi = mid;
    }
    const t0 = ts[lo] ?? 0;
    const t1 = ts[hi] ?? 0;
    const d0 = ds[lo] ?? 0;
    const d1 = ds[hi] ?? 0;
    return t0 + ((d - d0) / (d1 - d0)) * (t1 - t0);
  };
  return { at, typingStart: (t, lat) => at(t - Math.max(0, lat)), span: ds.at(-1) ?? REPLAY_LEAD_MS, recordedAt };
}

/** How far behind the ledger the live office plays, so a message read by the swarm poll can still show its typing. */
export const LIVE_LAG_MS = 3500;
export const LIVE_TYPING_MS = 1600;

/**
 * The live clock: a recorded time plus the measured offset between the server's clock and this one (`skewMs`,
 * arrival minus recorded time) plus the lag. A model call is shown for at most `LIVE_TYPING_MS` before its message.
 * `recordedAt` is the inverse: the recorded time the office is showing at a wall time.
 */
export function liveClock(skewMs: number, lagMs = LIVE_LAG_MS): BeatClock & { recordedAt(display: number): number } {
  const at = (t: number) => t + skewMs + lagMs;
  return { at, typingStart: (t, lat) => at(t) - Math.min(Math.max(0, lat), LIVE_TYPING_MS), recordedAt: (d) => d - skewMs - lagMs };
}

/* ------------------------------------------------------------------------------------------------ beats */

export const WALK_MS = 1100;
export const SEND_MS = 2600;
export const FLIGHT_MS = 950;
export const REACT_MS = 700;
export const STAMP_MS = 520;
export const STAMP_GAP_MS = 240;
export const MIN_BROWSE_MS = 1400;
export const ENTER_MS = 1600;
/** Fetches of one lane further apart than this (recorded) are separate trips to the terminal. */
export const TRIP_JOIN_MS = 20_000;

export interface HostVisit {
  at: number;
  host: string;
  status: FetchActivity["status"];
}

export type Beat =
  | { kind: "type"; id: string; seat: string; start: number; end: number; seq: number }
  | { kind: "send"; id: string; seat: string; to: string[]; start: number; end: number; seq: number; msgId: string; text: string; failed: boolean }
  | { kind: "trip"; id: string; seat: string; slot: number; start: number; out: number; back: number; end: number; seq: number; visits: HostVisit[]; carries: boolean }
  | { kind: "stamp"; id: string; start: number; end: number; seq: number; verdict: Verdict; count: number; hits: { at: number; verdict: Verdict }[] }
  | { kind: "enter"; id: string; seat: string; start: number; end: number; seq: number };

export interface Schedule {
  beats: Beat[];
  /** Display time each verdict lands (for the tally), in order. */
  verdicts: { at: number; verdict: Verdict }[];
  /** Display time each message is sent (for the thread during a replay), in order. */
  sends: { at: number; msgId: string }[];
  /** When each seat's agent is in the office (-Infinity: from the start; Infinity: not yet recorded). */
  presentFrom: Record<string, number>;
  /** When the board's scores go up (Infinity: no board result). */
  scoresAt: number;
  /** Stage edges on the display clock, in ledger order (history at -Infinity: it is already in effect). */
  stages: { at: number; stage: StageId; edge: "started" | "finished" }[];
  /** The display time by which every beat has ended. */
  end: number;
}

/** The recorded times a replay clock needs (every beat's anchors), with bursts of verdicts held apart. */
export function warpKeys(view: SwarmView, record: OfficeRecord): WarpKey[] {
  const keys: WarpKey[] = [];
  for (const f of record.fetches) keys.push({ t: f.ts, minStep: 35 });
  for (const v of record.verifies) keys.push({ t: v.ts, minStep: 14 });
  for (const s of record.stages) keys.push({ t: s.ts });
  for (const m of view.messages) {
    const ts = Date.parse(m.ts);
    keys.push({ t: ts, minStep: 260 }, { t: ts - Math.max(0, m.usage.latencyMs) });
  }
  for (const seen of Object.values(view.cardSeen)) keys.push({ t: Date.parse(seen.ts) });
  if (view.boardSeen) keys.push({ t: Date.parse(view.boardSeen.ts), minStep: 400 });
  return keys;
}

/**
 * Beats for every recorded event after `settledSeq` (events at or before it are history: they set the scene, but
 * nothing moves for them). A run's events are placed on the display clock the caller chose.
 */
export function buildSchedule(plan: OfficePlan, view: SwarmView, record: OfficeRecord, clock: BeatClock, settledSeq = 0): Schedule {
  const beats: Beat[] = [];
  const fresh = (seq: number) => seq > settledSeq;

  // presence: researchers and the verifier are always at their desks; an agent from its card on; a board member
  // walks in from the door
  const presentFrom: Record<string, number> = {};
  for (const id of plan.order) {
    const seat = plan.seats[id];
    if (!seat) continue;
    if (!seat.agentId) {
      presentFrom[id] = seat.role === "researcher" || seat.role === "verifier" ? -Infinity : Infinity;
      continue;
    }
    const seen = view.cardSeen[seat.agentId];
    const at = seen ? clock.at(Date.parse(seen.ts)) : -Infinity;
    if (!seen || !fresh(seen.seq) || !Number.isFinite(at)) {
      presentFrom[id] = -Infinity;
      continue;
    }
    presentFrom[id] = at;
    if (seat.zone === "board") beats.push({ kind: "enter", id: `enter:${id}`, seat: id, start: at, end: at + ENTER_MS, seq: seen.seq });
  }

  // messages: the call at the desk, then the bubble and an envelope to each recipient
  const sends: Schedule["sends"] = [];
  for (const m of view.messages) {
    const seat = plan.byAgent[m.from];
    const ts = Date.parse(m.ts);
    if (!Number.isFinite(ts)) continue;
    const at = clock.at(ts);
    sends.push({ at: fresh(m.seq) ? at : -Infinity, msgId: m.messageId });
    if (!seat || !fresh(m.seq)) continue;
    const typingFrom = Math.min(clock.typingStart(ts, m.usage.latencyMs), at);
    if (at - typingFrom > 50) beats.push({ kind: "type", id: `type:${m.messageId}`, seat, start: typingFrom, end: at, seq: m.seq });
    beats.push({
      kind: "send",
      id: `send:${m.messageId}`,
      seat,
      to: recipientSeats(plan, view, m),
      start: at,
      end: at + SEND_MS,
      seq: m.seq,
      msgId: m.messageId,
      text: m.text,
      failed: m.state !== "completed",
    });
  }
  sends.sort((a, b) => a.at - b.at);

  // research: a lane's fetches close together are one trip to the web terminal
  const podIndex = new Map(plan.pods.map((p, i) => [p.key, i]));
  const byLane = new Map<string, OfficeFetch[]>();
  for (const f of record.fetches) byLane.set(f.lane, [...(byLane.get(f.lane) ?? []), f]);
  for (const [lane, list] of byLane) {
    const seat = `${lane}:lane`;
    if (!plan.seats[seat]) continue;
    const slot = (podIndex.get(lane) ?? plan.pods.length) % plan.kioskSlots.length;
    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    let trip: Extract<Beat, { kind: "trip" }> | null = null;
    let lastTs = -Infinity;
    for (const f of ordered) {
      const at = clock.at(f.ts);
      const visit = { at, host: f.host, status: f.status };
      // a trip never mixes history with fresh events: history does not move
      if (trip && fresh(f.seq) === fresh(trip.seq) && f.ts - lastTs <= TRIP_JOIN_MS && at - trip.back <= 2 * WALK_MS + 600) {
        trip.visits.push(visit);
        trip.back = Math.max(trip.back, at, trip.out + MIN_BROWSE_MS);
        trip.end = trip.back + WALK_MS;
        trip.carries ||= f.status === "ok";
        trip.seq = Math.max(trip.seq, f.seq);
      } else {
        if (trip && fresh(trip.seq)) beats.push(trip);
        trip = { kind: "trip", id: `trip:${lane}:${f.seq}`, seat, slot, start: at - WALK_MS, out: at, back: at + MIN_BROWSE_MS, end: at + MIN_BROWSE_MS + WALK_MS, seq: f.seq, visits: [visit], carries: f.status === "ok" };
      }
      lastTs = f.ts;
    }
    if (trip && fresh(trip.seq)) beats.push(trip);
  }

  // verification: one stamp per burst of verdicts; the tally counts every verdict
  const verdicts = record.verifies
    .map((v) => ({ at: fresh(v.seq) ? clock.at(v.ts) : -Infinity, verdict: v.verdict, seq: v.seq }))
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  let stamp: Extract<Beat, { kind: "stamp" }> | null = null;
  for (const v of verdicts) {
    if (!Number.isFinite(v.at)) continue;
    if (stamp && v.at - stamp.start < STAMP_GAP_MS) {
      stamp.verdict = v.verdict;
      stamp.count += 1;
      stamp.seq = v.seq;
      stamp.hits.push({ at: v.at, verdict: v.verdict });
      continue;
    }
    stamp = { kind: "stamp", id: `stamp:${v.seq}`, start: v.at, end: v.at + STAMP_MS, seq: v.seq, verdict: v.verdict, count: 1, hits: [{ at: v.at, verdict: v.verdict }] };
    beats.push(stamp);
  }

  const scoresAt = view.boardSeen ? (fresh(view.boardSeen.seq) ? clock.at(Date.parse(view.boardSeen.ts)) : -Infinity) : Infinity;
  // an evaluator sits down before its model call is shown: the call starts when the walk in ends
  const seated = new Map(beats.filter((b) => b.kind === "enter").map((b) => [b.seat, b.end]));
  for (const b of beats) {
    const from = b.kind === "type" ? seated.get(b.seat) : undefined;
    if (b.kind === "type" && from !== undefined) b.start = Math.min(Math.max(b.start, from), b.end);
  }
  beats.sort((a, b) => a.start - b.start || a.seq - b.seq);
  // the live clock keeps ticking until the last fresh change: a beat's end, an agent's arrival, a stage edge, the scores
  const ends = beats.map((b) => b.end);
  if (Number.isFinite(scoresAt)) ends.push(scoresAt + 1200);
  for (const at of Object.values(presentFrom)) if (Number.isFinite(at)) ends.push(at);
  const stages = [...record.stages]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ at: fresh(s.seq) ? clock.at(s.ts) : -Infinity, stage: s.stage, edge: s.edge }));
  for (const s of stages) if (Number.isFinite(s.at)) ends.push(s.at);
  return {
    beats,
    verdicts: verdicts.map(({ at, verdict }) => ({ at, verdict })),
    sends,
    presentFrom,
    scoresAt,
    stages,
    end: ends.length ? Math.max(...ends) : 0,
  };
}

/* ------------------------------------------------------------------------------------------------ frames */

/** An agent is in the office from its arrival on; -Infinity is always, Infinity (no card recorded) is never, even in a
 *  run's final frame (t = Infinity). */
export function isPresent(from: number | undefined, t: number): boolean {
  if (from === undefined || from === Infinity) return false;
  return t >= from;
}

export type Activity = "idle" | "typing" | "sending" | "receiving" | "walking" | "browsing" | "stamping" | "entering";

export interface Walk {
  path: Pt[];
  start: number;
  end: number;
}

export interface SeatFrame {
  present: boolean;
  activity: Activity;
  /** Where the agent stands when not walking (its seat unless it is at the terminal). */
  at: Pt;
  away: boolean;
  walk: Walk | null;
  carrying: boolean;
  /** The host on the browser card while the agent is at the terminal. */
  visit: HostVisit | null;
  visits: number;
  bubble: { text: string; msgId: string; start: number; failed: boolean } | null;
}

export interface Flight {
  id: string;
  from: string;
  /** A seat id, or "board" for the board-room table. */
  to: string;
  start: number;
  end: number;
}

export interface OfficeFrame {
  t: number;
  seats: Record<string, SeatFrame>;
  flights: Flight[];
  stamp: { id: string; verdict: Verdict; count: number; start: number } | null;
  tally: Record<Verdict, number>;
  scores: boolean;
  /** Messages sent by `t`. */
  sent: number;
}

/** A researcher's way between the desk and a terminal slot: out along the corridor, never through a desk. */
export function tripPath(from: Pt, slot: Pt, sideStep = 0): Pt[] {
  const lane = from.x - sideStep;
  const out = sideStep > 0 ? [{ x: lane, y: from.y }] : [];
  return [from, ...out, { x: lane, y: AISLE_Y }, { x: slot.x + 0.9, y: AISLE_Y }, slot];
}

/** A pod researcher first steps off the pod's rug (into the gap beside it), so the walk never crosses a desk. */
export const POD_SIDE_STEP = 1.2;

/** An evaluator's way in: through the door, along the back of the board table, to the chair. */
export function enterPath(seat: Pt): Pt[] {
  return [DOOR, { x: DOOR.x, y: 1.0 }, { x: seat.x, y: 1.0 }, seat];
}

/** The point at fraction `f` (0..1) along a polyline, by length. */
export function pointAlong(path: readonly Pt[], f: number): Pt {
  const first = path[0] ?? { x: 0, y: 0 };
  if (path.length < 2) return first;
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - (path[i]?.x ?? 0), p.y - (path[i]?.y ?? 0)));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total === 0) return first;
  let d = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i] ?? 0;
    const a = path[i] ?? first;
    const b = path[i + 1] ?? first;
    if (d <= len || i === lens.length - 1) {
      const k = len === 0 ? 1 : Math.min(1, d / len);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    d -= len;
  }
  return path.at(-1) ?? first;
}

/** Where every agent is and what it is doing at display time `t`. */
export function frameAt(plan: OfficePlan, sched: Schedule, t: number): OfficeFrame {
  const seats: Record<string, SeatFrame> = {};
  for (const id of plan.order) {
    const seat = plan.seats[id];
    if (!seat) continue;
    seats[id] = {
      present: isPresent(sched.presentFrom[id], t),
      activity: "idle",
      at: seat.at,
      away: false,
      walk: null,
      carrying: false,
      visit: null,
      visits: 0,
      bubble: null,
    };
  }
  const flights: Flight[] = [];
  let stamp: OfficeFrame["stamp"] = null;
  const set = (id: string, patch: Partial<SeatFrame>) => {
    const s = seats[id];
    if (s) seats[id] = { ...s, ...patch };
  };
  const busy = (id: string) => seats[id]?.activity !== "idle" && seats[id]?.activity !== "receiving";

  for (const b of sched.beats) {
    if (b.kind === "send") {
      const land = b.start + FLIGHT_MS;
      if (t >= land && t < land + REACT_MS) for (const r of b.to) if (!busy(r)) set(r, { activity: "receiving" });
      if (t >= b.start && t < land) for (const r of b.to) flights.push({ id: `${b.id}>${r}`, from: b.seat, to: r, start: b.start, end: land });
    }
    if (t < b.start || t >= b.end) continue;
    switch (b.kind) {
      case "type":
        if (seats[b.seat]?.activity !== "sending") set(b.seat, { activity: "typing" });
        break;
      case "send":
        set(b.seat, { activity: "sending", bubble: { text: b.text, msgId: b.msgId, start: b.start, failed: b.failed } });
        break;
      case "enter": {
        const seat = plan.seats[b.seat];
        if (seat) set(b.seat, { activity: "entering", walk: { path: enterPath(seat.at), start: b.start, end: b.end }, present: true });
        break;
      }
      case "stamp": {
        // only the burst's verdicts recorded by `t`: the rest of the burst has not happened yet
        const landed = b.hits.filter((h) => h.at <= t);
        stamp = { id: b.id, verdict: landed.at(-1)?.verdict ?? b.verdict, count: Math.max(1, landed.length), start: b.start };
        set("verifier", { activity: "stamping" });
        break;
      }
      case "trip": {
        const seat = plan.seats[b.seat];
        const slot = plan.kioskSlots[b.slot];
        if (!seat || !slot) break;
        const seen = b.visits.filter((v) => v.at <= t);
        const visit = seen.at(-1) ?? b.visits[0] ?? null;
        const step = seat.zone === "pod" ? POD_SIDE_STEP : 0;
        if (t < b.out) set(b.seat, { activity: "walking", away: true, walk: { path: tripPath(seat.at, slot, step), start: b.start, end: b.out } });
        else if (t < b.back) set(b.seat, { activity: "browsing", away: true, at: slot, visit, visits: Math.max(1, seen.length) });
        else set(b.seat, { activity: "walking", away: true, carrying: b.carries, walk: { path: tripPath(seat.at, slot, step).reverse(), start: b.back, end: b.end }, visits: b.visits.length });
        break;
      }
    }
  }

  const tally: Record<Verdict, number> = { supported: 0, partly: 0, withheld: 0 };
  for (const v of sched.verdicts) if (v.at <= t) tally[v.verdict] += 1;
  const sent = sched.sends.filter((s) => s.at <= t).length;
  return { t, seats, flights, stamp, tally, scores: t >= sched.scoresAt, sent };
}

/** Ids of the first `n` messages sent (a frame's `sent`): the thread under a replaying office shows only these. */
export function sentFirst(sched: Schedule, n: number): Set<string> {
  return new Set(sched.sends.slice(0, Math.max(0, n)).map((s) => s.msgId));
}

/* ------------------------------------------------------------------------------------------------ live sync */

export interface LiveSync {
  /** The run's last recorded seq when the office opened (bh-api's snapshot): events at or before it are history and
   *  never animate. Null until the snapshot is read; until then nothing is fresh. */
  settledSeq: number | null;
  /** Arrival minus recorded time, the least seen on a fresh event (null until one arrives). */
  skewMs: number | null;
}

export const NEW_SYNC: LiveSync = { settledSeq: null, skewMs: null };

/** Fold one arriving envelope (at wall time `now`) into the live sync: only events after the history boundary
 *  measure the clock skew (an old event's age is not skew). */
export function noteArrival(sync: LiveSync, env: { seq: number; ts: string }, now: number): LiveSync {
  if (sync.settledSeq === null || env.seq <= sync.settledSeq) return sync;
  const skew = now - Date.parse(env.ts);
  if (!Number.isFinite(skew)) return sync;
  return { ...sync, skewMs: sync.skewMs === null ? skew : Math.min(sync.skewMs, skew) };
}

/**
 * What the office's feed does once its stream has closed or caught up, given the run's state (bh-api's snapshot), the
 * last seq received and the run's last recorded seq: `follow` an active run, `read` on until everything recorded has
 * arrived, `park` while the run can still come back (a human gate, an interruption: look again later), or `end`.
 */
export function feedAction(status: string, received: number, recorded: number): "follow" | "read" | "park" | "end" {
  if (ACTIVE_RUN_STATES.has(status)) return "follow";
  if (received < recorded) return "read";
  return PARKED_STATES.has(status) ? "park" : "end";
}

/** The latest stage started and not yet finished at display time `t`, else null (history counts at once). */
export function stageAt(sched: Pick<Schedule, "stages">, t: number): StageId | null {
  let current: StageId | null = null;
  for (const s of sched.stages) {
    if (s.at > t) break;
    if (s.edge === "started") current = s.stage;
    else if (current === s.stage) current = null;
  }
  return current;
}
