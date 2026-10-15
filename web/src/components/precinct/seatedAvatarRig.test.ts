import { Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial, Skeleton, SkinnedMesh, Texture, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";

import { prepareSeatedRig, seatedResources, seatedTextureUrls } from "./seatedAvatarRig";

function resources(avatar: string, names: readonly string[]) {
  const source = new Group();
  const geometry = new BoxGeometry();
  const materials = names.map((name) => new MeshStandardMaterial({ name }));
  const mesh = new Mesh(geometry, materials);
  const textures = Array.from({ length: 6 }, () => new Texture());
  source.add(mesh);
  return { source, geometry, materials, textures, owned: seatedResources(source, textures, avatar) };
}

describe("seated avatar asset ownership", () => {
  it("uses existing Rocketbox files and the known optional-texture catalogue", () => {
    expect(seatedTextureUrls("Male_Adult_12")).toHaveLength(4);
    expect(seatedTextureUrls("Business_Female_02")).toHaveLength(6);
    expect(seatedTextureUrls("Male_Adult_05").at(-1)).toBe("/avatars/Male_Adult_05/opacity.png");
  });
  it("clones materials and texture settings, disposing none of the shared cache", () => {
    const fixture = resources("Business_Female_02", ["person_body", "person_head", "person_opacity", "person_glasses", "unexpected"]);
    const disposeSource = fixture.materials.map((material) => vi.spyOn(material, "dispose"));
    const disposeTextures = fixture.textures.map((texture) => vi.spyOn(texture, "dispose"));
    const disposeGeometry = vi.spyOn(fixture.geometry, "dispose");
    const clones: MeshStandardMaterial[] = [];
    fixture.owned.scene.traverse((object) => {
      if (object instanceof Mesh) clones.push(...(Array.isArray(object.material) ? object.material : [object.material]) as MeshStandardMaterial[]);
    });
    expect(clones).toHaveLength(5);
    clones.forEach((material, index) => { expect(material).not.toBe(fixture.materials[index]); });
    expect(clones[0]?.map).not.toBe(fixture.textures[0]);
    expect(clones[0]?.map?.colorSpace).toBe("srgb");
    expect(fixture.textures[0]?.colorSpace).toBe("");
    const disposeOwned = clones.map((material) => vi.spyOn(material, "dispose"));
    fixture.owned.dispose();
    disposeOwned.forEach((spy) => { expect(spy).toHaveBeenCalledOnce(); });
    [...disposeSource, ...disposeTextures, disposeGeometry].forEach((spy) => { expect(spy).not.toHaveBeenCalled(); });
  });
  it("deduplicates reused materials and tolerates absent optional textures", () => {
    const source = new Group(); const material = new MeshStandardMaterial({ name: "known_opacity" });
    const geometry = new BoxGeometry(); source.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const owned = seatedResources(source, [], "Male_Adult_12");
    const meshes: Mesh[] = []; owned.scene.traverse((object) => { if (object instanceof Mesh) meshes.push(object as Mesh); });
    expect(meshes[0]?.material).toBe(meshes[1]?.material);
    expect(meshes[0]?.material).not.toBe(material); owned.dispose();
  });
});

function syntheticRig() {
  const root = new Group(); const pelvis = new Bone(); pelvis.name = "Bip01_Pelvis"; pelvis.position.y = 0.9; root.add(pelvis);
  const spine = new Bone(); spine.name = "Bip01_Spine2"; spine.position.y = 0.35; pelvis.add(spine);
  const head = new Bone(); head.name = "Bip01_Head"; head.position.y = 0.35; spine.add(head);
  const feet: Bone[] = [];
  for (const [side, x] of [["L", 0.1], ["R", -0.1]] as const) {
    const thigh = new Bone(); thigh.name = `Bip01_${side}_Thigh`; thigh.position.x = x; pelvis.add(thigh);
    const calf = new Bone(); calf.name = `Bip01_${side}_Calf`; calf.position.y = -0.4; thigh.add(calf);
    const foot = new Bone(); foot.name = `Bip01_${side}_Foot`; foot.position.y = -0.4; calf.add(foot); feet.push(foot);
    const upper = new Bone(); upper.name = `Bip01_${side}_UpperArm`; upper.position.set(x * 2, 0.1, 0); spine.add(upper);
    const fore = new Bone(); fore.name = `Bip01_${side}_Forearm`; fore.position.set(x, -0.25, 0); upper.add(fore);
    const hand = new Bone(); hand.name = `Bip01_${side}_Hand`; hand.position.y = -0.25; fore.add(hand);
  }
  const mesh = new SkinnedMesh(new BoxGeometry(), new MeshStandardMaterial());
  mesh.morphTargetDictionary = { AA_VI_10_aa: 0, AK_25_JawOpen: 1, AK_09_EyeBlinkLeft: 2, AK_10_EyeBlinkRight: 3 };
  mesh.morphTargetInfluences = [0, 0, 0, 0]; mesh.bind(new Skeleton([pelvis])); root.add(mesh);
  root.updateMatrixWorld(true);
  return { root, pelvis, head, feet, mesh };
}

describe("original seated rig", () => {
  it("fits the pelvis to the cushion and keeps both feet at their standing floor height", () => {
    const fixture = syntheticRig();
    const original = fixture.feet.map((foot) => foot.getWorldPosition(new Vector3()).y);
    prepareSeatedRig(fixture.root); fixture.root.updateMatrixWorld(true);
    expect(fixture.pelvis.getWorldPosition(new Vector3()).y).toBeCloseTo(0.62, 6);
    fixture.feet.forEach((foot, index) => {
      expect(foot.getWorldPosition(new Vector3()).y).toBeCloseTo(original[index] ?? 0, 6);
      expect(foot.getWorldPosition(new Vector3()).z).toBeGreaterThan(0.4);
    });
  });
  it("restores bone rotations before each frame and resets mouths after audio stops", () => {
    const { root, head, mesh } = syntheticRig(); const rig = prepareSeatedRig(root);
    const step = () => { rig.reset(); rig.rotate("Bip01_Spine2", "pitch", 0.08); rig.look([0.1, 1.3, 3]); rig.rotate("Bip01_Head", "roll", 0.03); };
    step(); const first = head.quaternion.clone();
    for (let frame = 0; frame < 120; frame++) step();
    expect(head.quaternion.angleTo(first)).toBeLessThan(0.00001);
    rig.face({ aa: 0.8 }, 0.5); expect(mesh.morphTargetInfluences).toEqual([0.8, 0.2, 0.5, 0.5]);
    rig.face({}, 0); expect(mesh.morphTargetInfluences).toEqual([0, 0, 0, 0]);
  });
  it("tolerates an incomplete rig without failing the rest of the precinct", () => {
    const rig = prepareSeatedRig(new Group());
    expect(() => { rig.reset(); rig.rotate("Bip01_Head", "pitch", 0.1); rig.look([0, 1, 0]); rig.face({}, 0); }).not.toThrow();
  });
});

