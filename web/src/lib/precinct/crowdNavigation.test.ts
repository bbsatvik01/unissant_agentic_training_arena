import { describe, expect, it } from "vitest";
import { CROWD_CLEARANCE, CROWD_MAX_SPEED, CROWD_RETRY_SECONDS, CROWD_STUCK_SECONDS, createCrowd, moveWithPeople, reconcileCrowd, stepCrowd,
  type CrowdAgent, type CrowdDefinition, type CrowdPerson, type CrowdState, type CrowdWorld } from "./crowdNavigation";
import { hasLineOfSight, isWalkable, MAX_FRAME_SECONDS } from "./movement";
import type { Collider, Vec3 } from "./types";

const EMPTY: CrowdWorld = { colliders: [], navigationNodes: [], people: [] };
const FRAME = { delta: 0.05, paused: false, reducedMotion: false };
function walker(id = "a", position: Vec3 = [-3, 0, 0], destination: Vec3 = [3, 0, 0]): CrowdDefinition {
  return { id, position, yaw: -Math.PI / 2, radius: 0.34, speed: 0.85, stops: [{ position: destination, waitSeconds: 100 }] };
}
const separation = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function actor(state: CrowdState, id = "a"): CrowdAgent {
  const found = state.agents.find((value) => value.id === id);
  if (found === undefined) throw new Error(`Missing test actor ${id}`);
  return found;
}
function simulate(definitions: readonly CrowdDefinition[], world: CrowdWorld, frames: number, initial = createCrowd(definitions)): CrowdState {
  let state = initial;
  for (let frame = 0; frame < frames; frame += 1) {
    const next = stepCrowd(state, definitions, world, FRAME);
    for (const agent of next.agents) {
      const previous = actor(state, agent.id);
      expect(separation(previous.position, agent.position)).toBeLessThanOrEqual(CROWD_MAX_SPEED * MAX_FRAME_SECONDS + 1e-7);
      expect(agent.walkedDistance).toBeGreaterThanOrEqual(previous.walkedDistance);
      expect(hasLineOfSight(previous.position, agent.position, world.colliders, 0.34)).toBe(true);
      for (const person of world.people) expect(separation(agent.position, person.position)).toBeGreaterThanOrEqual(0.34 + person.radius + CROWD_CLEARANCE - 1e-7);
      for (const other of next.agents) if (other.id !== agent.id) expect(separation(agent.position, other.position)).toBeGreaterThanOrEqual(0.68 + CROWD_CLEARANCE - 1e-7);
    }
    state = next;
  }
  return state;
}

const WALL: Collider = { id: "wall", min: [-0.5, 0, -2], max: [0.5, 3, 2] };
const DOOR: readonly Collider[] = [
  { id: "left", min: [-4, 0, -0.2], max: [-0.6, 3, 0.2] },
  { id: "right", min: [0.6, 0, -0.2], max: [4, 3, 0.2] },
];

