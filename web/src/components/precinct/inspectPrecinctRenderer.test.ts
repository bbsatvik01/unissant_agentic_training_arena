// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, Texture } from "three";
import { inspectPrecinctScene } from "./inspectPrecinctRenderer";

describe("scene resource inspection", () => {
  it("reports the actual scene environment rather than the requested tier", () => {
    const scene = new Scene();
    expect(inspectPrecinctScene(scene)).toMatchObject({ environmentMapActive: false, environmentIntensity: 1 });
    scene.environment = new Texture(); scene.environmentIntensity = 0.45;
    expect(inspectPrecinctScene(scene)).toMatchObject({ environmentMapActive: true, environmentIntensity: 0.45 });
    scene.environment.dispose();
  });
  it("deduplicates maps, retains honest unknowns, and counts actual culling flags", () => {
    const texture = new Texture({ width: 1024, height: 512 });
    const unknown = new Texture(); const material = new MeshStandardMaterial({ map: texture, normalMap: texture, alphaMap: unknown, transparent: true });
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(), material); mesh.frustumCulled = false; mesh.castShadow = true;
    scene.add(mesh, new Mesh(new BoxGeometry(), [material]));
    const result = inspectPrecinctScene(scene);
    expect(result.meshes).toBe(2); expect(result.uncullableMeshes).toBe(1); expect(result.shadowCastingMeshes).toBe(1);
    expect(result.uniqueMaterials).toBe(1); expect(result.transparentMaterials).toBe(1);
    expect(result.materialTextures).toBe(2); expect(result.unknownTextureDimensions).toBe(1);
    expect(result.materialTextureRgba8MiBEstimate).toBeCloseTo(8 / 3);
    texture.generateMipmaps = false;
    expect(inspectPrecinctScene(scene).materialTextureRgba8MiBEstimate).toBe(2);
    expect(result.textureEstimateCaveat).toContain("Not measured VRAM");
  });
});
