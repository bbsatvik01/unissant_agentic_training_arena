import { describe, expect, it } from "vitest";

import {
  controllerDeadzone, EYE_HEIGHT, findWaypointRoute, hasLineOfSight, inputMovement, isWalkable,
  MAX_FRAME_SECONDS, MAX_PITCH, moveWithCollisions, nearestHotspot, nextCameraMode, PLAYER_HEIGHT,
  PLAYER_RADIUS, SPRINT_SPEED, turn, WALK_SPEED,
} from "./movement";
import type { Collider, Hotspot, NavigationNode, Vec3 } from "./types";

const WALL: Collider = { id: "wall", min: [-1, 0, -2], max: [1, 3, 2] };
const FLOOR: Collider = { id: "floor", min: [-20, -0.2, -40], max: [20, 0, 4] };
const CEILING: Collider = { id: "ceiling", min: [-20, 3, -40], max: [20, 3.2, 4] };
const START: Vec3 = [-4, 0, 0];
const DESTINATION: Vec3 = [4, 0, 0];
const NODES: readonly NavigationNode[] = [
  { id: "north-west", position: [-2, 0, -3], neighbors: ["north-east"] },
  { id: "north-east", position: [2, 0, -3], neighbors: ["north-west"] },
  { id: "south-west", position: [-2, 0, 5], neighbors: ["south-east"] },
  { id: "south-east", position: [2, 0, 5], neighbors: ["south-west"] },
];

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[2]);
}

function hotspot(id: string, position: Vec3, radius = 1.5): Hotspot {
  return { id, label: id, room: "training", position, radius };
}

describe("precinct input", () => {
  it("uses metres and eye height independently of player collision height", () => {
    expect(EYE_HEIGHT).toBe(1.65);
    expect(PLAYER_HEIGHT).toBe(1.8);
    expect(PLAYER_RADIUS).toBe(0.28);
  });

  it("faces north at yaw zero and moves right when strafing positively", () => {
    const north = inputMovement(1, 0, 0, false, 0.04);
    expect(north[0]).toBe(0);
    expect(north[1]).toBe(0);
    expect(north[2]).toBeCloseTo(-WALK_SPEED * 0.04);
    const east = inputMovement(0, 1, 0, false, 0.04);
    expect(east[0]).toBeCloseTo(WALK_SPEED * 0.04);
    expect(east[2]).toBeCloseTo(0);
    expect(inputMovement(-1, 0, 0, false, 0.04)[2]).toBeGreaterThan(0);
  });

  it("rotates movement with the camera's Three-compatible yaw", () => {
    const west = inputMovement(1, 0, Math.PI / 2, false, 0.05);
    expect(west[0]).toBeCloseTo(-0.12);
    expect(west[2]).toBeCloseTo(0);
    const northStrafe = inputMovement(0, 1, Math.PI / 2, false, 0.05);
    expect(northStrafe[0]).toBeCloseTo(0);
    expect(northStrafe[2]).toBeCloseTo(-0.12);
  });

  it("normalizes diagonal input, retains analog speed and caps frame deltas", () => {
    expect(length(inputMovement(1, 1, 0, false, 0.05))).toBeCloseTo(WALK_SPEED * 0.05);
    expect(length(inputMovement(0.5, 0, 0, false, 0.05))).toBeCloseTo(WALK_SPEED * 0.025);
    expect(length(inputMovement(1, 1, 0, true, 10))).toBeCloseTo(SPRINT_SPEED * MAX_FRAME_SECONDS);
    expect(length(inputMovement(100, 100, 0, false, 0.05))).toBeCloseTo(0.12);
  });

  it("stops for absent, negative or invalid frame time and invalid input", () => {
    for (const dt of [0, -1, NaN, Infinity]) expect(length(inputMovement(1, 1, 0, false, dt))).toBe(0);
    expect(length(inputMovement(NaN, Infinity, 0, false, 0.05))).toBe(0);
    expect(inputMovement(1, 0, NaN, false, 0.05)[2]).toBeCloseTo(-0.12);
  });

  it("removes stick drift and rescales the analog range radially", () => {
    expect(controllerDeadzone(0, 0)).toEqual([0, 0]);
    expect(controllerDeadzone(0.1, -0.1)).toEqual([0, 0]);
    expect(controllerDeadzone(0.18, 0)).toEqual([0, 0]);
    expect(controllerDeadzone(0.59, 0)[0]).toBeCloseTo(0.5);
    expect(controllerDeadzone(0, -1)).toEqual([0, -1]);
    expect(Math.hypot(...controllerDeadzone(1, 1))).toBeCloseTo(1);
  });

  it("bounds deadzone configuration and ignores non-finite controller values", () => {
    expect(controllerDeadzone(NaN, Infinity)).toEqual([0, 0]);
    expect(controllerDeadzone(0.5, 0, -1)).toEqual([0.5, 0]);
    expect(controllerDeadzone(0.5, 0, NaN)).toEqual([0.5, 0]);
    expect(controllerDeadzone(0.9, 0, 1)).toEqual([0, 0]);
    expect(controllerDeadzone(2, 0)).toEqual([1, 0]);
  });
});

