/**
 * Lip sync from the text stream (D-025): the line being spoken is turned into the 15 Oculus visemes the avatars carry
 * as morph targets (`AA_VI_00_Sil` .. `AA_VI_14_U`), timed on the same reading pace as `cadence.ts`, so the mouth,
 * the caption and the transcript stay in step. Pure: the same text and elapsed time give the same weights.
 *
 * The mapping is grapheme based (English spelling to the nearest viseme, with the common digraphs). It reads only the
 * letters' sounds, never what the text means, so no face reacts to the content of an answer (PRB-4). A text-to-speech
 * engine that reports its own viseme timeline can replace `visemeTrack` behind the same `VisemeKey` seam.
 */
import { speechDurationMs } from "./cadence";

export const VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
export type VisemeKey = (typeof VISEMES)[number];

/** One viseme held over [start, end) ms from the start of the line. */
export interface VisemeSpan {
  readonly key: VisemeKey;
  readonly start: number;
  readonly end: number;
}

const DIGRAPHS: readonly (readonly [string, VisemeKey])[] = [
  ["th", "TH"],
  ["sh", "CH"],
  ["ch", "CH"],
  ["ph", "FF"],
  ["ng", "nn"],
  ["ck", "kk"],
  ["qu", "kk"],
  ["oo", "U"],
  ["ee", "I"],
  ["ea", "I"],
  ["ou", "O"],
  ["ow", "O"],
  ["ai", "E"],
  ["ay", "E"],
];

const LETTER: Readonly<Record<string, VisemeKey>> = {
  a: "aa",
  b: "PP",
  c: "kk",
  d: "DD",
  e: "E",
  f: "FF",
  g: "kk",
  h: "kk",
  i: "I",
  j: "CH",
  k: "kk",
  l: "nn",
  m: "PP",
  n: "nn",
  o: "O",
  p: "PP",
  q: "kk",
  r: "RR",
  s: "SS",
  t: "DD",
  u: "U",
  v: "FF",
  w: "U",
  x: "SS",
  y: "I",
  z: "SS",
};

/** Characters that hold the mouth closed for a beat (punctuation pauses longer than a space). */
const PAUSE_WEIGHT: Readonly<Record<string, number>> = { ".": 3, "?": 3, "!": 3, ",": 2, ";": 2, ":": 2 };

interface Unit {
  readonly key: VisemeKey;
  readonly weight: number;
}

/** The text as viseme units, each with a relative length. */
export function visemeUnits(text: string): readonly Unit[] {
  const units: Unit[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const pair = lower.slice(i, i + 2);
    const digraph = DIGRAPHS.find(([g]) => g === pair);
    if (digraph !== undefined) {
      units.push({ key: digraph[1], weight: 1.4 });
      i += 2;
      continue;
    }
    const ch = lower.charAt(i);
    const pause = PAUSE_WEIGHT[ch];
    const letter = LETTER[ch];
    if (pause !== undefined) units.push({ key: "sil", weight: pause });
    else if (letter !== undefined) units.push({ key: letter, weight: 1 });
    else if (/\d/.test(ch)) units.push({ key: "aa", weight: 1.5 });
    else units.push({ key: "sil", weight: 0.6 });
    i += 1;
  }
  return units;
}

/** The line's viseme timeline, stretched over its speaking time; consecutive equal visemes merge. */
export function visemeTrack(text: string): readonly VisemeSpan[] {
  const units = visemeUnits(text);
  const total = units.reduce((sum, u) => sum + u.weight, 0);
  if (total === 0) return [];
  const duration = speechDurationMs(text);
  const spans: VisemeSpan[] = [];
  let at = 0;
  for (const u of units) {
    const length = (u.weight / total) * duration;
    const last = spans.at(-1);
    if (last?.key === u.key) spans[spans.length - 1] = { ...last, end: at + length };
    else spans.push({ key: u.key, start: at, end: at + length });
    at += length;
  }
  return spans;
}

/** How quickly a viseme blends in and out, in ms (co-articulation). */
export const BLEND_MS = 70;

/**
 * The viseme weights at `elapsedMs` into the line: the current viseme at full weight, blending with its neighbours
 * across BLEND_MS at each boundary. Silence and the time outside the line give no weights.
 */
export function visemeWeightsAt(track: readonly VisemeSpan[], elapsedMs: number): Partial<Record<VisemeKey, number>> {
  const weights: Partial<Record<VisemeKey, number>> = {};
  if (track.length === 0) return weights;
  const end = track[track.length - 1]?.end ?? 0;
  if (elapsedMs < 0 || elapsedMs >= end) return weights;
  for (const span of track) {
    if (span.key === "sil") continue;
    const rise = Math.min(1, (elapsedMs - span.start + BLEND_MS) / BLEND_MS);
    const fall = Math.min(1, (span.end + BLEND_MS - elapsedMs) / BLEND_MS);
    const w = Math.max(0, Math.min(rise, fall));
    if (w > 0) weights[span.key] = Math.max(weights[span.key] ?? 0, w);
  }
  return weights;
}

/** Word starts in the line (ms), for head and hand beats on stressed words: words of four letters or more. */
export function beatTimes(text: string): readonly number[] {
  const duration = speechDurationMs(text);
  const beats: number[] = [];
  const re = /[A-Za-z0-9'-]{4,}/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) beats.push((m.index / Math.max(1, text.length)) * duration);
  return beats;
}

/** Where the line's timeline is when the voice reaches character `charIndex` (ms): the viseme units before it,
 * over all of them, of the speaking time. A synthesized voice's word boundaries map onto the track with it. */
export function timeAtChar(text: string, charIndex: number): number {
  const weight = (units: readonly Unit[]) => units.reduce((sum, u) => sum + u.weight, 0);
  const total = weight(visemeUnits(text));
  if (total === 0) return 0;
  const at = Math.max(0, Math.min(text.length, charIndex));
  return (weight(visemeUnits(text.slice(0, at))) / total) * speechDurationMs(text);
}
