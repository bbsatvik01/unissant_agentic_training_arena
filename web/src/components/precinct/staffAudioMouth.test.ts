import { describe, expect, it } from "vitest";
import { Group, Mesh } from "three";
import { prepareStaffAudioMouth } from "./staffAudioMouth";
describe("staff audio mouth presentation", () => {
  it("applies spectrum weights only and closes on silence, pause, mute or absent/replayed audio", () => {
    const scene = new Group(); const face = new Mesh(); scene.add(face);
    face.morphTargetDictionary = { AA_VI_10_aa: 0, AA_VI_13_O: 1, AK_25_JawOpen: 2, AK_09_EyeBlinkLeft: 3 };
    face.morphTargetInfluences = [0, 0, 0, 0.4];
    const apply = prepareStaffAudioMouth(scene); apply({ aa: 0.5, O: 0.25 });
    expect(face.morphTargetInfluences).toEqual([0.5, 0.25, 0.1875, 0.4]);
    apply({}); expect(face.morphTargetInfluences).toEqual([0, 0, 0, 0.4]);
    apply({ aa: 1 }); apply(null); expect(face.morphTargetInfluences).toEqual([0, 0, 0, 0.4]);
    apply({ aa: NaN, O: Infinity }); expect(face.morphTargetInfluences).toEqual([0, 0, 0, 0.4]);
  });
});
