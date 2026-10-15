/** Read only the existing audio owner's actual playback flag. No audio, text, clock or listener owner. */
export const SILENT_CAPTURE_AUDIO_REASON = "Wait for local staff speech to finish before starting silent capture. Its original audio is not recorded.";
export function uncapturedAudioActive(read: (() => unknown) | undefined): boolean {
  if (read === undefined) return false;
  try { return read() !== false; } catch { return true; }
}
