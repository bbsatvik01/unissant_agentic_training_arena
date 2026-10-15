import { describe, expect, it } from "vitest";
import { applicableOrientationOffer, createOrientationHandoff, type OrientationContext } from "./orientationHandoff";
const idle: OrientationContext = { caseId: "C1", userId: "U1", source: "idle", runKey: null };
const earned = { briefed: true, fileReviewed: true };
describe("explicit orientation preparation handoff", () => {
  it("requires an explicit idle offer and binds only its successful run", () => {
    const handoff = createOrientationHandoff();
    handoff.update({ ...idle, source: "live", runKey: "run1" });
    expect(handoff.getSnapshot()).toBeNull();
    handoff.arm(idle, earned, "idle-room");
    handoff.update({ ...idle, source: "live" });
    expect(handoff.getSnapshot()?.runKey).toBeNull();
    handoff.update({ ...idle, source: "live", runKey: "run1" });
    expect(applicableOrientationOffer(handoff.getSnapshot(), { ...idle, source: "live", runKey: "run1" })).toMatchObject({ ...earned, runKey: "run1" });
    handoff.update({ ...idle, source: "live", runKey: "another" });
    expect(handoff.getSnapshot()).toBeNull();
  });
  it("retains a failed pending start but clears on user, case, playback, stop or explicit discard", () => {
    for (const changed of [{ ...idle, userId: "U2", source: "live" as const }, { ...idle, caseId: "C2", source: "live" as const }, { ...idle, source: "recording" as const }, idle]) {
      const handoff = createOrientationHandoff(); handoff.arm(idle, earned, "idle-room");
      handoff.update({ ...idle, source: "live" }); handoff.update({ ...idle, source: "live" });
      expect(handoff.getSnapshot()).toMatchObject(earned);
      handoff.update(changed); expect(handoff.getSnapshot()).toBeNull();
    }
    const handoff = createOrientationHandoff(); handoff.arm(idle, earned, "idle-room"); handoff.clear();
    expect(handoff.getSnapshot()).toBeNull();
    handoff.arm({ ...idle, source: "recording" }, earned, "recorded-room"); expect(handoff.getSnapshot()).toBeNull();
  });
});
