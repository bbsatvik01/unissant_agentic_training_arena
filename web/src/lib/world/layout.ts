/**
 * The world's fixed geometry and camera shots (D-020, D-025), in metres. The scene components place their meshes
 * from these constants and the camera rig moves between these shots, so the layout and the choreography cannot
 * drift apart.
 *
 * The precinct hub sits around the origin. A door in its back wall opens on a corridor that ends at the interview
 * room's door; the room's origin is `ROOM`. In the room the back wall carries the evidence wall (left) and the
 * one-way mirror (right), with the observation room behind the mirror; the subject sits across the table from the
 * investigator's empty chair, which the over-the-shoulder shot looks past.
 */

export type Vec3 = readonly [number, number, number];

export interface Shot {
  readonly position: Vec3;
  readonly target: Vec3;
  /** Vertical field of view in degrees (a longer lens for close-ups). */
  readonly fov: number;
}

/** Hub size and the door in its back wall. */
export const HUB = { width: 16, depth: 12, height: 3.4 } as const;
export const HUB_DOOR_X = 4;

/** Interview room interior, local to `ROOM`; its door is in the front wall at `ROOM_DOOR_X`. */
export const ROOM_SIZE = { width: 6.4, depth: 6, height: 2.9 } as const;
export const ROOM_DOOR_X = -1.8;
export const ROOM: Vec3 = [HUB_DOOR_X - ROOM_DOOR_X, 0, -22];

export const EVIDENCE_WALL = { center: [-1.75, 1.6, -2.97] as Vec3, width: 2.3, height: 1.3, columns: 5, rows: 2 } as const;
export const MIRROR = { center: [1.65, 1.6, -3] as Vec3, width: 2.5, height: 1.3 } as const;
export const TABLE = { center: [0, 0.75, 0] as Vec3, width: 1.6, depth: 0.9 } as const;
export const SUBJECT_SEAT: Vec3 = [0, 0, -0.78];
export const INVESTIGATOR_SEAT: Vec3 = [0, 0, 0.85];
export const PET_SPOT: Vec3 = [0.62, 0.775, 0.3];
export const FOLDER_SPOT: Vec3 = [-0.32, 0.775, 0.22];
/** The point the subject looks at when looking at the investigator (eye height over the empty chair). */
export const INVESTIGATOR_EYES: Vec3 = [0, 1.22, 0.95];
/** Coach desks in the observation room (local to `ROOM`), left to right as seen through the mirror. */
export const COACH_DESKS: readonly Vec3[] = [
  [0.7, 0, -5.0],
  [1.65, 0, -5.25],
  [2.6, 0, -5.0],
];

/** Hub: the case board on the back wall, its files laid out in a grid. */
export const CASE_BOARD = { center: [-1.6, 1.75, -5.93] as Vec3, width: 5.2, height: 2.3, columns: 3, rows: 2 } as const;

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** A point local to the interview room, in world space. */
export function inRoom(local: Vec3): Vec3 {
  return add(ROOM, local);
}

/** Where file `index` sits on the hub's case board (world space, on the board's face). */
export function caseSlot(index: number): Vec3 {
  const { center, width, height, columns, rows } = CASE_BOARD;
  const col = index % columns;
  const row = Math.floor(index / columns) % rows;
  const x = center[0] - width / 2 + (width / columns) * (col + 0.5);
  const y = center[1] + height / 2 - (height / rows) * (row + 0.5);
  return [x, y, center[2] + 0.04];
}

/** Where paper `index` pins on the evidence wall (local to `ROOM`). Papers past the grid overlap the last slot. */
export function evidenceSlot(index: number): Vec3 {
  const { center, width, height, columns, rows } = EVIDENCE_WALL;
  const slot = Math.min(index, columns * rows - 1);
  const col = slot % columns;
  const row = Math.floor(slot / columns);
  const x = center[0] - width / 2 + (width / columns) * (col + 0.5);
  const y = center[1] + height / 2 - (height / rows) * (row + 0.5);
  return [x, y, center[2] + 0.03];
}

export type ShotName =
  | "hub"
  | "board"
  | "hall_door"
  | "corridor"
  | "room_door"
  | "room"
  | "over_shoulder"
  | "subject_close"
  | "observation"
  | "wall"
  | "table";

export const SHOTS: Readonly<Record<ShotName, Shot>> = {
  hub: { position: [6.4, 2.25, 4.9], target: [-1.2, 1.35, -5.2], fov: 46 },
  board: { position: [-1.6, 1.8, -2.2], target: [-1.6, 1.75, -6], fov: 45 },
  hall_door: { position: [HUB_DOOR_X, 1.65, -4.6], target: [HUB_DOOR_X, 1.6, -12], fov: 50 },
  corridor: { position: [HUB_DOOR_X, 1.65, -15.5], target: [HUB_DOOR_X, 1.5, -22], fov: 50 },
  room_door: { position: inRoom([ROOM_DOOR_X, 1.65, 2.6]), target: inRoom([-0.6, 1.2, -1.2]), fov: 50 },
  room: { position: inRoom([-0.9, 1.95, 2.55]), target: inRoom([0.45, 1.05, -1.8]), fov: 48 },
  over_shoulder: { position: inRoom([0.42, 1.42, 1.72]), target: inRoom([0, 1.16, -0.8]), fov: 34 },
  subject_close: { position: inRoom([0.22, 1.3, 0.62]), target: inRoom([0, 1.12, -0.8]), fov: 30 },
  observation: { position: inRoom([0.15, 1.75, -3.55]), target: inRoom([1.75, 1.0, -5.0]), fov: 46 },
  wall: { position: inRoom([-1.6, 1.55, 0.1]), target: inRoom([-1.75, 1.5, -3]), fov: 40 },
  table: { position: inRoom([0.35, 1.5, 0.78]), target: inRoom([-0.18, 0.78, 0.12]), fov: 38 },
};

/** The waypoints of the flight from the hub into the interview room (case open, a signature moment). */
export const FLIGHT_TO_ROOM: readonly ShotName[] = ["board", "hall_door", "corridor", "room_door", "room"];
/** And back out to the precinct. */
export const FLIGHT_TO_HUB: readonly ShotName[] = ["room_door", "corridor", "hall_door", "hub"];
