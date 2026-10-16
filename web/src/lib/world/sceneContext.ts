/** Bounded client compatibility metadata, never a server signature or an asset URL from an upload. */
export const MAX_SCENE_CONTEXT_BYTES = 512;
export interface RecordingSceneContext {
  readonly version: 1;
  readonly scene_id: string;
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly manifest_sha256: string;
  readonly build_sha256: string;
}
export const OFFICE_SCENE_CONTEXT: RecordingSceneContext = Object.freeze({
  version: 1,
  scene_id: "precinct-office-v1",
  asset_id: "precinct.office.v1",
  asset_sha256: "a9801458da3ff10911d49d03ba80cfa60eae9a70e42121b67a3066ec9aab9e9e",
  manifest_sha256: "fc85679e66e176e2fc29c1b6caa2ad364b3a4c60e099fc3c22cc46b26b24552f",
  build_sha256: "3f0cebe1d2b20692c634b2625d179f6f3378217dbbad269d521df70a2210e1a0",
});
export const COURTYARD_SCENE_CONTEXT: RecordingSceneContext = Object.freeze({
  version: 1,
  scene_id: "northstar-courtyard-v1",
  asset_id: "precinct.courtyard.v1",
  asset_sha256: "e985fe9677cf56ce77ee361b8567b5c2bb1eaae9304464f54c473ca2d7c9c4a0",
  manifest_sha256: "a70a2d7685d48231f4fbd1d3d0ad647d370a8ea42670cf3a795476c7ac1caa96",
  build_sha256: "dda90be527aca1b6e889e459cb1dc50971e4054607360071fd832c2b2b7e36c5",
});
/** Full local tuple match only. A build hash identifies bounded adapters, not a full historical renderer. */
export const KNOWN_REPLAY_SCENES = Object.freeze([
  Object.freeze({ context: OFFICE_SCENE_CONTEXT, worldId: "office" as const, label: "Original Office", assetUrl: "/world/precinct.glb" }),
  Object.freeze({ context: COURTYARD_SCENE_CONTEXT, worldId: "courtyard" as const, label: "Courtyard", assetUrl: "/world/precinct-courtyard.glb" }),
]);
export type KnownReplayScene = typeof KNOWN_REPLAY_SCENES[number];
const KEYS = ["version", "scene_id", "asset_id", "asset_sha256", "manifest_sha256", "build_sha256"] as const;
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function knownReplayScene(raw: unknown): KnownReplayScene | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const prototype: unknown = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const value = raw as Readonly<Record<string, unknown>>;
    if (Reflect.ownKeys(value).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(value, key))
      || value["version"] !== 1 || typeof value["scene_id"] !== "string" || value["scene_id"].length > 64
      || typeof value["asset_id"] !== "string" || value["asset_id"].length > 64
      || !digest(value["asset_sha256"]) || !digest(value["manifest_sha256"]) || !digest(value["build_sha256"])
      || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SCENE_CONTEXT_BYTES) return null;
    return KNOWN_REPLAY_SCENES.find((scene) => KEYS.every((key) => value[key] === scene.context[key])) ?? null;
  } catch { return null; }
}
export function isRecordingSceneContext(raw: unknown): raw is RecordingSceneContext { return knownReplayScene(raw) !== null; }
/** Absence is explicitly legacy Office compatibility, never the user's current world preference. */
export function recordingScene(context: RecordingSceneContext | undefined): KnownReplayScene | null {
  return context === undefined ? KNOWN_REPLAY_SCENES[0] ?? null : knownReplayScene(context);
}
export const LEGACY_SCENE_NOTICE = "This legacy file has no scene identity; replay uses the original Office world.";
export type SceneContextReader = () => RecordingSceneContext | null;
export function readKnownScene(read: SceneContextReader): RecordingSceneContext | null {
  try { return knownReplayScene(read())?.context ?? null; } catch { return null; }
}
/** One capture's immutable scene binding. A mismatch latches until an explicit clear, even if it returns. */
export function createCaptureSceneBinding(read: SceneContextReader) {
  let bound: RecordingSceneContext | null = null;
  let invalid = false;
  const bind = () => {
    if (invalid) return false;
    const current = readKnownScene(read);
    if (bound === null) { if (current === null) return false; bound = current; return true; }
    if (current !== bound) invalid = true;
    return !invalid;
  };
  const matches = () => {
    if (bound === null || invalid) return false;
    if (readKnownScene(read) !== bound) invalid = true;
    return !invalid;
  };
  return { bind, matches, context: () => bound, clear: () => { bound = null; invalid = false; } };
}
/** Route-owned readiness capability; callbacks, not render-time mutation, install the actual mounted scene. */
export function createMountedSceneContext() {
  let current: RecordingSceneContext | null = null;
  const listeners = new Set<() => void>();
  return {
    read: (): RecordingSceneContext | null => current,
    set: (value: RecordingSceneContext | null) => {
      const next = knownReplayScene(value)?.context ?? null;
      if (current === next) return;
      current = next;
      for (const notify of listeners) { try { notify(); } catch { /* Capture observers cannot break scene ownership. */ } }
    },
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
  };
}
export type MountedSceneContext = ReturnType<typeof createMountedSceneContext>;
