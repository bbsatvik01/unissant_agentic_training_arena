/**
 * Deterministic local crowd routing on the existing collision-validated waypoint graph.
 * This is not a navigation mesh. Only authored geometry, people and bounded frame deltas enter.
 * No case/model/event state, timers, randomness, Three objects or renderer writes belong here.
 */
import { findWaypointRoute, hasLineOfSight, isWalkable, MAX_FRAME_SECONDS, moveWithCollisions } from "./movement";
import type { Collider, NavigationNode, Vec3 } from "./types";

export interface CrowdStop { readonly position: Vec3; readonly waitSeconds: number }
export interface CrowdDefinition {
  readonly id: string;
  readonly position: Vec3;
  readonly yaw: number;
  readonly radius: number;
  readonly speed: number;
  /** Empty stops or zero speed make a person stationary. */
  readonly stops: readonly CrowdStop[];
}
export type CrowdStatus = "stationary" | "waiting" | "walking" | "blocked" | "invalid-start";
export interface CrowdAgent {
  readonly id: string;
  readonly position: Vec3;
  readonly yaw: number;
  readonly speed: number;
  readonly walkedDistance: number;
  readonly stopIndex: number;
  readonly waitRemaining: number;
  readonly route: readonly Vec3[];
  readonly detour: readonly Vec3[];
  readonly blockedSeconds: number;
  readonly retryRemaining: number;
  readonly status: CrowdStatus;
}
export interface CrowdState { readonly agents: readonly CrowdAgent[] }
export interface CrowdPerson { readonly id: string; readonly position: Vec3; readonly radius: number }
export interface CrowdWorld {
  readonly colliders: readonly Collider[];
  readonly navigationNodes: readonly NavigationNode[];
  /** Player and other stationary people. These are read-only obstacles, never pushed. */
  readonly people: readonly CrowdPerson[];
}
export interface CrowdFrame { readonly delta: number; readonly paused: boolean; readonly reducedMotion: boolean }

