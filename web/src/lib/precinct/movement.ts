import type { CameraMode, Collider, Hotspot, LookAngles, NavigationNode, Vec3 } from "./types";

export const PLAYER_RADIUS = 0.28;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.65;
export const WALK_SPEED = 2.4;
export const SPRINT_SPEED = 4.2;
export const MAX_FRAME_SECONDS = 0.05;
export const MAX_PITCH = Math.PI * 0.44;

const EPSILON = 1e-8;
const MAX_SUBSTEPS = 256;
const SUBSTEP_METRES = 0.14;

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function validPosition(position: Vec3): boolean {
  return position.every(Number.isFinite);
}

function safeRadius(radius: number): number {
  return Number.isFinite(radius) && radius >= 0 ? radius : PLAYER_RADIUS;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/** Radial stick deadzone, rescaled to preserve the full range; output length never exceeds 1. */
export function controllerDeadzone(x: number, y: number, deadzone = 0.18): readonly [number, number] {
  const dx = finite(x);
  const dy = finite(y);
  const length = Math.hypot(dx, dy);
  const threshold = Math.max(0, Math.min(0.95, finite(deadzone)));
  if (length <= threshold || length === 0) return [0, 0];
  const magnitude = (Math.min(1, length) - threshold) / (1 - threshold);
  return [(dx / length) * magnitude, (dy / length) * magnitude];
}

/** Positive forward goes north at yaw 0; positive strafe goes right. Analog magnitude is retained. */
export function inputMovement(forward: number, strafe: number, yaw: number, sprint: boolean, dt: number): Vec3 {
  const f = Math.max(-1, Math.min(1, finite(forward)));
  const s = Math.max(-1, Math.min(1, finite(strafe)));
  const length = Math.max(1, Math.hypot(f, s));
  const seconds = Math.max(0, Math.min(MAX_FRAME_SECONDS, finite(dt)));
  const scale = ((sprint ? SPRINT_SPEED : WALK_SPEED) * seconds) / length;
  const angle = finite(yaw);
  return [(Math.cos(angle) * s - Math.sin(angle) * f) * scale, 0,
    (-Math.sin(angle) * s - Math.cos(angle) * f) * scale];
}

export function turn(look: LookAngles, deltaYaw: number, deltaPitch: number): LookAngles {
  const yaw = finite(look.yaw) + finite(deltaYaw);
  return {
    yaw: ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, finite(look.pitch) + finite(deltaPitch))),
  };
}

/** Free inspection is only available while paused. Resuming from free returns to first person. */
export function nextCameraMode(mode: CameraMode, paused: boolean): CameraMode {
  if (mode === "first") return "third";
  if (mode === "third" && paused) return "free";
  return "first";
}

function overlapsHeight(position: Vec3, collider: Collider): boolean {
  return collider.max[1] > position[1] + EPSILON && collider.min[1] < position[1] + PLAYER_HEIGHT - EPSILON;
}

/** A conservative square footprint around the upright player. Touching an edge is allowed. */
export function isWalkable(position: Vec3, colliders: readonly Collider[], radius = PLAYER_RADIUS): boolean {
  if (!validPosition(position)) return false;
  const padding = safeRadius(radius);
  return !colliders.some((collider) => overlapsHeight(position, collider)
    && position[0] > collider.min[0] - padding + EPSILON
    && position[0] < collider.max[0] + padding - EPSILON
    && position[2] > collider.min[2] - padding + EPSILON
    && position[2] < collider.max[2] + padding - EPSILON);
}

/** Sweep the entire axis segment, so even a huge displacement cannot tunnel through a thin wall. */
function sweepAxis(position: Vec3, amount: number, axis: 0 | 2, colliders: readonly Collider[], radius: number): Vec3 {
  if (amount === 0) return position;
  const other = axis === 0 ? 2 : 0;
  let target = position[axis] + amount;
  for (const collider of colliders) {
    if (!overlapsHeight(position, collider)
      || position[other] <= collider.min[other] - radius + EPSILON
      || position[other] >= collider.max[other] + radius - EPSILON) continue;
    const near = collider.min[axis] - radius;
    const far = collider.max[axis] + radius;
    if (amount > 0 && position[axis] <= near + EPSILON && target > near) target = Math.min(target, near);
    if (amount < 0 && position[axis] >= far - EPSILON && target < far) target = Math.max(target, far);
  }
  return axis === 0 ? [target, position[1], position[2]] : [position[0], position[1], target];
}

/**
 * Wall sliding with bounded substeps and continuous axis sweeps. Vertical movement is ignored.
 * An invalid or embedded start fails closed: the caller must choose a known walkable spawn.
 */
