import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceStaffCrowd, createStaffCrowd, staffCrowdDefinitions, staffCrowdPeople, type StaffCrowdFrame } from "./staffCrowd";
import * as navigation from "./crowdNavigation";
import type { CrowdAgent, CrowdDefinition, CrowdState, CrowdWorld } from "./crowdNavigation";
import * as staff from "./staff";
import { PLAYER_RADIUS } from "./movement";
import { PRECINCT_WORLDS } from "./knownWorlds";
import { navigatedPrecinctManifest } from "./knownWorldNavigation";
import type { Tier } from "../world/quality";

// This switch changes evidence expectations only; both runs use the same production callers.
// These tests have not been executed in the source-only package.
const baseline = import.meta.env["VITE_ARENA_IDLE_WORK_BASELINE"] === "1";
const originalStep = navigation.stepCrowd;
const originalReconcile = navigation.reconcileCrowd;
const tiers: readonly Tier[] = ["low", "medium", "high"];
const frame: StaffCrowdFrame = { tier: "low", delta: 0.05, paused: false, reducedMotion: false, replay: false, playerPosition: [0, 0, -2.4] };
const emptyGeometry = { colliders: [], navigationNodes: [] };

/** Independent copy of the pre-change live adapter, using the unchanged production solver. */
function uncachedDefinitions(tier: Tier): readonly CrowdDefinition[] {
  return staff.staffForTier(tier).map((person) => ({ id: `staff:${person.id}`, position: person.position,
    yaw: person.yaw, radius: staff.STAFF_RADIUS, speed: person.activity === "patrol" ? staff.PATROL_SPEED : 0,
    stops: person.activity === "patrol" ? staff.PATROL_STOPS : [] }));
}
function referenceAdvance(state: CrowdState, geometry: Pick<CrowdWorld, "colliders" | "navigationNodes" | "navigationMesh">, next: StaffCrowdFrame): CrowdState {
  if (next.replay) return state;
  const definitions = uncachedDefinitions(next.tier);
  const sameActors = state.agents.length === definitions.length
    && state.agents.every((agent) => definitions.some((definition) => definition.id === agent.id));
  const current = sameActors ? state : originalReconcile(state, definitions);
  return originalStep(current, definitions, { ...geometry, people: [{ id: "investigator:walking", position: next.playerPosition, radius: PLAYER_RADIUS }] }, next);
}
function freezeSnapshot(state: CrowdState): CrowdState {
  return Object.freeze({ agents: Object.freeze(state.agents.map((agent) => Object.freeze({ ...agent,
    position: Object.freeze<CrowdAgent["position"]>([...agent.position]),
    route: Object.freeze(agent.route.map((position) => Object.freeze<CrowdAgent["position"]>([...position]))),
    detour: Object.freeze(agent.detour.map((position) => Object.freeze<CrowdAgent["position"]>([...position]))),
  }))) });
}
afterEach(() => { vi.restoreAllMocks(); });

describe("cached readonly authored tier definitions", () => {
  it("preserves authored values and shared patrol/position references while reusing adapter containers", () => {
    for (const tier of tiers) {
      const definitions = staffCrowdDefinitions(tier); const expected = uncachedDefinitions(tier);
      expect(definitions).toStrictEqual(expected);
      expect(staffCrowdDefinitions(tier) === definitions).toBe(!baseline);
      expect(Object.isFrozen(definitions)).toBe(!baseline);
      for (const [index, definition] of definitions.entries()) {
        expect(Object.isFrozen(definition)).toBe(!baseline);
        expect(definition.position).toBe(expected[index]?.position);
      }
    }
    expect(staffCrowdDefinitions("high").find((definition) => definition.id === "staff:patrol")?.stops).toBe(staff.PATROL_STOPS);
  });
  it("counts authored-definition rebuilding over repeated live calls after each tier is warm", () => {
    for (const tier of tiers) staffCrowdDefinitions(tier);
    const authored = vi.spyOn(staff, "staffForTier");
    for (let iteration = 0; iteration < 100; iteration += 1) for (const tier of tiers) staffCrowdDefinitions(tier);
    expect(authored).toHaveBeenCalledTimes(baseline ? 300 : 0);
    console.info("ARENA_STAFF_DEFINITIONS_EVIDENCE", JSON.stringify({ baseline, requests: 300, authoredRebuilds: authored.mock.calls.length }));
  });
});

