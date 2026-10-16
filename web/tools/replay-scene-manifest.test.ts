/** Byte identity checks establish bundled compatibility, never server authenticity or exact rendering. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COURTYARD_SCENE_CONTEXT, KNOWN_REPLAY_SCENES, OFFICE_SCENE_CONTEXT } from "../src/lib/world/sceneContext.ts";
import { PRECINCT_WORLDS } from "../src/lib/precinct/knownWorlds.ts";
import { precinctAsset } from "../src/lib/precinct/worldVariant.ts";
const root = new URL("../", import.meta.url);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
interface AdapterManifest {
  readonly scene_id: string;
  readonly geometry: { readonly asset_path: string; readonly asset_sha256: string; readonly manifest_path: string; readonly manifest_sha256: string };
  readonly dependencies: readonly { readonly path: string; readonly sha256: string }[];
}
describe("pinned bundled scene interpretation manifests", () => {
  for (const scene of KNOWN_REPLAY_SCENES) {
    it(`matches actual ${scene.worldId} geometry and every fixed interpretation adapter byte`, () => {
      const content = readFileSync(new URL(`src/lib/world/scene-adapter-${scene.worldId}-v2.json`, root), "utf8");
      const manifest = JSON.parse(content) as AdapterManifest;
      expect(sha(content)).toBe(scene.context.build_sha256);
      expect(manifest.scene_id).toBe(scene.context.scene_id);
      expect(sha(readFileSync(new URL(manifest.geometry.asset_path, root)))).toBe(scene.context.asset_sha256);
      expect(manifest.geometry.asset_sha256).toBe(scene.context.asset_sha256);
      expect(sha(readFileSync(new URL(manifest.geometry.manifest_path, root)))).toBe(scene.context.manifest_sha256);
      expect(manifest.geometry.manifest_sha256).toBe(scene.context.manifest_sha256);
      expect(precinctAsset(PRECINCT_WORLDS[scene.worldId].manifest)).toBe(scene.assetUrl);
      expect(manifest.dependencies.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        "src/lib/precinct/effectiveWorldGeometry.ts", "src/lib/precinct/proceduralReviewerV2.ts",
        "src/components/precinct/reviewerBodyV2.ts", "src/lib/precinct/proceduralPatrolV2.ts",
        "src/lib/precinct/interviewStage.ts", "src/components/precinct/actorSamples.ts",
        "src/components/precinct/seatedBodyV1.ts", "src/components/precinct/recordedCameraV1.ts",
      ]));
      for (const entry of manifest.dependencies) {
        expect(entry.path).not.toMatch(/(?:routes|styles)\//);
        expect(entry.path).not.toMatch(/PrecinctCanvas|crowdNavigation|navmesh/i);
        expect(sha(readFileSync(new URL(entry.path, root)))).toBe(entry.sha256);
      }
    });
  }
  it("distinguishes actual geometry even though protected station coordinates stay fixed", () => {
    expect(COURTYARD_SCENE_CONTEXT.asset_sha256).not.toBe(OFFICE_SCENE_CONTEXT.asset_sha256);
    expect(COURTYARD_SCENE_CONTEXT.manifest_sha256).not.toBe(OFFICE_SCENE_CONTEXT.manifest_sha256);
    expect(COURTYARD_SCENE_CONTEXT.build_sha256).not.toBe(OFFICE_SCENE_CONTEXT.build_sha256);
  });
});
