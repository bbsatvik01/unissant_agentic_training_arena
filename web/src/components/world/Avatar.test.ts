/**
 * The avatar's frame step holds a stable pose: the procedural layers are applied on top of the clips each frame and
 * never accumulate, whether the clips are running or paused (reduced motion, the pause control).
 */
import { AnimationMixer, Bone, Group } from "three";
import { describe, expect, it } from "vitest";

import { subjectPersona } from "../../lib/world/cast";
import { stepAvatar, type IdleState, type Rig } from "./Avatar";

function rig(): { root: Group; rig: Rig } {
  const root = new Group();
  const spine = new Bone();
  const neck = new Bone();
  const head = new Bone();
  const lEye = new Bone();
  const rEye = new Bone();
  spine.position.set(0, 1, 0);
  neck.position.set(0, 0.3, 0);
  head.position.set(0, 0.1, 0);
  lEye.position.set(0.03, 0.08, 0.09);
  rEye.position.set(-0.03, 0.08, 0.09);
  root.add(spine);
  spine.add(neck);
  neck.add(head);
  head.add(lEye, rEye);
  return { root, rig: { faces: [], head, neck, spine, lEye, rEye, rUpper: null, rFore: null, lFore: null, rHand: null, lHand: null } };
}

function state(): IdleState {
  return { nextSaccade: 0, eyeX: 0, eyeY: 0, nextBlink: 1.5, blinkAt: -10, nextLook: 14, lookEnds: 0, headYaw: 0, headPitch: 0, handing: 0, pointing: 0, base: new Map() };
}

describe("stepAvatar", () => {
  it.each([true, false])("keeps the head pose stable over many frames (still: %s)", (still) => {
    const { root, rig: r } = rig();
    const ctx = {
      rig: r,
      mixer: new AnimationMixer(root),
      scene: root,
      track: [],
      beats: [],
      actions: [],
      thinking: false,
      still,
      pose: "listening" as const,
      speech: null,
      persona: subjectPersona("Jordan Pell"),
      gaze: [0.6, 1.4, 2] as const,
      clock: { current: 0 },
      random: () => 0.5,
    };
    const s = state();
    stepAvatar(ctx, s, 0, 1 / 60);
    for (let i = 0; i < 300; i += 1) stepAvatar(ctx, s, i / 60, 1 / 60);
    const settled = r.head?.quaternion.clone();
    for (let i = 0; i < 120; i += 1) stepAvatar(ctx, s, (i + 300) / 60, 1 / 60);
    expect(r.head?.quaternion.angleTo(settled ?? r.head.quaternion)).toBeLessThan(0.02);
  });
});