export const CROWD_CLEARANCE = 0.025;
export const CROWD_RETRY_SECONDS = 0.5;
export const CROWD_STUCK_SECONDS = 1.5;
export const CROWD_MAX_SPEED = 1.3;
const ARRIVAL = 0.015;
const EPSILON = 1e-8;
const ZERO: Vec3 = [0, 0, 0];
const finite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[2] - a[2]);
const compareId = (a: { readonly id: string }, b: { readonly id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const radiusOf = (value: number) => Math.max(0.1, Math.min(1, finite(value)));
const atHeight = (position: Vec3, height: number): Vec3 => [position[0], height, position[2]];

function initialAgent(definition: CrowdDefinition): CrowdAgent {
  const first = definition.stops[0];
  const atFirst = first !== undefined && distance(definition.position, first.position) <= ARRIVAL;
  return { id: definition.id, position: definition.position, yaw: Number.isFinite(definition.yaw) ? definition.yaw : 0,
    speed: 0, walkedDistance: 0, stopIndex: atFirst && definition.stops.length > 1 ? 1 : 0,
    waitRemaining: atFirst ? finite(first.waitSeconds) : 0, route: [], detour: [], blockedSeconds: 0,
    retryRemaining: 0, status: definition.stops.length === 0 || finite(definition.speed) === 0 ? "stationary" : "waiting" };
}

/** Identity, not array order, owns navigation state. Duplicate IDs are rejected before movement. */
export function createCrowd(definitions: readonly CrowdDefinition[]): CrowdState {
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) throw new Error("Crowd actor IDs must be unique.");
  return { agents: [...definitions].sort(compareId).map(initialAgent) };
}

/** Preserve surviving actors when a graphics tier changes; newly visible actors use their authored spawn. */
export function reconcileCrowd(state: CrowdState, definitions: readonly CrowdDefinition[]): CrowdState {
  const fresh = createCrowd(definitions);
  const previous = new Map(state.agents.map((agent) => [agent.id, agent]));
  return { agents: fresh.agents.map((agent) => previous.get(agent.id) ?? agent) };
}

/** First contact of two swept discs. Already-overlapping teleports may only separate, never deepen. */
function contactFraction(a: Vec3, da: Vec3, b: Vec3, db: Vec3, radius: number): number {
  const x = a[0] - b[0]; const z = a[2] - b[2];
  const vx = da[0] - db[0]; const vz = da[2] - db[2];
  const dot = x * vx + z * vz;
  const squared = x * x + z * z;
  if (squared < radius * radius - EPSILON) return dot >= -EPSILON ? 1 : 0;
  if (dot >= 0) return 1;
  const speedSquared = vx * vx + vz * vz;
  if (speedSquared <= EPSILON) return 1;
  const discriminant = dot * dot - speedSquared * (squared - radius * radius);
  if (discriminant <= 0) return 1;
  return Math.max(0, Math.min(1, (-dot - Math.sqrt(discriminant)) / speedSquared - EPSILON));
}

function clearPeople(from: Vec3, to: Vec3, radius: number, people: readonly CrowdPerson[]): boolean {
  const displacement: Vec3 = [to[0] - from[0], 0, to[2] - from[2]];
  return people.every((person) => contactFraction(from, displacement, person.position, ZERO, radius + radiusOf(person.radius) + CROWD_CLEARANCE) >= 1);
}

/** Player-side counterpart: collision-resolve first, then sweep against the current staff snapshot. */
export function moveWithPeople(position: Vec3, displacement: Vec3, colliders: readonly Collider[], people: readonly CrowdPerson[], radius: number): Vec3 {
  const moved = moveWithCollisions(position, displacement, colliders, radius);
  if (!hasLineOfSight(position, moved, colliders, radius)) return position;
  const applied: Vec3 = [moved[0] - position[0], 0, moved[2] - position[2]];
  let fraction = 1;
  for (const person of people) fraction = Math.min(fraction,
    contactFraction(position, applied, person.position, ZERO, radius + radiusOf(person.radius) + CROWD_CLEARANCE));
  return [position[0] + applied[0] * fraction, position[1], position[2] + applied[2] * fraction];
}

/** A conservative two-corner passing lane, checked against the same real walls and door widths. */
function passingDetour(position: Vec3, target: Vec3, radius: number, people: readonly CrowdPerson[], colliders: readonly Collider[]): readonly Vec3[] {
  const length = distance(position, target);
  if (length < ARRIVAL) return [];
  const dx = (target[0] - position[0]) / length; const dz = (target[2] - position[2]) / length;
  const horizon = Math.min(length, 1.8);
  const end: Vec3 = [position[0] + dx * horizon, position[1], position[2] + dz * horizon];
  const blockers = people.filter((person) => !clearPeople(position, end, radius, [person])).sort((a, b) => distance(position, a.position) - distance(position, b.position) || compareId(a, b));
  const blocker = blockers[0];
  if (blocker === undefined) return [];
  const clearance = radius + radiusOf(blocker.radius) + CROWD_CLEARANCE + 0.16;
  // Keep right first. Reciprocal traffic chooses opposite world-space sides without randomness.
  for (const side of [1, -1]) {
    const x = blocker.position[0] - dz * clearance * side;
    const z = blocker.position[2] + dx * clearance * side;
    const near: Vec3 = [x - dx * clearance, position[1], z - dz * clearance];
    const far: Vec3 = [x + dx * clearance, position[1], z + dz * clearance];
    if (hasLineOfSight(position, near, colliders, radius) && hasLineOfSight(near, far, colliders, radius)
      && hasLineOfSight(far, target, colliders, radius)
      && clearPeople(position, near, radius, people) && clearPeople(near, far, radius, people)) return [near, far];
  }
  return [];
}

interface Proposal { readonly definition: CrowdDefinition; readonly agent: CrowdAgent; readonly displacement: Vec3 }
function propose(agent: CrowdAgent, definition: CrowdDefinition, world: CrowdWorld, people: readonly CrowdPerson[], seconds: number): Proposal {
  const radius = radiusOf(definition.radius);
  const speed = Math.min(CROWD_MAX_SPEED, finite(definition.speed));
  const hold = (next: CrowdAgent): Proposal => ({ definition, agent: { ...next, speed: 0 }, displacement: ZERO });
  if (speed === 0 || definition.stops.length === 0) return hold({ ...agent, status: "stationary" });
  if (!isWalkable(agent.position, world.colliders, radius)) return hold({ ...agent, route: [], detour: [], status: "invalid-start" });
  if (agent.waitRemaining > 0) return hold({ ...agent, waitRemaining: Math.max(0, agent.waitRemaining - seconds), status: "waiting" });
  const stop = definition.stops[agent.stopIndex];
  if (stop === undefined) return hold(initialAgent(definition));
  const destination = atHeight(stop.position, agent.position[1]);
  if (distance(agent.position, destination) <= ARRIVAL) return hold({ ...agent,
    stopIndex: (agent.stopIndex + 1) % definition.stops.length, waitRemaining: finite(stop.waitSeconds),
    route: [], detour: [], blockedSeconds: 0, retryRemaining: 0, status: "waiting" });

  let route = agent.route; let detour = agent.detour;
  const retryRemaining = Math.max(0, agent.retryRemaining - seconds);
  if (route.length === 0 || agent.blockedSeconds >= CROWD_STUCK_SECONDS) {
    if (retryRemaining > 0) return hold({ ...agent, retryRemaining, status: "blocked" });
    // The precinct is one flat floor; authored graph nodes are y=0 and avatar feet are y=0.03.
    const nodes = world.navigationNodes.map((node) => ({ ...node, position: atHeight(node.position, agent.position[1]) }));
    route = findWaypointRoute(agent.position, destination, nodes, world.colliders, radius) ?? [];
    detour = [];
    if (route.length === 0) return hold({ ...agent, route, detour, retryRemaining: CROWD_RETRY_SECONDS, status: "blocked" });
  }
  while (route[0] !== undefined && distance(agent.position, route[0]) <= ARRIVAL) route = route.slice(1);
  while (detour[0] !== undefined && distance(agent.position, detour[0]) <= ARRIVAL) detour = detour.slice(1);
  const waypoint = route[0] ?? destination;
  if (detour.length === 0) detour = passingDetour(agent.position, waypoint, radius, people, world.colliders);
  let target = detour[0] ?? waypoint;

  // A user fast-travel can place their disc over a colleague. Retreat locally at walking speed.
  const overlapping = people.find((person) => distance(agent.position, person.position) < radius + radiusOf(person.radius) + CROWD_CLEARANCE - EPSILON);
  if (overlapping !== undefined) {
    const separation = distance(agent.position, overlapping.position);
    const dx = separation > EPSILON ? (agent.position[0] - overlapping.position[0]) / separation : -Math.sin(agent.yaw + Math.PI / 2);
    const dz = separation > EPSILON ? (agent.position[2] - overlapping.position[2]) / separation : -Math.cos(agent.yaw + Math.PI / 2);
    target = [agent.position[0] + dx, agent.position[1], agent.position[2] + dz];
    detour = [];
  }
  const length = distance(agent.position, target);
  const step = Math.min(length, speed * seconds);
  const intended: Vec3 = length <= EPSILON ? ZERO : [(target[0] - agent.position[0]) / length * step, 0, (target[2] - agent.position[2]) / length * step];
  const moved = moveWithCollisions(agent.position, intended, world.colliders, radius);
  // Collision sliding can bend the segment. Accept only a visibility-checked straight chord.
  const displacement: Vec3 = hasLineOfSight(agent.position, moved, world.colliders, radius)
    ? [moved[0] - agent.position[0], 0, moved[2] - agent.position[2]] : ZERO;
  return { definition, agent: { ...agent, route, detour, retryRemaining, status: "walking", blockedSeconds: agent.blockedSeconds >= CROWD_STUCK_SECONDS ? 0 : agent.blockedSeconds }, displacement };
}

/**
 * One synchronous snapshot and canonical ID order avoid mount-order and update-order effects.
 * Continuous pair checks truncate both proposed moves equally, including opposing traffic.
 * Failed/stuck routes retry at a bounded simulation cadence; no teleports or unsafe fallback.
 */
export function stepCrowd(state: CrowdState, definitions: readonly CrowdDefinition[], world: CrowdWorld, frame: CrowdFrame): CrowdState {
  const seconds = Math.min(MAX_FRAME_SECONDS, finite(frame.delta));
  if (frame.paused || frame.reducedMotion || seconds === 0) return state;
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  if (byId.size !== definitions.length) throw new Error("Crowd actor IDs must be unique.");
  const agents = [...state.agents].sort(compareId);
  const bodies = agents.flatMap((agent): CrowdPerson[] => {
    const definition = byId.get(agent.id);
    return definition === undefined ? [] : [{ id: agent.id, position: agent.position, radius: definition.radius }];
  });
  const people = [...world.people].sort(compareId);
  const proposals = agents.flatMap((agent): Proposal[] => {
    const definition = byId.get(agent.id);
    return definition === undefined ? [] : [propose(agent, definition, world, [...bodies.filter((body) => body.id !== agent.id), ...people], seconds)];
  });
  const motion = proposals.map((proposal) => proposal.displacement);
  const scale = (index: number, amount: number) => {
    const current = motion[index];
    if (current !== undefined) motion[index] = [current[0] * amount, 0, current[2] * amount];
  };
  // Truncation can introduce a following conflict. Iterate to a fixed safety result, then fail closed.
  for (let pass = 0; pass <= proposals.length * 2; pass += 1) {
    let changed = false;
    for (let a = 0; a < proposals.length; a += 1) {
      const first = proposals[a];
      if (first === undefined) continue;
      for (const person of people) {
        const fraction = contactFraction(first.agent.position, motion[a] ?? ZERO, person.position, ZERO, radiusOf(first.definition.radius) + radiusOf(person.radius) + CROWD_CLEARANCE);
        if (fraction < 1) { scale(a, fraction); changed = true; }
      }
      for (let b = a + 1; b < proposals.length; b += 1) {
        const second = proposals[b];
        if (second === undefined) continue;
        const fraction = contactFraction(first.agent.position, motion[a] ?? ZERO, second.agent.position, motion[b] ?? ZERO,
          radiusOf(first.definition.radius) + radiusOf(second.definition.radius) + CROWD_CLEARANCE);
        if (fraction < 1) { scale(a, fraction); scale(b, fraction); changed = true; }
      }
    }
    if (!changed) break;
    if (pass === proposals.length * 2) motion.fill(ZERO);
  }
  return { agents: proposals.map(({ agent, definition }, index) => {
    const displacement = motion[index] ?? ZERO;
    const travelled = Math.hypot(displacement[0], displacement[2]);
    const movable = definition.stops.length > 0 && finite(definition.speed) > 0;
    const trying = movable && (agent.status === "walking" || agent.status === "blocked");
    return { ...agent,
      position: [agent.position[0] + displacement[0], agent.position[1], agent.position[2] + displacement[2]],
      yaw: travelled > EPSILON ? Math.atan2(-displacement[0], -displacement[2]) : agent.yaw,
      speed: travelled / seconds, walkedDistance: agent.walkedDistance + travelled,
      blockedSeconds: trying && travelled < speedThreshold(definition, seconds) ? agent.blockedSeconds + seconds : 0,
      status: travelled > EPSILON ? "walking" : trying ? "blocked" : agent.status,
    };
  }) };
}

function speedThreshold(definition: CrowdDefinition, seconds: number): number {
  return Math.min(CROWD_MAX_SPEED, finite(definition.speed)) * seconds * 0.05;
}
