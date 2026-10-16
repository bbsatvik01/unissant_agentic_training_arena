import { describe, expect, it } from "vitest";
import { sceneChangeReason, selectPrecinctWorld, type SceneChangeState } from "./sceneSelection";

const IDLE: SceneChangeState = { captureActive: false, replayActive: false, sessionActive: false, seated: false };

describe("recoverable Office/Courtyard selection", () => {
  it("permits both directions only while idle", () => {
    expect(selectPrecinctWorld("office", "courtyard", IDLE)).toBe("courtyard");
    expect(selectPrecinctWorld("courtyard", "office", IDLE)).toBe("office");
    expect(sceneChangeReason(IDLE)).toBeNull();
  });
  it.each(["captureActive", "replayActive", "sessionActive", "seated"] as const)("locks changes during %s in both directions", (key) => {
    const state = { ...IDLE, [key]: true };
    expect(sceneChangeReason(state)).not.toBeNull();
    expect(selectPrecinctWorld("office", "courtyard", state)).toBe("office");
    expect(selectPrecinctWorld("courtyard", "office", state)).toBe("courtyard");
  });
  it("honors a capture owner's explicit lock", () => {
    const state = { ...IDLE, externalLockReason: "Finishing capture export." };
    expect(sceneChangeReason(state)).toBe("Finishing capture export.");
    expect(selectPrecinctWorld("office", "courtyard", state)).toBe("office");
  });
  it("never loads unknown or external scene names", () => {
    expect(selectPrecinctWorld("office", "https://example.invalid/scene.glb", IDLE)).toBe("office");
    expect(selectPrecinctWorld("courtyard", "unknown", IDLE)).toBe("courtyard");
  });
});
