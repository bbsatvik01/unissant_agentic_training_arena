import { Bone, BoxGeometry, Group, MeshStandardMaterial, Skeleton, SkinnedMesh } from "three";
export function syntheticRig() {
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
