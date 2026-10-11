/**
 * The world's fixed geometry and camera shots (D-020), in metres. The scene components place their meshes from
 * these constants and the camera rig flies between these shots, so the layout and the choreography cannot drift.
 *
 * The precinct hub sits around the origin; a corridor leaves through a door in its back wall to the interview room,
 * whose origin is `ROOM`. In the room, the back wall carries the evidence wall (left) and the one-way mirror
 * (right), with the observation room behind the mirror; the subject sits across the table from the investigator's
 * seat, which the camera looks over.
 */

export type Vec3 = readonly [number, number, number];

export interface Shot {
  readonly position: Vec3;
  readonly target: Vec3;
}

export const HUB_DOOR_X = 4;
export const ROOM: Vec3 = [HUB_DOOR_X, 0, -22];

/** Interview room interior, local to `ROOM`. */
export const ROOM_SIZE = { width: 6, depth: 7, height: 3 } as const;
export const EVIDENCE_WALL = { center: [-1.6, 1.62, -3.47] as Vec3, width: 2.5, height: 1.5, columns: 5, rows: 2 } as const;
export const MIRROR = { center: [1.5, 1.62, -3.5] as Vec3, width: 2.6, height: 1.4 } as const;
export const TABLE = { center: [0.2, 0.74, 0.2] as Vec3, width: 1.8, depth: 1.0 } as const;
export const SUBJECT_SEAT: Vec3 = [0.2, 0, -0.75];
export const INVESTIGATOR_SEAT: Vec3 = [0.2, 0, 1.25];
export const PET_SPOT: Vec3 = [0.92, 0.77, 0.52];
export const FOLDER_SPOT: Vec3 = [-0.3, 0.775, 0.42];
/** Coach desks in the observation room (local to `ROOM`), left to right as seen through the mirror. */
export const COACH_DESKS: readonly Vec3[] = [
  [0.6, 0, -5.3],
  [1.5, 0, -5.6],
  [2.4, 0, -5.3],
];

/** Hub: the case board on the back wall, its files laid out in a grid. */
export const CASE_BOARD = { center: [-1.0, 1.85, -5.92] as Vec3, width: 5.6, height: 2.6, columns: 3, rows: 2 } as const;

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

export type ShotName = "hub" | "board" | "hall_door" | "corridor" | "room" | "wall" | "mirror" | "table";

export const SHOTS: Readonly<Record<ShotName, Shot>> = {
  hub: { position: [0.5, 2.5, 7.2], target: [0.5, 1.7, -6] },
  board: { position: [-0.6, 1.9, -1.6], target: [-0.6, 1.85, -6] },
  hall_door: { position: [HUB_DOOR_X, 1.7, -3.4], target: [HUB_DOOR_X, 1.6, -12] },
  corridor: { position: [HUB_DOOR_X, 1.7, -14], target: [HUB_DOOR_X, 1.5, -24] },
  room: { position: inRoom([-0.1, 2.05, 4.6]), target: inRoom([0.25, 1.25, -3.4]) },
  wall: { position: inRoom([-1.6, 1.7, -0.4]), target: inRoom([-1.6, 1.6, -3.5]) },
  mirror: { position: inRoom([1.3, 1.65, 0.6]), target: inRoom([1.5, 1.3, -5.4]) },
  table: { position: inRoom([0.1, 1.95, 1.75]), target: inRoom([0.0, 0.8, 0.1]) },
};

/** The waypoints of the flight from the hub into the interview room (case open, a signature moment). */
export const FLIGHT_TO_ROOM: readonly ShotName[] = ["board", "hall_door", "corridor", "room"];
/** And back out to the precinct. */
export const FLIGHT_TO_HUB: readonly ShotName[] = ["corridor", "hall_door", "hub"];
