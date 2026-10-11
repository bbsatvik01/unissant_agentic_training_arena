/**
 * Text-to-speech voice choice (stage 2): each persona speaks with its own system voice, chosen from what the
 * browser offers by the persona's ordered preferences (name prefixes), then any natural English voice, never one of
 * the novelty voices. Pure, so the same list and persona always give the same voice. The speaking itself is the
 * browser's `speechSynthesis`; Gemini TTS or Live can replace it behind the same seam (WP-22).
 */

import { speechDurationMs } from "../world/cadence";

export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
}

/** Built-in novelty and effect voices that never read a line. */
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Junior|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Ralph|Kathy)\b/;

/** The voice for a persona: its first preference available, else the first natural English voice, else null. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], prefer: readonly string[]): V | null {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en") && !NOVELTY.test(v.name));
  for (const name of prefer) {
    const hit = english.find((v) => v.name.startsWith(name));
    if (hit !== undefined) return hit;
  }
  return english[0] ?? null;
}

/** Utterance settings from the persona's multipliers, clamped to what speech synthesis accepts. */
export function utteranceSettings(voice: { readonly pitch: number; readonly rate: number }): { pitch: number; rate: number } {
  return { pitch: Math.min(2, Math.max(0, voice.pitch)), rate: Math.min(2, Math.max(0.5, voice.rate)) };
}

/** Characters a system voice speaks per second at rate 1 (about 165 words a minute). */
export const VOICE_CPS = 14;

/** The rate for `text`: the persona's rate, raised (up to the synthesis limit of 2) when the voice would otherwise
 * run past the line's speaking time on the clock, so the voice ends with the line's mouth and shot. */
export function fitRate(text: string, rate: number): number {
  const spokenMs = (text.length / (VOICE_CPS * rate)) * 1000;
  const fitted = rate * Math.max(1, spokenMs / speechDurationMs(text));
  return Math.min(2, fitted);
}
