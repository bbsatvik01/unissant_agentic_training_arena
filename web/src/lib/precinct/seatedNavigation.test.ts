import { describe, expect, it } from "vitest";
import { seatedNavigation, type ExplorationPose } from "./seatedNavigation";

const walk: ExplorationPose = { position: [5.7, 0, -12.5], look: { yaw: 0.8, pitch: -0.1 } };
describe("seated navigation ownership", () => {
  it("does nothing until a seat is explicitly selected", () => {
    expect(seatedNavigation(null, walk, false)).toEqual({ saved: null, pose: walk, changed: false });
  });
  it("copies the pre-seat position and look without moving a capsule into a chair", () => {
    const entered = seatedNavigation(null, walk, true);
    expect(entered.changed).toBe(true);
    expect(entered.pose).toBe(walk);
    expect(entered.saved).toEqual(walk);
    expect(entered.saved?.position).not.toBe(walk.position);
    expect(entered.saved?.look).not.toBe(walk.look);
  });
  it("does not replace the return position while seated, and restores exactly once", () => {
    const saved = seatedNavigation(null, walk, true).saved;
    const elsewhere: ExplorationPose = { position: [11, 0, -17.5], look: { yaw: 2, pitch: 0 } };
    expect(seatedNavigation(saved, elsewhere, true)).toEqual({ saved, pose: elsewhere, changed: false });
    const left = seatedNavigation(saved, elsewhere, false);
    expect(left).toEqual({ saved: null, pose: walk, changed: true });
    expect(seatedNavigation(left.saved, left.pose, false).changed).toBe(false);
  });
});