describe("collision-validated deterministic crowd routes", () => {
  it("uses graph edges to go around a real wall and checks every applied segment", () => {
    const definition = walker();
    const world: CrowdWorld = { ...EMPTY, colliders: [WALL], navigationNodes: [
      { id: "west", position: [-1, 0, -2.6], neighbors: ["east"] },
      { id: "east", position: [1, 0, -2.6], neighbors: ["west"] },
    ] };
    const state = simulate([definition], world, 400);
    expect(separation(actor(state).position, definition.stops[0]?.position ?? definition.position)).toBeLessThan(0.02);
    expect(actor(state).walkedDistance).toBeGreaterThan(7);
  });

  it("passes a full-width doorway with a staff footprint", () => {
    const definition = walker("a", [0, 0.03, 2], [0, 0.03, -2]);
    const state = simulate([definition], { ...EMPTY, colliders: DOOR }, 160);
    expect(actor(state).position[2]).toBeCloseTo(-2, 1);
  });

  it("refuses an undersized door rather than snapping or tunneling", () => {
    const narrow = DOOR.map((wall) => wall.id === "left"
      ? { ...wall, max: [-0.2, 3, 0.2] as Vec3 } : { ...wall, min: [0.2, 0, -0.2] as Vec3 });
    const definition = walker("a", [0, 0, 2], [0, 0, -2]);
    const state = simulate([definition], { ...EMPTY, colliders: narrow }, 200);
    expect(actor(state).position).toEqual(definition.position);
    expect(actor(state).status).toBe("blocked");
  });

  it("projects the flat graph to the authored foot height without changing that height", () => {
    const definition = walker("a", [-3, 0.03, 0], [3, 0.03, 0]);
    const state = stepCrowd(createCrowd([definition]), [definition], { ...EMPTY, colliders: [WALL], navigationNodes: [
      { id: "west", position: [-1, 0, -2.6], neighbors: ["east"] },
      { id: "east", position: [1, 0, -2.6], neighbors: [] },
    ] }, FRAME);
    expect(actor(state).route.length).toBeGreaterThan(1);
    expect(actor(state).route.every((point) => point[1] === 0.03)).toBe(true);
    expect(actor(state).position[1]).toBe(0.03);
  });

  it("holds invalid embedded or nonfinite starts and never invents a rescue teleport", () => {
    for (const position of [[0, 0, 0], [NaN, 0, 0]] as const) {
      const definition = walker("a", position);
      const state = stepCrowd(createCrowd([definition]), [definition], { ...EMPTY, colliders: [WALL] }, FRAME);
      expect(actor(state).position).toEqual(position);
      expect(actor(state).status).toBe("invalid-start");
      expect(actor(state).speed).toBe(0);
    }
  });
});