describe("precinct camera controls", () => {
  it("clamps looking up/down without restricting yaw turns", () => {
    const up = turn({ yaw: 0, pitch: 0 }, Math.PI * 4 + 0.2, 9);
    expect(up.yaw).toBeCloseTo(0.2);
    expect(up.pitch).toBe(MAX_PITCH);
    const down = turn({ yaw: 0, pitch: 0 }, -Math.PI * 4 - 0.2, -9);
    expect(down.yaw).toBeCloseTo(-0.2);
    expect(down.pitch).toBe(-MAX_PITCH);
    expect(turn({ yaw: NaN, pitch: NaN }, Infinity, NaN)).toEqual({ yaw: 0, pitch: 0 });
  });

  it("cycles first/third during play and includes inspection only while paused", () => {
    expect(nextCameraMode("first", false)).toBe("third");
    expect(nextCameraMode("third", false)).toBe("first");
    expect(nextCameraMode("free", false)).toBe("first");
    expect(nextCameraMode("first", true)).toBe("third");
    expect(nextCameraMode("third", true)).toBe("free");
    expect(nextCameraMode("free", true)).toBe("first");
  });
});

describe("precinct collisions", () => {
  it("moves freely on the ground and never changes foot height", () => {
    const position: Vec3 = [-6, 0, -6];
    const result = moveWithCollisions(position, [1, 10, 2], [FLOOR, CEILING]);
    expect(result[0]).toBeCloseTo(-5);
    expect(result[1]).toBe(0);
    expect(result[2]).toBeCloseTo(-4);
    expect(position).toEqual([-6, 0, -6]);
  });

  it("stops against all four sides of a wall at the player radius", () => {
    expect(moveWithCollisions([-4, 0, 0], [8, 0, 0], [WALL])[0]).toBeCloseTo(-1.28);
    expect(moveWithCollisions([4, 0, 0], [-8, 0, 0], [WALL])[0]).toBeCloseTo(1.28);
    expect(moveWithCollisions([0, 0, -4], [0, 0, 8], [WALL])[2]).toBeCloseTo(-2.28);
    expect(moveWithCollisions([0, 0, 4], [0, 0, -8], [WALL])[2]).toBeCloseTo(2.28);
  });

  it("slides along walls without sticking or crossing a wall", () => {
    const result = moveWithCollisions([-2, 0, 0], [2, 0, 1], [WALL]);
    expect(result[0]).toBeCloseTo(-1.28);
    expect(result[2]).toBeCloseTo(1);
    expect(isWalkable(result, [WALL])).toBe(true);
    expect(moveWithCollisions([-1.28, 0, 0], [0, 0, -1], [WALL])[2]).toBeCloseTo(-1);
  });

  it("sweeps thin walls even after the substep cap is reached", () => {
    const thin: Collider = { id: "thin", min: [0, 0, -100], max: [0.001, 3, 100] };
    expect(moveWithCollisions([-2, 0, 0], [100_000, 0, 0], [thin])[0]).toBeCloseTo(-0.28);
    expect(moveWithCollisions([2, 0, 0], [-100_000, 0, 0], [thin])[0]).toBeCloseTo(0.281);
    expect(moveWithCollisions([-2, 0, 0], [100_000, 0, 0], [thin], 0)[0]).toBe(0);
  });

  it("chooses the nearest collider regardless of manifest order", () => {
    const further: Collider = { id: "further", min: [3, 0, -2], max: [4, 3, 2] };
    expect(moveWithCollisions(START, [12, 0, 0], [further, WALL])[0]).toBeCloseTo(-1.28);
    expect(moveWithCollisions([8, 0, 0], [-12, 0, 0], [WALL, further])[0]).toBeCloseTo(4.28);
  });

  it("passes through a full-width doorway but blocks an undersized gap", () => {
    const doorway: readonly Collider[] = [
      { id: "left", min: [-3, 0, -1], max: [-0.6, 3, 0] },
      { id: "right", min: [0.6, 0, -1], max: [3, 3, 0] },
    ];
    expect(moveWithCollisions([0, 0, 1], [0, 0, -3], doorway)[2]).toBeCloseTo(-2);
    expect(moveWithCollisions([0.5, 0, 1], [0, 0, -3], doorway)[2]).toBeCloseTo(0.28);
    const narrow = doorway.map((collider) => collider.id === "left"
      ? { ...collider, max: [-0.2, 3, 0] as Vec3 }
      : { ...collider, min: [0.2, 0, -1] as Vec3 });
    expect(moveWithCollisions([0, 0, 1], [0, 0, -3], narrow)[2]).toBeCloseTo(0.28);
  });

  it("fails closed for an embedded spawn or invalid displacement", () => {
    const embedded: Vec3 = [0, 0, 0];
    expect(moveWithCollisions(embedded, [9, 0, 0], [WALL])).toBe(embedded);
    expect(moveWithCollisions(START, [NaN, 0, 0], [WALL])).toBe(START);
    expect(moveWithCollisions(START, [0, Infinity, 0], [WALL])).toBe(START);
    expect(isWalkable([NaN, 0, 0], [])).toBe(false);
    expect(moveWithCollisions(START, [0, 0, 0], [WALL])).toEqual(START);
  });

  it("handles contact boundaries, raised floors and custom radius safely", () => {
    expect(isWalkable([-1.28, 0, 0], [WALL])).toBe(true);
    expect(isWalkable([-1.27, 0, 0], [WALL])).toBe(false);
    expect(isWalkable([0, 3, 0], [WALL])).toBe(true);
    expect(isWalkable([0, 0, 0], [{ ...WALL, min: [-1, PLAYER_HEIGHT, -2] }])).toBe(true);
    expect(moveWithCollisions(START, [8, 0, 0], [WALL], 0.5)[0]).toBeCloseTo(-1.5);
    expect(moveWithCollisions(START, [8, 0, 0], [WALL], -1)[0]).toBeCloseTo(-1.28);
    expect(moveWithCollisions(START, [8, 0, 0], [WALL], NaN)[0]).toBeCloseTo(-1.28);
  });

  it("cannot leave the building through any perimeter wall even over repeated frames", () => {
    const perimeter: readonly Collider[] = [
      { id: "west", min: [-14.3, 0, -36.3], max: [-14, 4, 0.3] },
      { id: "east", min: [14, 0, -36.3], max: [14.3, 4, 0.3] },
      { id: "north", min: [-14.3, 0, -36.3], max: [14.3, 4, -36] },
      { id: "south", min: [-14.3, 0, 0], max: [14.3, 4, 0.3] },
    ];
    for (const displacement of [[5, 0, 5], [-5, 0, -5], [5, 0, -5], [-5, 0, 5]] as const) {
      let position: Vec3 = [0, 0, -18];
      for (let frame = 0; frame < 30; frame += 1) {
        position = moveWithCollisions(position, displacement, perimeter);
        expect(isWalkable(position, perimeter)).toBe(true);
        expect(position[0]).toBeGreaterThanOrEqual(-14 + PLAYER_RADIUS);
        expect(position[0]).toBeLessThanOrEqual(14 - PLAYER_RADIUS);
        expect(position[2]).toBeGreaterThanOrEqual(-36 + PLAYER_RADIUS);
        expect(position[2]).toBeLessThanOrEqual(-PLAYER_RADIUS);
      }
    }
  });
});

