/**
 * The Bid Tower's building: a side-view cutaway in native units (`SCENE_W` wide), read top to bottom.
 *
 * - Roof: the penthouse board room (S10) beside the lift, and the decision deck (S11-S15, the H2 podium and bell).
 * - Upper floor: the red-team den and the home office (analyst, the home lane's researcher, the interview board).
 * - One floor per rival, in the office plan's pod order: the researcher's desk by the lift, the pricing, technical
 *   and past-performance desks, the capture lead's glass office and an in-tray. A building has at least
 *   `MIN_FLOORS` rival floors; one with no rival reads "Vacant".
 * - Ground floor: the lobby (street doors, the S0-S3 props), the S6 dossier presses, the S7 notary booth and the
 *   S8 price-to-win ledger.
 * - B1: the Records archive behind the H1 security gate (one CRT carrel per research lane) and the machine room
 *   (one server rack per model endpoint).
 *
 * A lift shaft runs down the left side, a brass tube trunk beside it, and a riser up the right wall. Pure geometry:
 * the view, the routes and the tests read the same numbers.
 */
import type { OfficePlan, Role } from "../office";

export const SCENE_W = 1200;
export const ROOF_H = 128;
export const ROW_H = 64;
export const GROUND_H = 72;
export const BASE_H = 76;
export const FOOT_H = 10;
export const SLAB = 4;
export const MIN_FLOORS = 4;
export const MAX_FLOORS = 8;
/** The building is drawn for six rivals (the product's team colours) whatever the plan holds, so its height never
 *  tells how many rivals a run has before the plan names them; more than six adds floors. */
export const BUILT_FLOORS = 6;

/** Columns: the outer walls, the lift shaft (its landing door on the right), the tube trunk, the interior, the riser. */
export const X = {
  wallL: 16,
  shaft0: 24,
  shaft1: 76,
  /** The shaft's landing door: riders step in and out here. */
  door: 84,
  cabin: 50,
  trunk: 88,
  in0: 96,
  in1: 1150,
  riser: 1158,
  wallR: 1176,
} as const;

export const CABIN_W = 44;
export const CABIN_H = 50;

/** An archive carrel's CRT on its stand, as heights above the basement's floor line (screen inside the body). */
export const CRT = { top: 62, bottom: 40, half: 15, screenTop: 59, screenBottom: 44, screenHalf: 12 } as const;

export type RowKind = "roof" | "upper" | "rival" | "ground" | "basement";

export interface Row {
  index: number;
  kind: RowKind;
  /** Ceiling (for the roof: the top of the sky band). */
  top: number;
  /** Where feet stand. */
  floor: number;
  /** The slab's underside: the next row's ceiling. */
  bottom: number;
  /** The tube pipe under this row's ceiling. */
  pipe: number;
  /** Rival floors: the pod key, or null for a vacant floor. */
  pod: string | null;
  /** The floor's number as a sign reads it ("R", "6F", "G", "B1"). */
  label: string;
}

export type RoomId = "penthouse" | "deck" | "red" | "home" | "lobby" | "dossier" | "notary" | "ledger" | "archive" | "machine" | `floor:${string}`;

export interface Room {
  id: RoomId;
  row: number;
  x0: number;
  x1: number;
  label: string;
}

export type Furniture = "desk" | "office" | "chair" | "booth";

export interface SeatSpot {
  id: string;
  row: number;
  /** The agent's centre line. */
  x: number;
  furniture: Furniture;
  /** The tube receiver beside the desk (where a capsule pops out). */
  station: { x: number; y: number };
}

export interface Carrel {
  slot: number;
  x: number;
}

export interface Rack {
  slot: number;
  x: number;
}

export interface TowerLayout {
  w: number;
  h: number;
  rows: Row[];
  /** Row index by kind (rival rows by pod key). */
  roof: number;
  upper: number;
  ground: number;
  basement: number;
  rivalRows: number[];
  podRow: Record<string, number>;
  rooms: Room[];
  seats: Record<string, SeatSpot>;
  /** Seat ids the building has no place for (a seventh red-team agent and the like). */
  overflow: string[];
  carrels: Carrel[];
  racks: Rack[];
  /** The penthouse table's centre: a message to the board before its evaluators sit lands here. */
  table: { x: number; y: number };
  /** Ground floor: the street doors (evaluators walk in here) and the notary booth's parts. */
  doors: { x: number };
}

/** Seat offsets on a rival floor, by role. */
export const RIVAL_X: Record<string, number> = {
  researcher: 168,
  pricing: 300,
  technical: 392,
  past_performance: 484,
  capture_lead: 680,
};
export const RIVAL_EXTRA_X: readonly number[] = [860, 944, 1028];
/** The glass partition in front of the capture lead's office, and the in-tray beside it. */
export const PARTITION_X = 580;
export const TRAY_X = 762;
export const RED_X: readonly number[] = [196, 288, 380];
export const ANALYST_X = 700;
export const HOME_LANE_X = 792;
export const BOARD_X: readonly number[] = [262, 382, 502];
export const VERIFIER_X = 716;
export const CARREL_X: readonly number[] = [148, 226, 304, 382, 460, 538];
export const RACK_X: readonly number[] = [690, 766, 842, 918, 994, 1070];

