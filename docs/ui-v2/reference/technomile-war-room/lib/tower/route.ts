/**
 * How things move in the Bid Tower: people walk along a floor, one lift carries riders between floors, and
 * capsules travel the brass tubes. Pure and deterministic, so a replay, a live run and the tests agree.
 *
 * The lift is one cabin. Riders whose requests come from the same recorded event (every researcher once the plan
 * is approved; the board's evaluators when their cards are recorded) ride together: the cabin collects them floor
 * by floor in its direction of travel, then drops them. A request made while the cabin is busy waits for it. The
 * cabin never moves before the event that called it.
 */
import type { Pt } from "../office";

import { X, type Row, type TowerLayout } from "./layout";

/* ------------------------------------------------------------------------------------------------ walking */

export const WALK_UNITS_PER_MS = 0.15;
export const WALK_MIN_MS = 300;
/** A long walk is quickened to fit this (a person never takes longer than this to cross a room). */
export const WALK_MAX_MS = 2000;

/** How long a walk of `dx` native units takes. */
export function walkMs(dx: number): number {
  const d = Math.abs(dx);
  if (d < 1) return 0;
  return Math.round(Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, d / WALK_UNITS_PER_MS)));
}

/* ------------------------------------------------------------------------------------------------ the lift */

export const LIFT_UNITS_PER_MS = 0.32;
export const DOOR_MS = 340;
/** Requests whose events fall this close together ride in one sweep. */
export const GATHER_MS = 400;

export interface RideRequest {
  rider: string;
  from: number;
  to: number;
  /** When the event that calls the lift happened (the cabin may set off then). */
  event: number;
  /** When the rider reaches the landing door on `from`. */
  ready: number;
}

export interface LiftStop {
  row: number;
  arrive: number;
  depart: number;
}

export interface LiftRide {
  id: string;
  riders: string[];
  /** The cabin's stops in order; the first is where it set off from (arrive = depart = its start). */
  stops: LiftStop[];
  start: number;
  end: number;
  /** When each rider steps in and out. */
  board: Record<string, number>;
  alight: Record<string, number>;
}

export interface LiftPlan {
  rides: LiftRide[];
  /** Where the cabin waits before its first ride. */
  rest: number;
}

function travelMs(rows: readonly Row[], a: number, b: number): number {
  const ya = rows[a]?.floor ?? 0;
  const yb = rows[b]?.floor ?? 0;
  return Math.round(Math.abs(yb - ya) / LIFT_UNITS_PER_MS);
}

/**
 * The cabin's rides for every request (any order), starting at `rest`. Requests going the same way whose events
 * are within `GATHER_MS` of the first ride together; pickups are visited in the direction of travel (the farthest
 * first when the cabin has to come to them), then drops. A rider not yet at the door when the cabin arrives is
 * waited for.
 */
export function planLift(requests: readonly RideRequest[], rows: readonly Row[], rest: number): LiftPlan {
  let pending = requests
    .filter((r) => r.from !== r.to && Number.isFinite(r.event) && Number.isFinite(r.ready))
    .sort((a, b) => a.event - b.event || a.from - b.from || (a.rider < b.rider ? -1 : a.rider > b.rider ? 1 : 0));
  const rides: LiftRide[] = [];
  let at = rest;
  let free = -Infinity;
  while (pending.length > 0) {
    const first = pending[0] as RideRequest;
    const down = first.to > first.from;
    // requests going the same way whose events are close ride together; the others wait for the next ride
    const batch = pending.filter((r) => r.event - first.event <= GATHER_MS && r.to > r.from === down);
    pending = pending.filter((r) => !batch.includes(r));

    const pickups = [...new Set(batch.map((r) => r.from))];
    const drops = [...new Set(batch.map((r) => r.to))];
    // down: top first (smaller row index first); up: bottom first
    const order = (a: number, b: number) => (down ? a - b : b - a);
    pickups.sort(order);
    drops.sort(order);
    const start = Math.max(free, first.event);
    const stops: LiftStop[] = [{ row: at, arrive: start, depart: start }];
    const board: Record<string, number> = {};
    const alight: Record<string, number> = {};
    let t = start;
    let row = at;
    const visit = (target: number, waitFor: number) => {
      t += travelMs(rows, row, target);
      row = target;
      const arrive = t;
      const prev = stops.at(-1);
      // a pickup on the floor the cabin is already on: the doors simply open
      const depart = Math.max(arrive, waitFor) + DOOR_MS;
      if (prev && prev.row === target && prev.depart === arrive) {
        prev.depart = Math.max(prev.depart, depart);
      } else {
        stops.push({ row: target, arrive, depart });
      }
      t = Math.max(t, depart);
      return { arrive, depart };
    };
    for (const p of pickups) {
      const here = batch.filter((r) => r.from === p);
      const ready = Math.max(...here.map((r) => r.ready));
      const { arrive } = visit(p, ready);
      for (const r of here) board[r.rider] = Math.max(arrive, r.ready);
    }
    for (const d of drops) {
      const { arrive } = visit(d, -Infinity);
      for (const r of batch.filter((q) => q.to === d)) alight[r.rider] = arrive + Math.round(DOOR_MS / 2);
    }
    const end = stops.at(-1)?.depart ?? t;
    rides.push({ id: `ride:${rides.length}`, riders: batch.map((r) => r.rider), stops, start, end, board, alight });
    at = row;
    free = end;
  }
  return { rides, rest };
}