describe("exact stationary-state fast path", () => {
  it.each(["low", "medium"] as const)("counts skipped solver calls for %s without changing any state field", (tier) => {
    let actual = freezeSnapshot(createStaffCrowd(tier)); let expected = actual; const initial = actual;
    const step = vi.spyOn(navigation, "stepCrowd");
    for (let iteration = 0; iteration < 100; iteration += 1) {
      expected = referenceAdvance(expected, emptyGeometry, { ...frame, tier });
      actual = advanceStaffCrowd(actual, emptyGeometry, { ...frame, tier });
      expect(actual).toStrictEqual(expected);
    }
    expect(step).toHaveBeenCalledTimes(baseline ? 100 : 0); expect(actual === initial).toBe(!baseline);
    console.info("ARENA_STATIONARY_CROWD_EVIDENCE", JSON.stringify({ baseline, tier, frames: 100,
      solverCalls: step.mock.calls.length, retainedInitialSnapshot: actual === initial }));
  });
  it("keeps stationary semantics even when changed geometry covers a person and the player overlaps", () => {
    const initial = freezeSnapshot(createStaffCrowd("medium"));
    const person = initial.agents[0]; if (person === undefined) throw new Error("Missing stationary actor");
    const geometry = { colliders: [{ id: "new-cover", min: [-100, -1, -100] as const, max: [100, 3, 100] as const }], navigationNodes: [] };
    const next = { ...frame, tier: "medium" as const, playerPosition: person.position };
    const step = vi.spyOn(navigation, "stepCrowd"); const expected = referenceAdvance(initial, geometry, next);
    const actual = advanceStaffCrowd(initial, geometry, next);
    expect(actual).toStrictEqual(expected); expect(step).toHaveBeenCalledTimes(baseline ? 1 : 0);
    expect(staffCrowdPeople(actual)).toStrictEqual(staffCrowdPeople(expected));
  });
  it("reconciles low/medium/high transitions during pause, reduced motion and zero delta before any fast path", () => {
    let actual = createStaffCrowd("high"); let expected = actual;
    const changes: readonly StaffCrowdFrame[] = [
      { ...frame, tier: "medium", paused: true }, { ...frame, tier: "high", reducedMotion: true },
      { ...frame, tier: "low", delta: 0 }, { ...frame, tier: "medium", delta: 0 },
      { ...frame, tier: "high", paused: true }, { ...frame, tier: "high" },
      { ...frame, tier: "medium" }, { ...frame, tier: "high" },
    ];
    for (const next of changes) {
      const before = actual; expected = referenceAdvance(expected, emptyGeometry, next);
      actual = advanceStaffCrowd(actual, emptyGeometry, next);
      expect(actual).toStrictEqual(expected);
      expect(actual.agents.map((agent) => agent.id)).toStrictEqual(expected.agents.map((agent) => agent.id));
      if (next.paused || next.reducedMotion || next.delta === 0) {
        for (const agent of actual.agents) {
          const surviving = before.agents.find((previous) => previous.id === agent.id);
          if (surviving !== undefined) expect(agent).toBe(surviving);
        }
      }
    }
    expect(actual.agents.find((agent) => agent.id === "staff:patrol")?.waitRemaining).toBeCloseTo(8.95, 12);
  });
  it.each([0, -1, Infinity, NaN])("retains the existing nonpositive/nonfinite-delta behavior (%s)", (delta) => {
    for (const tier of tiers) {
      const initial = createStaffCrowd(tier); const next = { ...frame, tier, delta };
      expect(advanceStaffCrowd(initial, emptyGeometry, next)).toBe(initial);
      expect(referenceAdvance(initial, emptyGeometry, next)).toBe(initial);
    }
  });
  it("falls back for stationary cleanup and unsorted state instead of preserving stale values", () => {
    const initial = createStaffCrowd("medium");
    const changed: CrowdState = { agents: [...initial.agents].reverse().map((agent) => ({ ...agent,
      speed: 0.5, blockedSeconds: 2, status: "blocked" as const, route: [[1, 0, -2] as const],
      detour: [[2, 0, -3] as const], retryRemaining: 0.2, waitRemaining: 4, walkedDistance: 3,
    })) };
    const step = vi.spyOn(navigation, "stepCrowd"); const next = { ...frame, tier: "medium" as const };
    const actual = advanceStaffCrowd(freezeSnapshot(changed), emptyGeometry, next);
    expect(actual).toStrictEqual(referenceAdvance(changed, emptyGeometry, next)); expect(step).toHaveBeenCalledTimes(1);
    expect(actual.agents.every((agent) => agent.speed === 0 && agent.blockedSeconds === 0 && agent.status === "stationary")).toBe(true);
    step.mockClear(); const repeated = advanceStaffCrowd(actual, emptyGeometry, next);
    expect(repeated).toStrictEqual(referenceAdvance(actual, emptyGeometry, next)); expect(step).toHaveBeenCalledTimes(baseline ? 1 : 0);
  });
  it("preserves the solver's signed-zero normalization before reusing a stationary snapshot", () => {
    const initial = createStaffCrowd("low");
    const changed: CrowdState = { agents: initial.agents.map((agent) => ({ ...agent,
      position: [-0, -0, -0] as const, speed: -0, blockedSeconds: -0, walkedDistance: -0,
    })) };
    const step = vi.spyOn(navigation, "stepCrowd"); const actual = advanceStaffCrowd(changed, emptyGeometry, frame);
    expect(actual).toStrictEqual(referenceAdvance(changed, emptyGeometry, frame)); expect(step).toHaveBeenCalledTimes(1);
    for (const agent of actual.agents) {
      expect(Object.is(agent.position[0], 0)).toBe(true); expect(Object.is(agent.position[1], -0)).toBe(true);
      expect(Object.is(agent.position[2], 0)).toBe(true); expect(Object.is(agent.walkedDistance, 0)).toBe(true);
      expect(Object.is(agent.speed, 0)).toBe(true); expect(Object.is(agent.blockedSeconds, 0)).toBe(true);
    }
  });
  it.each([
    { name: "status", patch: { status: "blocked" as const } },
    { name: "speed", patch: { speed: 1 } },
    { name: "blocked time", patch: { blockedSeconds: 1 } },
    { name: "negative-zero X", patch: { position: [-0, 0.03, -14] as const } },
    { name: "negative-zero Z", patch: { position: [-1, 0.03, -0] as const } },
    { name: "negative-zero distance", patch: { walkedDistance: -0 } },
    { name: "negative-zero speed", patch: { speed: -0 } },
    { name: "negative-zero blocked time", patch: { blockedSeconds: -0 } },
    { name: "nonfinite position", patch: { position: [Infinity, 0.03, -14] as const } },
    { name: "nonfinite distance", patch: { walkedDistance: NaN } },
  ] satisfies readonly { readonly name: string; readonly patch: Partial<CrowdAgent> }[])("independently falls back for $name", ({ patch }) => {
    const initial = createStaffCrowd("low");
    const changed: CrowdState = { agents: initial.agents.map((agent, index) => index === 0 ? { ...agent, ...patch } : agent) };
    const step = vi.spyOn(navigation, "stepCrowd");
    expect(advanceStaffCrowd(changed, emptyGeometry, frame)).toStrictEqual(referenceAdvance(changed, emptyGeometry, frame));
    expect(step).toHaveBeenCalledTimes(1);
  });
  it("sorts an otherwise valid reversed stationary snapshot through the original solver", () => {
    const initial = createStaffCrowd("medium"); const reversed = { agents: [...initial.agents].reverse() };
    const step = vi.spyOn(navigation, "stepCrowd"); const next = { ...frame, tier: "medium" as const };
    expect(advanceStaffCrowd(reversed, emptyGeometry, next)).toStrictEqual(referenceAdvance(reversed, emptyGeometry, next));
    expect(step).toHaveBeenCalledTimes(1);
  });
  it("does not simulate or reconcile a replay snapshot even when its tier differs", () => {
    const initial = freezeSnapshot(createStaffCrowd("high"));
    const step = vi.spyOn(navigation, "stepCrowd"), reconcile = vi.spyOn(navigation, "reconcileCrowd");
    expect(advanceStaffCrowd(initial, emptyGeometry, { ...frame, tier: "low", replay: true })).toBe(initial);
    expect(step).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("unchanged high-tier patrol and collision solver", () => {
  it.each(["office", "courtyard"] as const)("matches every patrol snapshot in %s while yielding to a player", (worldId) => {
    const geometry = navigatedPrecinctManifest(PRECINCT_WORLDS[worldId].manifest, "live");
    expect(geometry.navigationStatus?.staff.mode).toBe("mesh");
    expect(geometry.navigationMesh).toBeDefined();
    let actual = createStaffCrowd("high"), expected = actual;
    const next = { ...frame, tier: "high" as const, playerPosition: [1.15, 0, -18] as const };
    const step = vi.spyOn(navigation, "stepCrowd"); let maximumDistance = 0;
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      expected = referenceAdvance(expected, geometry, next); actual = advanceStaffCrowd(actual, geometry, next);
      expect(actual).toStrictEqual(expected);
      const patrol = actual.agents.find((agent) => agent.id === "staff:patrol");
      if (patrol === undefined) throw new Error("Missing patrol");
      expect(Math.hypot(patrol.position[0] - next.playerPosition[0], patrol.position[2] - next.playerPosition[2])).toBeGreaterThanOrEqual(0.645 - 1e-7);
      maximumDistance = Math.max(maximumDistance, patrol.walkedDistance);
    }
    expect(step).toHaveBeenCalledTimes(1000); expect(maximumDistance).toBeGreaterThan(10);
  });
});
