import { describe, expect, it } from "vitest";
import { navigatedPrecinctManifest } from "./knownWorldNavigation";
import { PRECINCT_WORLDS } from "./knownWorlds";
import { effectivePrecinctColliders } from "./effectiveWorldGeometry";
import { REVIEWER_COLLIDER_V2 } from "./proceduralReviewerV2";

/** Requires the actually generated bundled JSON, not a stubbed mesh. */
describe("bundled selected-world navigation wiring", () => {
  for (const id of ["office", "courtyard"] as const) {
    it(`loads and validates both actual ${id} profiles after its exact reviewer overlay`, () => {
      const authored = PRECINCT_WORLDS[id].manifest;
      const result = navigatedPrecinctManifest(authored);
      expect(result.playerNavigationMesh).not.toBeNull(); expect(result.navigationMesh).not.toBeNull();
      expect(result.navigationStatus?.player.mode).toBe("mesh"); expect(result.navigationStatus?.staff.mode).toBe("mesh");
      expect(result.colliders).toEqual(effectivePrecinctColliders(authored.colliders));
      expect(result.colliders.filter((collider) => collider.id === REVIEWER_COLLIDER_V2.id)).toEqual([REVIEWER_COLLIDER_V2]);
      expect(result.hotspots).toBe(authored.hotspots); expect(result.navigationNodes).toBe(authored.navigationNodes);
      expect(navigatedPrecinctManifest(authored)).toBe(result);
    });
    it(`separates ${id} live mesh planning from frozen legacy and captured-root playback`, () => {
      const authored = PRECINCT_WORLDS[id].manifest;
      const legacy = navigatedPrecinctManifest(authored, "legacy-replay");
      expect(legacy.playerNavigationMesh).toBeNull(); expect(legacy.navigationMesh).toBeNull();
      expect(legacy.navigationStatus?.player.reason).toBe("legacy-compatibility");
      const recorded = navigatedPrecinctManifest(authored, "sampled-replay");
      expect(recorded.playerNavigationMesh).toBeNull(); expect(recorded.navigationMesh).toBeNull();
      expect(recorded.navigationStatus?.player.reason).toBe("replay-owned");
      expect(navigatedPrecinctManifest(authored).navigationStatus?.player.mode).toBe("mesh");
    });
  }
  it("discloses missing bounds without losing the frozen replay ownership mode", () => {
    const manifest = { colliders: [], hotspots: [], navigationNodes: [] };
    expect(navigatedPrecinctManifest(manifest).navigationStatus?.player.reason).toBe("missing");
    expect(navigatedPrecinctManifest(manifest, "legacy-replay").navigationStatus?.player.reason).toBe("legacy-compatibility");
    expect(navigatedPrecinctManifest(manifest, "sampled-replay").navigationStatus?.player.reason).toBe("replay-owned");
  });
  it("rejects a stale effective collider set without altering the original authored world", () => {
    const authored = PRECINCT_WORLDS.office.manifest;
    const changed = { ...authored, colliders: [...authored.colliders, { id: "unexpected-test-wall", min: [-1, 0, -3] as const, max: [1, 3, -2.8] as const }] };
    const stale = navigatedPrecinctManifest(changed);
    expect(stale.playerNavigationMesh).toBeNull(); expect(stale.navigationMesh).toBeNull();
    expect(stale.navigationStatus?.player.reason).toBe("invalid");
    expect(navigatedPrecinctManifest(authored).navigationStatus?.player.mode).toBe("mesh");
  });
});