describe("people, player and reciprocal avoidance", () => {
  it("passes a stationary colleague with positive clearance and no pushes", () => {
    const moving = walker();
    const fixed: CrowdDefinition = { ...walker("b", [0, 0, 0]), stops: [], speed: 0 };
    const result = simulate([moving, fixed], EMPTY, 320);
    expect(actor(result, "a").position[0]).toBeGreaterThan(2.98);
    expect(actor(result, "b").position).toEqual(fixed.position);
  });

  it("passes a stationary player without modifying the player input", () => {
    const player: CrowdPerson = Object.freeze({ id: "player", position: [0, 0, 0] as Vec3, radius: 0.28 });
    const result = simulate([walker()], { ...EMPTY, people: [player] }, 320);
    expect(actor(result).position[0]).toBeGreaterThan(2.98);
    expect(player.position).toEqual([0, 0, 0]);
  });

  it("takes reciprocal passing sides without crossing or exchanging identities", () => {
    const definitions = [walker("a"), { ...walker("b", [3, 0, 0], [-3, 0, 0]), yaw: Math.PI / 2 }];
    const state = simulate(definitions, EMPTY, 400);
    expect(actor(state, "a").position[0]).toBeGreaterThan(2.98);
    expect(actor(state, "b").position[0]).toBeLessThan(-2.98);
  });

  it("waits for an occupied single-file door, then resumes after the player leaves", () => {
    const definition = walker("a", [0, 0, 2], [0, 0, -2]);
    const player: CrowdPerson = { id: "player", position: [0, 0, 0], radius: 0.28 };
    const occupied = simulate([definition], { ...EMPTY, colliders: DOOR, people: [player] }, 160);
    expect(actor(occupied).position[2]).toBeGreaterThanOrEqual(0.34 + 0.28 + CROWD_CLEARANCE - 1e-7);
    expect(actor(occupied).status).toBe("blocked");
    const clear = simulate([definition], { ...EMPTY, colliders: DOOR }, 160, occupied);
    expect(actor(clear).position[2]).toBeLessThan(-1.98);
  });

  it("can recover from a player fast-travel overlap only by bounded local separation", () => {
    const definition = walker("a", [-0.1, 0, 0]);
    const player: CrowdPerson = { id: "player", position: [0, 0, 0], radius: 0.28 };
    let state = createCrowd([definition]);
    for (let frame = 0; frame < 20; frame += 1) {
      const before = actor(state).position;
      state = stepCrowd(state, [definition], { ...EMPTY, people: [player] }, FRAME);
      expect(separation(actor(state).position, player.position)).toBeGreaterThanOrEqual(separation(before, player.position));
      expect(separation(actor(state).position, before)).toBeLessThanOrEqual(0.85 * 0.05 + 1e-8);
    }
    expect(separation(actor(state).position, player.position)).toBeGreaterThanOrEqual(0.645);
  });

  it("does not escape through a wall to resolve an overlap", () => {
    const wall: Collider = { id: "behind", min: [-2, 0, -2], max: [-0.45, 3, 2] };
    const definition = walker("a", [-0.1, 0, 0]);
    let state = createCrowd([definition]);
    for (let frame = 0; frame < 50; frame += 1) state = stepCrowd(state, [definition], { ...EMPTY, colliders: [wall], people: [{ id: "player", position: [0, 0, 0], radius: 0.28 }] }, FRAME);
    expect(isWalkable(actor(state).position, [wall], 0.34)).toBe(true);
    expect(actor(state).position[0]).toBeGreaterThanOrEqual(-0.11 - 1e-8);
  });

  it("prevents the player from sweeping through moving or stationary staff", () => {
    const staff: CrowdPerson = { id: "staff:patrol", position: [0, 0, 0], radius: 0.34 };
    expect(moveWithPeople([-2, 0, 0], [4, 0, 0], [], [staff], 0.28)[0]).toBeCloseTo(-0.645);
    expect(moveWithPeople([2, 0, 0], [-4, 0, 0], [], [staff], 0.28)[0]).toBeCloseTo(0.645);
    const passing = moveWithPeople([-2, 0, 1], [4, 0, 0], [], [staff], 0.28);
    expect(passing[0]).toBeCloseTo(2, 14); expect(passing.slice(1)).toEqual([0, 1]);
    expect(staff.position).toEqual([0, 0, 0]);
  });

  it("keeps player-side geometry checks and lets a pre-existing overlap separate", () => {
    expect(moveWithPeople([-3, 0, 0], [8, 0, 0], [WALL], [], 0.28)[0]).toBeCloseTo(-0.78);
    expect(moveWithPeople([0, 0, 0], [8, 0, 0], [WALL], [], 0.28)).toEqual([0, 0, 0]);
    const person: CrowdPerson = { id: "staff", position: [0, 0, 0], radius: 0.34 };
    expect(moveWithPeople([-0.1, 0, 0], [-0.05, 0, 0], [], [person], 0.28)[0]).toBeCloseTo(-0.15);
    expect(moveWithPeople([-0.1, 0, 0], [0.05, 0, 0], [], [person], 0.28)[0]).toBeCloseTo(-0.1);
  });
});

