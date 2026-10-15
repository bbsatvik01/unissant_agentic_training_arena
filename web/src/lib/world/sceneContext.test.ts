import { describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { recordingJson, readRecordingFile } from "./recordingFiles";
import { COURTYARD_SCENE_CONTEXT, createCaptureSceneBinding, createMountedSceneContext, isRecordingSceneContext, KNOWN_REPLAY_SCENES, knownReplayScene, MAX_SCENE_CONTEXT_BYTES, OFFICE_SCENE_CONTEXT, readKnownScene, recordingScene } from "./sceneContext";

describe("bounded recorded scene compatibility", () => {
  it("uses only the actual bundled tuple and always resolves absent legacy identity to original Office", () => {
    expect(isRecordingSceneContext(OFFICE_SCENE_CONTEXT)).toBe(true);
    expect(knownReplayScene({ ...OFFICE_SCENE_CONTEXT })).toBe(KNOWN_REPLAY_SCENES[0]);
    expect(recordingScene(undefined)?.worldId).toBe("office");
    expect(recordingScene(OFFICE_SCENE_CONTEXT)?.assetUrl).toBe("/world/precinct.glb");
    expect(new TextEncoder().encode(JSON.stringify(OFFICE_SCENE_CONTEXT)).byteLength).toBeLessThanOrEqual(MAX_SCENE_CONTEXT_BYTES);
    expect(Object.isFrozen(OFFICE_SCENE_CONTEXT)).toBe(true);
    expect(readKnownScene(() => { throw new Error("scene unavailable"); })).toBeNull();
  });
  it("accepts only each complete registered tuple and rejects crossed geometry/build members", () => {
    expect(recordingScene(COURTYARD_SCENE_CONTEXT)?.worldId).toBe("courtyard");
    expect(recordingScene(COURTYARD_SCENE_CONTEXT)?.assetUrl).toBe("/world/precinct-courtyard.glb");
    for (const scene of KNOWN_REPLAY_SCENES) {
      expect(new TextEncoder().encode(JSON.stringify(scene.context)).byteLength).toBeLessThanOrEqual(MAX_SCENE_CONTEXT_BYTES);
      expect(knownReplayScene({ ...scene.context })).toBe(scene);
      expect(Object.isFrozen(scene.context)).toBe(true);
    }
    for (const key of ["asset_sha256", "manifest_sha256", "build_sha256"] as const) {
      expect(knownReplayScene({ ...COURTYARD_SCENE_CONTEXT, [key]: OFFICE_SCENE_CONTEXT[key] })).toBeNull();
      expect(knownReplayScene({ ...OFFICE_SCENE_CONTEXT, [key]: COURTYARD_SCENE_CONTEXT[key] })).toBeNull();
    }
  });
  it("refuses malformed objects, unknown tuples, extra fields, oversized strings and arbitrary URLs", () => {
    const malformed: unknown[] = [null, undefined, [], 1, "office", new Date(), {}, { ...OFFICE_SCENE_CONTEXT, version: 2 },
      { ...OFFICE_SCENE_CONTEXT, scene_id: "northstar-courtyard-v1" }, { ...OFFICE_SCENE_CONTEXT, asset_id: "https://untrusted.invalid/asset.glb" },
      { ...OFFICE_SCENE_CONTEXT, url: "/another.glb" }, { ...OFFICE_SCENE_CONTEXT, [Symbol("hidden")]: "extra" },
      { ...OFFICE_SCENE_CONTEXT, scene_id: "x".repeat(65) }, { ...OFFICE_SCENE_CONTEXT, asset_id: "x".repeat(65) },
      { ...OFFICE_SCENE_CONTEXT, scene_id: "\u0001".repeat(64), asset_id: "\u0001".repeat(64) },
      { ...OFFICE_SCENE_CONTEXT, asset_sha256: "A".repeat(64) }, { ...OFFICE_SCENE_CONTEXT, manifest_sha256: "f".repeat(63) },
      { ...OFFICE_SCENE_CONTEXT, build_sha256: "0".repeat(64) },
      Object.defineProperty({ ...OFFICE_SCENE_CONTEXT }, "scene_id", { get() { throw new Error("refused accessor"); } })];
    for (const value of malformed) expect(knownReplayScene(value)).toBeNull();
    for (const key of Object.keys(OFFICE_SCENE_CONTEXT)) {
      const partial = { ...OFFICE_SCENE_CONTEXT }; Reflect.deleteProperty(partial, key); expect(isRecordingSceneContext(partial)).toBe(false);
    }
    expect(recordingScene({ ...OFFICE_SCENE_CONTEXT, build_sha256: "0".repeat(64) })).toBeNull();
  });
  it("round-trips v2 only, preserves v1 and old v2, and refuses unknown identity atomically", async () => {
    for (const value of [raw, { ...raw, format: "arena.recording.v2", world_events: [] }]) {
      const result = parseRecording(value); if (!result.ok) throw new Error("legacy fixture rejected");
      expect(result.recording.scene_context).toBeUndefined(); expect(recordingScene(result.recording.scene_context)?.worldId).toBe("office");
    }
    for (const scene of KNOWN_REPLAY_SCENES) {
      const current = parseRecording({ ...raw, format: "arena.recording.v2", world_events: [], scene_context: scene.context });
      if (!current.ok) throw new Error(current.errors.join("; "));
      expect(parseRecording(JSON.parse(recordingJson(current.recording)) as unknown)).toEqual(current);
    }
    const result = parseRecording({ ...raw, format: "arena.recording.v2", world_events: [], scene_context: OFFICE_SCENE_CONTEXT });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(parseRecording(JSON.parse(recordingJson(result.recording)) as unknown)).toEqual(result);
    expect(parseRecording({ ...raw, scene_context: OFFICE_SCENE_CONTEXT }).ok).toBe(false);
    for (const scene_context of [null, {}, { ...OFFICE_SCENE_CONTEXT, manifest_sha256: "0".repeat(64) }]) {
      const text = JSON.stringify({ ...raw, format: "arena.recording.v2", world_events: [], scene_context });
      expect((await readRecordingFile({ size: text.length, text: () => Promise.resolve(text) })).ok).toBe(false);
    }
  });
  it("binds an actual ready tuple once and latches mismatch until explicitly cleared", () => {
    const source = createMountedSceneContext(); const binding = createCaptureSceneBinding(source.read);
    expect(binding.matches()).toBe(false); expect(binding.bind()).toBe(false); expect(binding.context()).toBeNull();
    source.set(OFFICE_SCENE_CONTEXT); expect(binding.bind()).toBe(true); expect(binding.bind()).toBe(true); expect(binding.matches()).toBe(true);
    source.set({ ...OFFICE_SCENE_CONTEXT }); expect(binding.matches()).toBe(true);
    source.set(null); expect(binding.matches()).toBe(false); expect(binding.context()).toBe(OFFICE_SCENE_CONTEXT);
    source.set(OFFICE_SCENE_CONTEXT); expect(binding.bind()).toBe(false); expect(binding.matches()).toBe(false);
    binding.clear(); expect(binding.bind()).toBe(true);
  });
  it("publishes only actual scene readiness changes and isolates a failed capture observer", () => {
    const source = createMountedSceneContext(); const notify = vi.fn(); const remove = source.subscribe(notify);
    source.subscribe(() => { throw new Error("capture failed"); });
    expect(() => { source.set(OFFICE_SCENE_CONTEXT); }).not.toThrow(); expect(notify).toHaveBeenCalledOnce();
    source.set({ ...OFFICE_SCENE_CONTEXT }); expect(notify).toHaveBeenCalledOnce();
    remove(); source.set(null); expect(notify).toHaveBeenCalledOnce(); expect(source.read()).toBeNull();
  });
});