describe("precinct hotspot proximity", () => {
  it("returns the closest available hotspot and ignores out-of-range targets", () => {
    const far = hotspot("far", [3, 0, 0]);
    const near = hotspot("near", [0.5, 1.5, 0]);
    const middle = hotspot("middle", [1, 0, 0]);
    expect(nearestHotspot([0, 0, 0], [far, middle, near])).toBe(near);
    expect(nearestHotspot([0, 0, 0], [far])).toBeNull();
    expect(nearestHotspot([0, 0, 0], [])).toBeNull();
  });

  it("uses each hotspot's own radius, includes the boundary and preserves ties", () => {
    const exact = hotspot("exact", [1.5, 0, 0]);
    const tie = hotspot("tie", [-1.5, 0, 0]);
    expect(nearestHotspot([0, 0, 0], [exact, tie])).toBe(exact);
    expect(nearestHotspot([0, 0, 0], [hotspot("small", [1, 0, 0], 0.5)])).toBeNull();
    expect(nearestHotspot([NaN, 0, 0], [exact])).toBeNull();
  });
});

describe("precinct navigation visibility", () => {
  it("rejects blocked segments in either direction and permits clear parallel paths", () => {
    expect(hasLineOfSight(START, DESTINATION, [WALL])).toBe(false);
    expect(hasLineOfSight(DESTINATION, START, [WALL])).toBe(false);
    expect(hasLineOfSight([-2, 0, -3], [2, 0, -3], [WALL])).toBe(true);
    expect(hasLineOfSight([-2, 0, 3], [2, 0, 3], [WALL])).toBe(true);
    expect(hasLineOfSight([-2, 0, -3], [-2, 0, 3], [WALL])).toBe(true);
    expect(hasLineOfSight([2, 0, -3], [2, 0, 3], [WALL])).toBe(true);
    expect(hasLineOfSight([0, 0, -3], [0, 0, 3], [WALL])).toBe(false);
  });

  it("checks the player's width instead of allowing a point path to scrape a corner", () => {
    expect(hasLineOfSight([-4, 0, -2.1], [4, 0, -2.1], [WALL])).toBe(false);
    expect(hasLineOfSight([-4, 0, -2.28], [4, 0, -2.28], [WALL])).toBe(true);
    expect(hasLineOfSight([-4, 0, -2.1], [4, 0, -2.1], [WALL], 0)).toBe(true);
    expect(hasLineOfSight([-4, 0, -3], [4, 0, 3], [WALL])).toBe(false);
  });

  it("rejects embedded endpoints and vertical paths, but ignores floors and overhead surfaces", () => {
    expect(hasLineOfSight([0, 0, 0], START, [WALL])).toBe(false);
    expect(hasLineOfSight(START, [0, 0, 0], [WALL])).toBe(false);
    expect(hasLineOfSight(START, [4, 1, 0], [])).toBe(false);
    expect(hasLineOfSight(START, DESTINATION, [FLOOR, CEILING])).toBe(true);
    expect(hasLineOfSight(START, START, [WALL])).toBe(true);
    expect(hasLineOfSight([0, 0, -3], [0, 0, -4], [WALL])).toBe(true);
    expect(hasLineOfSight([0, 0, 3], [0, 0, 4], [WALL])).toBe(true);
  });
});