/** The rows of a building with `floors` rival floors (pods fill them from the top; the rest are vacant). */
export function buildRows(pods: readonly string[], floors: number): Row[] {
  const rows: Row[] = [];
  const add = (kind: RowKind, h: number, label: string, pod: string | null) => {
    const top = rows.at(-1)?.bottom ?? 0;
    const bottom = top + h;
    rows.push({ index: rows.length, kind, top, floor: bottom - SLAB, bottom, pipe: kind === "roof" ? 58 : top + 7, pod, label });
  };
  add("roof", ROOF_H, "R", null);
  add("upper", ROW_H, `${floors + 1}F`, null);
  for (let i = 0; i < floors; i++) add("rival", ROW_H, `${floors - i}F`, pods[i] ?? null);
  add("ground", GROUND_H, "G", null);
  add("basement", BASE_H, "B1", null);
  return rows;
}

function spot(id: string, row: Row, x: number, furniture: Furniture): SeatSpot {
  return { id, row: row.index, x, furniture, station: { x: x + 30, y: row.floor - 34 } };
}

/** Where each of the plan's seats sits in the building. */
export function buildTower(plan: OfficePlan): TowerLayout {
  const floors = Math.min(MAX_FLOORS, Math.max(MIN_FLOORS, BUILT_FLOORS, plan.pods.length));
  const pods = plan.pods.slice(0, floors).map((p) => p.key);
  const rows = buildRows(pods, floors);
  const roof = 0;
  const upper = 1;
  const rivalRows = rows.filter((r) => r.kind === "rival").map((r) => r.index);
  const ground = rows.length - 2;
  const basement = rows.length - 1;
  const podRow: Record<string, number> = {};
  pods.forEach((key, i) => {
    const row = rivalRows[i];
    if (row !== undefined) podRow[key] = row;
  });

  const seats: Record<string, SeatSpot> = {};
  const overflow: string[] = [];
  const rowAt = (i: number) => rows[i] as Row;
  for (const id of plan.order) {
    const seat = plan.seats[id];
    if (!seat) continue;
    let placed: SeatSpot | null = null;
    if (seat.zone === "pod" && seat.pod !== null && podRow[seat.pod] !== undefined) {
      const row = rowAt(podRow[seat.pod] ?? upper);
      const extra = /:x(\d)$/.exec(id);
      const x = extra ? RIVAL_EXTRA_X[Number(extra[1])] : RIVAL_X[roleSlot(seat.role, id)];
      if (x !== undefined) placed = spot(id, row, x, seat.role === "capture_lead" && !extra ? "office" : "desk");
    } else if (seat.zone === "red_team") {
      const k = id === "red_team" ? 0 : Number(id.split(":")[1] ?? "9");
      const x = RED_X[k];
      if (x !== undefined) placed = spot(id, rowAt(upper), x, "desk");
    } else if (seat.zone === "analyst") {
      placed = spot(id, rowAt(upper), seat.role === "researcher" ? HOME_LANE_X : ANALYST_X, "desk");
    } else if (seat.zone === "board") {
      const x = BOARD_X[Number(id.split(":")[1] ?? "9")];
      if (x !== undefined) placed = spot(id, rowAt(roof), x, "chair");
    } else if (seat.zone === "verify") {
      placed = spot(id, rowAt(ground), VERIFIER_X, "booth");
    }
    if (placed) seats[id] = placed;
    else overflow.push(id);
  }

  const rooms: Room[] = [
    { id: "penthouse", row: roof, x0: X.in0, x1: 640, label: "Board room" },
    { id: "deck", row: roof, x0: 652, x1: X.in1, label: "Decision deck" },
    { id: "red", row: upper, x0: X.in0, x1: 596, label: "Red team" },
    { id: "home", row: upper, x0: 604, x1: X.in1, label: "Home office" },
    ...rivalRows.map((r): Room => {
      const row = rowAt(r);
      return { id: `floor:${row.pod ?? row.label}`, row: r, x0: X.in0, x1: X.in1, label: row.pod ?? "Vacant" };
    }),
    { id: "lobby", row: ground, x0: X.in0, x1: 420, label: "Lobby" },
    { id: "dossier", row: ground, x0: 428, x1: 600, label: "Dossier presses" },
    { id: "notary", row: ground, x0: 608, x1: 900, label: "Notary booth" },
    { id: "ledger", row: ground, x0: 908, x1: X.in1, label: "Price to win" },
    { id: "archive", row: basement, x0: X.in0, x1: 640, label: "Records archive" },
    { id: "machine", row: basement, x0: 648, x1: X.in1, label: "Machine room" },
  ];
  const last = rowAt(basement);
  return {
    w: SCENE_W,
    h: last.bottom + FOOT_H,
    rows,
    roof,
    upper,
    ground,
    basement,
    rivalRows,
    podRow,
    rooms,
    seats,
    overflow,
    carrels: CARREL_X.map((x, slot) => ({ slot, x })),
    racks: RACK_X.map((x, slot) => ({ slot, x })),
    table: { x: 382, y: rowAt(roof).floor - 22 },
    doors: { x: 112 },
  };
}

function roleSlot(role: Role, id: string): string {
  return id.endsWith(":lane") ? "researcher" : role;
}

/** The row a seat sits on, its floor line and the room it belongs to. */
export function roomOf(layout: TowerLayout, row: number, x: number): Room | null {
  return layout.rooms.find((r) => r.row === row && x >= r.x0 && x <= r.x1) ?? null;
}

/** Points on the scene as percentages of its box (DOM overlays share the SVG's coordinates this way). */
export function pct(layout: Pick<TowerLayout, "w" | "h">, x: number, y: number): { left: string; top: string } {
  return { left: `${round2((x / layout.w) * 100)}%`, top: `${round2((y / layout.h) * 100)}%` };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
