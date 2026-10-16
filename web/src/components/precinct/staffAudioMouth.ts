/** Existing actor frame only. Live audio spectrum drives these mouth morphs; silence always closes them. */
import { Mesh, type Object3D } from "three";
import type { Weights } from "../../lib/world/audioLips";
import { VISEMES } from "../../lib/world/visemes";
const MORPHS = ["AA_VI_00_Sil", "AA_VI_01_PP", "AA_VI_02_FF", "AA_VI_03_TH", "AA_VI_04_DD", "AA_VI_05_KK", "AA_VI_06_CH", "AA_VI_07_SS", "AA_VI_08_nn", "AA_VI_09_RR", "AA_VI_10_aa", "AA_VI_11_E", "AA_VI_12_I", "AA_VI_13_O", "AA_VI_14_U"] as const;
export function prepareStaffAudioMouth(scene: Object3D): (weights: Weights | null) => void {
  const faces: Mesh[] = [];
  scene.traverse((node) => { if (node instanceof Mesh && node.morphTargetDictionary !== undefined) faces.push(node as Mesh); });
  const safe = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (weights) => {
    for (const face of faces) {
      const values = face.morphTargetInfluences;
      const dictionary = face.morphTargetDictionary;
      if (values === undefined || dictionary === undefined) continue;
      VISEMES.forEach((key, slot) => {
        const name = MORPHS[slot]; const index = name === undefined ? undefined : dictionary[name];
        if (index !== undefined) values[index] = key === "sil" ? 0 : safe(weights?.[key]);
      });
      const jaw = dictionary["AK_25_JawOpen"];
      if (jaw !== undefined) values[jaw] = Math.min(1, safe(weights?.aa) + safe(weights?.O)) * 0.25;
    }
  };
}