describe("precinct waypoint routes", () => {
  it("returns a direct safe route or an empty already-arrived route", () => {
    expect(findWaypointRoute(START, DESTINATION, [], [])).toEqual([DESTINATION]);
    expect(findWaypointRoute(START, START, NODES, [WALL])).toEqual([]);
  });

  it("selects the shortest collision-safe graph route, not the first listed route", () => {
    const route = findWaypointRoute(START, DESTINATION, [...NODES].reverse(), [WALL]);
    expect(route).toEqual([[-2, 0, -3], [2, 0, -3], DESTINATION]);
    let previous = START;
    for (const position of route ?? []) {
      expect(hasLineOfSight(previous, position, [WALL])).toBe(true);
      previous = position;
    }
    expect(findWaypointRoute(DESTINATION, START, NODES, [WALL])).toEqual([[2, 0, -3], [-2, 0, -3], START]);
  });

  it("returns null when no safe route exists instead of snapping through walls", () => {
    expect(findWaypointRoute(START, DESTINATION, [], [WALL])).toBeNull();
    expect(findWaypointRoute(START, DESTINATION, NODES.map((node) => ({ ...node, neighbors: [] })), [WALL])).toBeNull();
    expect(findWaypointRoute([0, 0, 0], DESTINATION, NODES, [WALL])).toBeNull();
    expect(findWaypointRoute(START, [0, 0, 0], NODES, [WALL])).toBeNull();
    expect(findWaypointRoute(START, [4, 1, 0], NODES, [WALL])).toBeNull();
    expect(findWaypointRoute([NaN, 0, 0], DESTINATION, NODES, [WALL])).toBeNull();
  });

  it("honors directed links and ignores broken or obstructed links", () => {
    const directed: readonly NavigationNode[] = [
      { id: "left", position: [-2, 0, -3], neighbors: ["missing", "embedded", "right"] },
      { id: "right", position: [2, 0, -3], neighbors: [] },
      { id: "embedded", position: [0, 0, 0], neighbors: ["right"] },
    ];
    expect(findWaypointRoute(START, DESTINATION, directed, [WALL])).toEqual([[-2, 0, -3], [2, 0, -3], DESTINATION]);
    expect(findWaypointRoute(DESTINATION, START, directed, [WALL])).toBeNull();
    const crossing: readonly NavigationNode[] = [
      { id: "left", position: [-2, 0, 0], neighbors: ["right"] },
      { id: "right", position: [2, 0, 0], neighbors: [] },
    ];
    expect(findWaypointRoute(START, DESTINATION, crossing, [WALL])).toBeNull();
  });

  it("rejects paths through gaps smaller than the configured player's footprint", () => {
    expect(findWaypointRoute([-4, 0, -2.1], [4, 0, -2.1], [], [WALL])).toBeNull();
    expect(findWaypointRoute([-4, 0, -2.1], [4, 0, -2.1], [], [WALL], 0)).toEqual([[4, 0, -2.1]]);
  });
});