export function moveWithCollisions(position: Vec3, displacement: Vec3, colliders: readonly Collider[], radius = PLAYER_RADIUS): Vec3 {
  const padding = safeRadius(radius);
  if (!isWalkable(position, colliders, padding) || !validPosition(displacement)) return position;
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1,
    Math.ceil(Math.max(Math.abs(displacement[0]), Math.abs(displacement[2])) / SUBSTEP_METRES)));
  const x = displacement[0] / steps;
  const z = displacement[2] / steps;
  let result = position;
  for (let step = 0; step < steps; step += 1) {
    result = sweepAxis(result, x, 0, colliders, padding);
    result = sweepAxis(result, z, 2, colliders, padding);
  }
  return result;
}

/** Nearest interaction within its own horizontal radius. Ties preserve manifest order. */
export function nearestHotspot(position: Vec3, hotspots: readonly Hotspot[]): Hotspot | null {
  let nearest: Hotspot | null = null;
  let nearestDistance = Infinity;
  for (const hotspot of hotspots) {
    const separation = distance(position, hotspot.position);
    if (separation <= hotspot.radius && separation < nearestDistance) {
      nearest = hotspot;
      nearestDistance = separation;
    }
  }
  return nearest;
}

/** Segment vs. expanded XZ rectangle. Shrinking by epsilon permits travel along an exact contact edge. */
function crossesCollider(from: Vec3, to: Vec3, collider: Collider, radius: number): boolean {
  let enter = 0;
  let leave = 1;
  for (const axis of [0, 2] as const) {
    const min = collider.min[axis] - radius + EPSILON;
    const max = collider.max[axis] + radius - EPSILON;
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < EPSILON) {
      if (from[axis] <= min || from[axis] >= max) return false;
    } else {
      const a = (min - from[axis]) / delta;
      const b = (max - from[axis]) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter >= leave) return false;
    }
  }
  return enter < leave;
}

/** Ground-plane visibility for the full player footprint, not a point ray through a doorway. */
export function hasLineOfSight(from: Vec3, to: Vec3, colliders: readonly Collider[], radius = PLAYER_RADIUS): boolean {
  const padding = safeRadius(radius);
  if (!isWalkable(from, colliders, padding) || !isWalkable(to, colliders, padding)
    || Math.abs(from[1] - to[1]) > EPSILON) return false;
  return !colliders.some((collider) => overlapsHeight(from, collider) && crossesCollider(from, to, collider, padding));
}

interface RouteEntry {
  readonly id: string;
  readonly position: Vec3;
  readonly cost: number;
  readonly path: readonly Vec3[];
}

/**
 * Dijkstra over explicit directed waypoint links, plus visible start/end connections.
 * Every edge is checked against the real collision geometry. Returns null if unreachable;
 * a route omits the current start and includes the exact destination (no unsafe snapping).
 */
export function findWaypointRoute(start: Vec3, destination: Vec3, nodes: readonly NavigationNode[],
  colliders: readonly Collider[], radius = PLAYER_RADIUS): readonly Vec3[] | null {
  const padding = safeRadius(radius);
  if (!isWalkable(start, colliders, padding) || !isWalkable(destination, colliders, padding)
    || Math.abs(start[1] - destination[1]) > EPSILON) return null;
  if (hasLineOfSight(start, destination, colliders, padding)) {
    return distance(start, destination) <= EPSILON ? [] : [destination];
  }
  const graph = new Map(nodes.map((node) => [node.id, node]));
  const costs = new Map<string, number>();
  const pending: RouteEntry[] = [];
  for (const node of graph.values()) {
    if (!hasLineOfSight(start, node.position, colliders, padding)) continue;
    const cost = distance(start, node.position);
    costs.set(node.id, cost);
    pending.push({ id: node.id, position: node.position, cost, path: [node.position] });
  }
  let best: readonly Vec3[] | null = null;
  let bestCost = Infinity;
  while (pending.length > 0) {
    pending.sort((a, b) => b.cost - a.cost);
    const current = pending.pop();
    if (!current || current.cost > (costs.get(current.id) ?? Infinity)) continue;
    if (current.cost >= bestCost) break;
    if (hasLineOfSight(current.position, destination, colliders, padding)) {
      const cost = current.cost + distance(current.position, destination);
      if (cost < bestCost) {
        bestCost = cost;
        best = [...current.path, destination];
      }
    }
    for (const neighborId of graph.get(current.id)?.neighbors ?? []) {
      const neighbor = graph.get(neighborId);
      if (!neighbor || !hasLineOfSight(current.position, neighbor.position, colliders, padding)) continue;
      const cost = current.cost + distance(current.position, neighbor.position);
      if (cost >= (costs.get(neighborId) ?? Infinity)) continue;
      costs.set(neighborId, cost);
      pending.push({ id: neighborId, position: neighbor.position, cost, path: [...current.path, neighbor.position] });
    }
  }
  return best;
}
