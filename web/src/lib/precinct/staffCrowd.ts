/** Authored ambient-only adapter. Case, interview and model data never enter navigation. */
import { createCrowd, reconcileCrowd, stepCrowd, type CrowdDefinition, type CrowdPerson, type CrowdState, type CrowdWorld } from "./crowdNavigation";
import { PLAYER_RADIUS } from "./movement";
import { PATROL_SPEED, PATROL_STOPS, STAFF_RADIUS, staffForTier } from "./staff";
import type { Vec3 } from "./types";
import type { Tier } from "../world/quality";

// Authored positions and patrol stops are readonly; never freeze or change their shared objects.
// Cache only this live adapter's containers. Canonical capture interpreters are independent.
const definitionsByTier = new Map<Tier, readonly CrowdDefinition[]>();
const NO_STOPS: CrowdDefinition["stops"] = Object.freeze([]);
export function staffCrowdDefinitions(tier: Tier): readonly CrowdDefinition[] {
  const cached = definitionsByTier.get(tier);
  if (cached !== undefined) return cached;
  const definitions = Object.freeze(staffForTier(tier).map((staff) => Object.freeze({ id: `staff:${staff.id}`, position: staff.position,
    yaw: staff.yaw, radius: STAFF_RADIUS, speed: staff.activity === "patrol" ? PATROL_SPEED : 0,
    stops: staff.activity === "patrol" ? PATROL_STOPS : NO_STOPS })));
  definitionsByTier.set(tier, definitions);
  return definitions;
}

export interface StaffCrowdFrame {
  readonly tier: Tier;
  readonly delta: number;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly replay: boolean;
  readonly playerPosition: Vec3;
}

export function createStaffCrowd(tier: Tier): CrowdState { return createCrowd(staffCrowdDefinitions(tier)); }

export function staffCrowdPeople(state: CrowdState): readonly CrowdPerson[] {
  return state.agents.map((agent) => ({ id: agent.id, position: agent.position, radius: STAFF_RADIUS }));
}

/** The stationary solver branch only sorts, adds +0, and clears speed/blockedSeconds.
 * Keep its exact values, including signed-zero normalization, before reusing an immutable snapshot. */
function unchangedStationaryState(state: CrowdState, definitions: readonly CrowdDefinition[]): boolean {
  return definitions.every((definition) => definition.speed === 0 && definition.stops.length === 0)
    && state.agents.every((agent, index, agents) => {
      const previous = agents[index - 1];
      return agent.status === "stationary" && Object.is(agent.speed, 0) && Object.is(agent.blockedSeconds, 0)
        && agent.position.every(Number.isFinite) && !Object.is(agent.position[0], -0) && !Object.is(agent.position[2], -0)
        && Number.isFinite(agent.walkedDistance) && !Object.is(agent.walkedDistance, -0)
        && (previous === undefined || previous.id < agent.id);
    });
}

/** Call once after Controls updates the player, before live figures apply and sample their roots. */
export function advanceStaffCrowd(state: CrowdState, geometry: Pick<CrowdWorld, "colliders" | "navigationNodes" | "navigationMesh">, frame: StaffCrowdFrame): CrowdState {
  // Replay samples own roots and clip time. Even a tier change must not simulate their navigation.
  if (frame.replay) return state;
  const definitions = staffCrowdDefinitions(frame.tier);
  const sameActors = state.agents.length === definitions.length
    && state.agents.every((agent) => definitions.some((definition) => definition.id === agent.id));
  const current = sameActors ? state : reconcileCrowd(state, definitions);
  if (unchangedStationaryState(current, definitions)) return current;
  return stepCrowd(current, definitions, { ...geometry, people: [{ id: "investigator:walking", position: frame.playerPosition, radius: PLAYER_RADIUS }] }, frame);
}
