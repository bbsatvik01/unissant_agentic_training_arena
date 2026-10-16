/** Boolean playback ownership only: no clock, animation loop, transcript, case or microphone data. */
export function createLocalStaffPlaybackActivity() {
  let active = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => active,
    getServerSnapshot: () => false,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: boolean) {
      if (next === active) return;
      active = next;
      for (const listener of listeners) listener();
    },
  };
}
export const localStaffPlaybackActivity = createLocalStaffPlaybackActivity();
/** Only explicitly playing, unmuted live staff speech needs demand-rendered mouth frames. */
export function staffSpeechNeedsFrames(playing: boolean, paused: boolean, reducedMotion: boolean, replay: boolean): boolean {
  return playing && !paused && !reducedMotion && !replay;
}
