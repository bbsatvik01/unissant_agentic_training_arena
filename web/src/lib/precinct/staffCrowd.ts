/** Authored ambient-only adapter. Case, interview and model data never enter navigation. */
import { createCrowd, reconcileCrowd, stepCrowd, type CrowdDefinition, type CrowdPerson, type CrowdState, type CrowdWorld } from "./crowdNavigation";
import { PLAYER_RADIUS } from "./movement";
import { PATROL_SPEED, PATROL_STOPS, STAFF_RADIUS, staffForTier } from "./staff";
import type { Vec3 } from "./types";
import type { Tier } from "../world/quality";

export function staffCrowdDefinitions(tier: Tier): readonly CrowdDefinition[] {
  return staffForTier(tier).map((staff) => ({ id: `staff:${staff.id}`, position: staff.position,
    yaw: staff.yaw, radius: STAFF_RADIUS, speed: staff.activity === "patrol" ? PATROL_SPEED : 0,
    stops: staff.activity === "patrol" ? PATROL_STOPS : [] }));
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

/** Call once after Controls updates the player, before live figures apply and sample their roots. */
export function advanceStaffCrowd(state: CrowdState, geometry: Pick<CrowdWorld, "colliders" | "navigationNodes">, frame: StaffCrowdFrame): CrowdState {
  // Replay samples own roots and clip time. Even a tier change must not simulate their navigation.
  if (frame.replay) return state;
  const definitions = staffCrowdDefinitions(frame.tier);
  const sameActors = state.agents.length === definitions.length
    && state.agents.every((agent) => definitions.some((definition) => definition.id === agent.id));
  const current = sameActors ? state : reconcileCrowd(state, definitions);
  return stepCrowd(current, definitions, { ...geometry, people: [{ id: "investigator:walking", position: frame.playerPosition, radius: PLAYER_RADIUS }] }, frame);
}
