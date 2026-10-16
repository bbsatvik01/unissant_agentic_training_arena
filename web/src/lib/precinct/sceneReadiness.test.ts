import { describe, expect, it } from "vitest";
import { createSceneReadiness, reportSceneUnavailable } from "./sceneReadiness";

describe("mounted scene readiness", () => {
  it("requires mount and actual geometry readiness", () => {
    const scene = createSceneReadiness("courtyard");
    expect(scene.isActive()).toBe(false);
    expect(scene.markReady()).toBe(false);
    expect(scene.isReady()).toBe(false);
    scene.activate();
    expect(scene.isActive()).toBe(true);
    expect(scene.isReady()).toBe(false);
    expect(scene.markReady()).toBe(true);
    expect(scene.isReady()).toBe(true);
  });
  it("keeps current fallback navigation active while refusing late geometry readiness", () => {
    const scene = createSceneReadiness("office");
    expect(scene.markUnavailable()).toBe(false);
    scene.activate(); scene.markReady(); expect(scene.markUnavailable()).toBe(true);
    expect(scene.isActive()).toBe(true); expect(scene.isReady()).toBe(false);
    expect(scene.markReady()).toBe(false);
    scene.expire(); expect(scene.markUnavailable()).toBe(false);
  });
  it("rejects late readiness and samples after the old scene expires", () => {
    const office = createSceneReadiness("office");
    office.activate(); office.markReady(); office.expire();
    const courtyard = createSceneReadiness("courtyard");
    courtyard.activate();
    expect(office.isReady()).toBe(false);
    expect(office.markReady()).toBe(false);
    expect(office.isActive()).toBe(false);
    expect(courtyard.isReady()).toBe(false);
    courtyard.markReady();
    expect(courtyard.isReady()).toBe(true);
    expect(office.isReady()).toBe(false);
  });
  it("reports an initial child failure after the parent activates its mounted scene", async () => {
    const scene = createSceneReadiness("office"); let reports = 0;
    reportSceneUnavailable(scene, () => { reports += 1; });
    expect(reports).toBe(0); expect(scene.isActive()).toBe(false);
    scene.activate(); await Promise.resolve();
    expect(reports).toBe(1); expect(scene.isActive()).toBe(true);
    expect(scene.isReady()).toBe(false); expect(scene.markReady()).toBe(false);
  });
  it("invalidates an already mounted scene synchronously", () => {
    const scene = createSceneReadiness("courtyard"); let reports = 0;
    scene.activate(); scene.markReady();
    reportSceneUnavailable(scene, () => { reports += 1; });
    expect(reports).toBe(1); expect(scene.isReady()).toBe(false);
  });
  it("does not revive an expired scene through a deferred failure", async () => {
    const old = createSceneReadiness("office"); let reports = 0;
    reportSceneUnavailable(old, () => { reports += 1; });
    old.activate(); old.expire();
    const current = createSceneReadiness("courtyard"); current.activate(); current.markReady();
    await Promise.resolve();
    expect(reports).toBe(0); expect(old.isActive()).toBe(false); expect(current.isReady()).toBe(true);
    reportSceneUnavailable(old, () => { reports += 1; }); await Promise.resolve();
    expect(reports).toBe(0); expect(old.isActive()).toBe(false); expect(current.isReady()).toBe(true);
  });
});