export interface CabinState {
  /** The cabin floor's y. */
  y: number;
  doorsOpen: boolean;
  /** The ride under way, if any. */
  ride: LiftRide | null;
}

/** Where the cabin is at display time `t`. */
export function cabinAt(plan: LiftPlan, rows: readonly Row[], t: number): CabinState {
  const yOf = (r: number) => rows[r]?.floor ?? 0;
  let row = plan.rest;
  for (const ride of plan.rides) {
    if (t < ride.start) return { y: yOf(row), doorsOpen: false, ride: null };
    if (t <= ride.end) {
      for (let k = 0; k < ride.stops.length; k++) {
        const s = ride.stops[k] as LiftStop;
        if (t <= s.depart) {
          if (t >= s.arrive) return { y: yOf(s.row), doorsOpen: s.depart > s.arrive, ride };
          const prev = ride.stops[k - 1] as LiftStop;
          const f = (t - prev.depart) / Math.max(1, s.arrive - prev.depart);
          return { y: yOf(prev.row) + (yOf(s.row) - yOf(prev.row)) * easeInOut(f), doorsOpen: false, ride };
        }
      }
    }
    row = ride.stops.at(-1)?.row ?? row;
  }
  return { y: yOf(row), doorsOpen: false, ride: null };
}

/** The landing floor nearest a cabin position (the cabin's own y when there are no floors). */
export function nearestFloor(rows: readonly { floor: number }[], y: number): number {
  let best: number | null = null;
  for (const r of rows) if (best === null || Math.abs(r.floor - y) < Math.abs(best - y)) best = r.floor;
  return best ?? y;
}

export function easeInOut(f: number): number {
  const v = Math.min(1, Math.max(0, f));
  return v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2;
}

/* ------------------------------------------------------------------------------------------------ tubes */

/**
 * A capsule's way from one desk's tube receiver to another's: up the sender's drop, along its ceiling pipe to the
 * trunk, along the trunk to the recipient's floor, along that ceiling, down the recipient's drop. On one floor it
 * stays under that ceiling. `"board"` ends at the penthouse table.
 */
export function tubePath(layout: TowerLayout, from: string, to: string): Pt[] | null {
  const a = layout.seats[from];
  const b = to === "board" ? null : layout.seats[to];
  if (!a || (to !== "board" && !b)) return null;
  const rowA = layout.rows[a.row] as Row;
  const end = b ? b.station : { x: layout.table.x, y: layout.table.y };
  const rowB = layout.rows[b ? b.row : layout.roof] as Row;
  const start = a.station;
  if (rowA.index === rowB.index) {
    return dedupe([start, { x: start.x, y: rowA.pipe }, { x: end.x, y: rowA.pipe }, end]);
  }
  return dedupe([start, { x: start.x, y: rowA.pipe }, { x: X.trunk, y: rowA.pipe }, { x: X.trunk, y: rowB.pipe }, { x: end.x, y: rowB.pipe }, end]);
}

function dedupe(path: Pt[]): Pt[] {
  return path.filter((p, i) => i === 0 || p.x !== path[i - 1]?.x || p.y !== path[i - 1]?.y);
}

/** The first `f` (0..1, by length) of a path: a jammed capsule's way. */
export function cutPath(path: readonly Pt[], f: number): Pt[] {
  const first = path[0];
  if (!first || path.length < 2) return [...path];
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - (path[i]?.x ?? 0), p.y - (path[i]?.y ?? 0)));
  let left = Math.min(1, Math.max(0, f)) * lens.reduce((a, b) => a + b, 0);
  const out: Pt[] = [first];
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i] ?? 0;
    const a = path[i] ?? first;
    const b = path[i + 1] ?? first;
    if (left >= len) {
      out.push(b);
      left -= len;
      continue;
    }
    const k = len === 0 ? 0 : left / len;
    out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    break;
  }
  return dedupe(out);
}
