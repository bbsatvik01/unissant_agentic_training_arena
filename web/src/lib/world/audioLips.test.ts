import { describe, expect, it } from "vitest";

import { bandLevels, createAudioMouth, mouthFromBands, type SpectrumSource } from "./audioLips";

const RATE = 24_000;
const FFT = 512; // 256 bins of 46.875 Hz

/** A spectrum with energy (0-255) in [lo, hi) Hz. */
function spectrum(parts: readonly (readonly [number, number, number])[]): Uint8Array {
  const bins = new Uint8Array(FFT / 2);
  const hz = RATE / FFT;
  for (const [lo, hi, level] of parts) for (let i = Math.floor(lo / hz); i < Math.min(bins.length, Math.ceil(hi / hz)); i++) bins[i] = level;
  return bins;
}

describe("lips from the played audio", () => {
  it("measures the low, mid and high speech bands", () => {
    const b = bandLevels(spectrum([[150, 450, 200]]), RATE, FFT);
    expect(b.low).toBeGreaterThan(0.5);
    expect(b.mid).toBe(0);
    expect(b.high).toBe(0);
  });

  it("closes the mouth on silence, opens it with loudness, and shapes it by where the energy sits", () => {
    expect(mouthFromBands({ low: 0, mid: 0, high: 0 })).toEqual({});
    const open = mouthFromBands({ low: 0.5, mid: 0.8, high: 0.2 });
    const round = mouthFromBands({ low: 0.9, mid: 0.2, high: 0.05 });
    const spread = mouthFromBands({ low: 0.2, mid: 0.4, high: 0.9 });
    expect(open.aa ?? 0).toBeGreaterThan(round.aa ?? 0);
    expect((round.O ?? 0) + (round.U ?? 0)).toBeGreaterThan((open.O ?? 0) + (open.U ?? 0));
    expect((spread.I ?? 0) + (spread.SS ?? 0)).toBeGreaterThan((round.I ?? 0) + (round.SS ?? 0));
    const loud = mouthFromBands({ low: 0.6, mid: 0.9, high: 0.3 });
    const soft = mouthFromBands({ low: 0.12, mid: 0.18, high: 0.06 });
    expect(loud.aa ?? 0).toBeGreaterThan(soft.aa ?? 0);
    for (const w of Object.values(loud)) expect(w).toBeLessThanOrEqual(1);
  });

  it("drives a speaker's mouth only while a source is attached for it, for any audio (TTS clip or Live stream)", () => {
    const mouth = createAudioMouth();
    let bins = spectrum([[500, 1800, 230]]);
    const source: SpectrumSource = { sampleRate: RATE, fftSize: FFT, read: (into) => { into.set(bins); } };
    expect(mouth.weightsFor("subject:A")).toBe(null);
    const detach = mouth.attach("subject:A", source);
    expect(mouth.active("subject:A")).toBe(true);
    expect(mouth.weightsFor("subject:A")?.aa ?? 0).toBeGreaterThan(0.3);
    expect(mouth.weightsFor("subject:B")).toBe(null);
    bins = new Uint8Array(FFT / 2);
    expect(mouth.weightsFor("subject:A")).toEqual({});
    detach();
    expect(mouth.weightsFor("subject:A")).toBe(null);
    // A newer source for the same speaker replaces the older; the older's detach no longer removes it.
    const first = mouth.attach("k", source);
    const second = mouth.attach("k", source);
    first();
    expect(mouth.active("k")).toBe(true);
    second();
    expect(mouth.active("k")).toBe(false);
  });
});