describe("bounded clocks, lifecycle and recovery", () => {
  it("freezes all route, wait and motion state during pause, reduced motion and invalid deltas", () => {
    const definitions = [walker()];
    const state = stepCrowd(createCrowd(definitions), definitions, EMPTY, FRAME);
    for (const frame of [{ ...FRAME, paused: true }, { ...FRAME, reducedMotion: true }, ...[0, -1, NaN, Infinity].map((delta) => ({ ...FRAME, delta }))]) {
      expect(stepCrowd(state, definitions, EMPTY, frame)).toBe(state);
    }
    expect(stepCrowd(state, definitions, EMPTY, { ...FRAME, delta: 90 })).toEqual(stepCrowd(state, definitions, EMPTY, FRAME));
  });

  it("honors waits and resumes without catching up after a long pause", () => {
    const definition = { ...walker(), stops: [{ position: [-3, 0, 0] as Vec3, waitSeconds: 1 }, { position: [3, 0, 0] as Vec3, waitSeconds: 2 }] };
    const initial = createCrowd([definition]);
    const paused = stepCrowd(initial, [definition], EMPTY, { ...FRAME, delta: 100, paused: true });
    const resumed = stepCrowd(paused, [definition], EMPTY, { ...FRAME, delta: 100 });
    expect(actor(resumed).waitRemaining).toBeCloseTo(0.95);
    expect(actor(resumed).position).toEqual(definition.position);
    expect(actor(simulate([definition], EMPTY, 25, resumed)).position[0]).toBeGreaterThan(-3);
  });

  it("retries unreachable destinations on simulation time and recovers after geometry changes", () => {
    const definition = walker();
    const blocked = stepCrowd(createCrowd([definition]), [definition], { ...EMPTY, colliders: [WALL] }, FRAME);
    expect(actor(blocked).retryRemaining).toBe(CROWD_RETRY_SECONDS);
    const retry = stepCrowd(blocked, [definition], EMPTY, FRAME);
    expect(actor(retry).position).toEqual(definition.position);
    expect(actor(retry).retryRemaining).toBeCloseTo(CROWD_RETRY_SECONDS - FRAME.delta);
    const recovered = simulate([definition], EMPTY, 200, retry);
    expect(actor(recovered).position[0]).toBeGreaterThan(2.98);
  });

  it("replans a stuck detour without changing identity or teleporting", () => {
    const definition = walker();
    const initial = createCrowd([definition]);
    const stuck: CrowdState = { agents: [{ ...actor(initial), route: [[-3, 0, -10]], detour: [[-3, 0, -8]], blockedSeconds: CROWD_STUCK_SECONDS }] };
    const next = stepCrowd(stuck, [definition], EMPTY, FRAME);
    expect(actor(next).detour).toEqual([]);
    expect(actor(next).route).toEqual([[3, 0, 0]]);
    expect(actor(next).id).toBe("a");
    expect(actor(next).position[0]).toBeGreaterThan(-3);
  });

  it("is deterministic across definition, state and external obstacle order", () => {
    const definitions = [walker("a"), walker("b", [3, 0, 0], [-3, 0, 0])];
    const people: readonly CrowdPerson[] = [{ id: "z", position: [1, 0, 4], radius: 0.3 }, { id: "c", position: [1, 0, -4], radius: 0.3 }];
    let forward = createCrowd(definitions); let reverse: CrowdState = { agents: [...forward.agents].reverse() };
    for (let frame = 0; frame < 120; frame += 1) {
      forward = stepCrowd(forward, definitions, { ...EMPTY, people }, FRAME);
      reverse = stepCrowd(reverse, [...definitions].reverse(), { ...EMPTY, people: [...people].reverse() }, FRAME);
      expect(reverse).toEqual(forward);
    }
  });

  it("preserves survivors by stable ID through tier changes and rejects duplicate identity", () => {
    const definitions = [walker("a"), walker("b", [5, 0, 0], [7, 0, 0])];
    const state = stepCrowd(createCrowd(definitions), definitions, EMPTY, FRAME);
    const onlyB = reconcileCrowd(state, definitions.filter((definition) => definition.id === "b"));
    expect(actor(onlyB, "b")).toBe(actor(state, "b"));
    expect(() => createCrowd([walker(), walker()])).toThrow("unique");
    expect(() => stepCrowd(state, [walker(), walker()], EMPTY, FRAME)).toThrow("unique");
  });

  it("bounds authored speed and ignores absent definitions", () => {
    const definition = { ...walker(), speed: 10_000 };
    const state = stepCrowd(createCrowd([definition]), [definition], EMPTY, FRAME);
    expect(actor(state).speed).toBeCloseTo(CROWD_MAX_SPEED);
    expect(stepCrowd(state, [], EMPTY, FRAME).agents).toEqual([]);
    const stationary = { ...walker(), speed: NaN };
    expect(actor(stepCrowd(createCrowd([stationary]), [stationary], EMPTY, FRAME)).position).toEqual(stationary.position);
  });
});
