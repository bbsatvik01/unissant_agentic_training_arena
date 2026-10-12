/**
 * Lips from the audio being played (stage 8): while a voice clip (Gemini TTS) or a live stream (Gemini Live, WP-22)
 * plays for a speaker, its mouth follows that audio's spectrum, not the text timing; the text timeline
 * (`visemes.ts`) stays the fallback when no audio plays. Each frame reads the source's frequency data and maps it to
 * the avatars' viseme weights: the loudness opens the jaw (silence closes it), and where the energy sits shapes it:
 * low (100-500 Hz) for rounded vowels (O, U), the middle (500-2000 Hz) for an open vowel (aa, E), high (2-8 kHz) for
 * spread and sibilant shapes (I, SS). It reads only how the sound is shaped, never what is said or how the speaker
 * might feel, so no face reacts to the content of an answer (PRB-4).
 *
 * Reusable: anything that can fill a frequency array (a Web Audio `AnalyserNode`, through `analyserSource`) attaches
 * for a speaker key with `audioMouth.attach(key, source)` and detaches when its audio ends.
 */
import type { VisemeKey } from "./visemes";

export type Weights = Partial<Record<VisemeKey, number>>;

export interface Bands {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

/** A frequency spectrum to read each frame: bytes 0-255 per bin over [0, sampleRate / 2). */
export interface SpectrumSource {
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly read: (into: Uint8Array<ArrayBuffer>) => void;
}

const LOW: readonly [number, number] = [100, 500];
const MID: readonly [number, number] = [500, 2000];
const HIGH: readonly [number, number] = [2000, 8000];
/** Below this overall level the mouth is closed (room noise, the tail of a word). */
const SILENCE = 0.06;

function band(bins: Uint8Array, hzPerBin: number, [lo, hi]: readonly [number, number]): number {
  const from = Math.max(0, Math.floor(lo / hzPerBin));
  const to = Math.min(bins.length, Math.ceil(hi / hzPerBin));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += bins[i] ?? 0;
  return sum / ((to - from) * 255);
}

/** The mean level (0-1) of the low, mid and high speech bands. */
export function bandLevels(bins: Uint8Array, sampleRate: number, fftSize: number): Bands {
  const hz = sampleRate / fftSize;
  return { low: band(bins, hz, LOW), mid: band(bins, hz, MID), high: band(bins, hz, HIGH) };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** The viseme weights for one frame's band levels; no weights (a closed mouth) on silence. */
export function mouthFromBands({ low, mid, high }: Bands): Weights {
  const level = Math.max(low, mid, high);
  if (level < SILENCE) return {};
  const total = low + mid + high;
  const open = clamp((level - SILENCE) * 1.6);
  const round = low / total;
  const spread = high / total;
  const middle = mid / total;
  return {
    aa: clamp(open * middle * 1.6),
    E: clamp(open * middle * spread * 2),
    O: clamp(open * round * 1.3),
    U: clamp(open * round * round * 1.2),
    I: clamp(open * spread * 1.4),
    SS: clamp(open * spread * spread * 1.6),
  };
}

export interface AudioMouth {
  /** Drive `key`'s mouth from `source` until the returned function is called (or a newer source attaches). */
  readonly attach: (key: string, source: SpectrumSource) => () => void;
  readonly active: (key: string) => boolean;
  /** This frame's weights for `key` from its audio, or null when no audio plays for it (use the text timing). */
  readonly weightsFor: (key: string) => Weights | null;
}

export function createAudioMouth(): AudioMouth {
  const sources = new Map<string, { readonly source: SpectrumSource; readonly bins: Uint8Array<ArrayBuffer> }>();
  return {
    attach(key, source) {
      const entry = { source, bins: new Uint8Array(source.fftSize / 2) };
      sources.set(key, entry);
      return () => {
        if (sources.get(key) === entry) sources.delete(key);
      };
    },
    active: (key) => sources.has(key),
    weightsFor(key) {
      const entry = sources.get(key);
      if (entry === undefined) return null;
      entry.source.read(entry.bins);
      return mouthFromBands(bandLevels(entry.bins, entry.source.sampleRate, entry.source.fftSize));
    },
  };
}

/** A Web Audio analyser as a spectrum source. */
export function analyserSource(analyser: AnalyserNode): SpectrumSource {
  return { sampleRate: analyser.context.sampleRate, fftSize: analyser.fftSize, read: (into) => { analyser.getByteFrequencyData(into); } };
}

/** The page's one mouth registry: the room's voice engine and the live voice attach here; the avatars read it. */
export const audioMouth = createAudioMouth();
