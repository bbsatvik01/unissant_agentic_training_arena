/**
 * Speech cadence for the world's figures (D-020): a figure "speaks" a streamed text line at a reading pace, and
 * its mouth opens from the characters at the current position. Pure: the same text and elapsed time always give
 * the same value. Cadence reads only the characters' shapes (vowel, consonant, pause), never what the text means,
 * so no figure reacts to the content of an answer (PRB-4; S6 6.4 forbidden inputs).
 */

/** Characters spoken per second (about 170 words a minute). */
export const CHARS_PER_SECOND = 15;

/** The longest line the stream carries: a subject answer's `maxLength` (events.schema.json SubjectAnswer). */
export const MAX_LINE_CHARS = 900;

/** The shortest and longest time one line is spoken: the longest covers the longest line at the reading pace, so a
 * line is always spoken in full (and a voice fitted to it, `fitRate`, ends with its mouth and shot). */
export const MIN_SPEECH_MS = 700;
export const MAX_SPEECH_MS = (MAX_LINE_CHARS / CHARS_PER_SECOND) * 1000;

const VOWELS = new Set("aeiouyAEIOUY");
const PAUSES = new Set(".,;:!?");

/** How long `text` is spoken, in ms. */
export function speechDurationMs(text: string): number {
  const ms = (text.length / CHARS_PER_SECOND) * 1000;
  return Math.min(MAX_SPEECH_MS, Math.max(MIN_SPEECH_MS, Math.round(ms)));
}

/** How far the spoken position of `text` is at `elapsedMs`: 0..1, 1 once the line is done. */
export function speechProgress(text: string, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / speechDurationMs(text));
}

/** Mouth openness 0..1 at `elapsedMs` into speaking `text`; 0 before it starts and after it ends. */
export function mouthAt(text: string, elapsedMs: number): number {
  if (elapsedMs < 0 || text.length === 0) return 0;
  const duration = speechDurationMs(text);
  if (elapsedMs >= duration) return 0;
  const index = Math.min(text.length - 1, Math.floor((elapsedMs / duration) * text.length));
  const ch = text.charAt(index);
  if (PAUSES.has(ch)) return 0;
  if (ch === " ") return 0.15;
  if (VOWELS.has(ch)) return 0.85;
  if (/\d/.test(ch)) return 0.5;
  return 0.4;
}
