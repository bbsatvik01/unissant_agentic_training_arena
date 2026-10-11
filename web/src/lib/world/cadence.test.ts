import { describe, expect, it } from "vitest";

import { CHARS_PER_SECOND, MAX_SPEECH_MS, MIN_SPEECH_MS, mouthAt, speechDurationMs, speechProgress } from "./cadence";

describe("speech cadence", () => {
  it("speaks at a reading pace, within the shortest and longest line", () => {
    const text = "x".repeat(CHARS_PER_SECOND * 3);
    expect(speechDurationMs(text)).toBe(3000);
    expect(speechDurationMs("Yes.")).toBe(MIN_SPEECH_MS);
    expect(speechDurationMs("x".repeat(10_000))).toBe(MAX_SPEECH_MS);
  });

  it("opens the mouth by character shape: vowel, consonant, digit, space, pause", () => {
    const text = "a b.1".padEnd(CHARS_PER_SECOND, "a");
    const step = speechDurationMs(text) / text.length;
    expect(mouthAt(text, step * 0 + 1)).toBe(0.85);
    expect(mouthAt(text, step * 1 + 1)).toBe(0.15);
    expect(mouthAt(text, step * 2 + 1)).toBe(0.4);
    expect(mouthAt(text, step * 3 + 1)).toBe(0);
    expect(mouthAt(text, step * 4 + 1)).toBe(0.5);
  });

  it("keeps the mouth closed before, after and for an empty line", () => {
    expect(mouthAt("Hello there.", -1)).toBe(0);
    expect(mouthAt("Hello there.", speechDurationMs("Hello there."))).toBe(0);
    expect(mouthAt("", 10)).toBe(0);
  });

  it("reports progress from 0 to 1", () => {
    expect(speechProgress("Hello there, friend.", 0)).toBe(0);
    expect(speechProgress("Hello there, friend.", speechDurationMs("Hello there, friend.") / 2)).toBeCloseTo(0.5);
    expect(speechProgress("Hello there, friend.", 99_999)).toBe(1);
  });
});
