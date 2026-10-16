/** Scene identity is local presentation metadata. It never changes training case or run ownership. */
export type PrecinctWorldId = "office" | "courtyard";

export interface SceneChangeState {
  readonly captureActive: boolean;
  readonly replayActive: boolean;
  readonly sessionActive: boolean;
  readonly seated: boolean;
  /** An embedding capture/replay owner can impose its own nonempty lock reason. */
  readonly externalLockReason?: string | null;
}

export function sceneChangeReason(state: SceneChangeState): string | null {
  if (state.externalLockReason) return state.externalLockReason;
  if (state.captureActive) return "Finish or cancel the world capture before changing architecture.";
  if (state.replayActive) return "Close the recording before changing architecture.";
  if (state.sessionActive) return "Finish the active interview before changing architecture.";
  if (state.seated) return "Leave the interview seat before changing architecture.";
  return null;
}

/** The event handler also checks the lock; a disabled control alone is not enforcement. */
export function selectPrecinctWorld(current: PrecinctWorldId, requested: string, state: SceneChangeState): PrecinctWorldId {
  if (sceneChangeReason(state) !== null || (requested !== "office" && requested !== "courtyard")) return current;
  return requested;
}
