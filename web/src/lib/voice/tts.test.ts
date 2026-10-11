import { describe, expect, it } from "vitest";

import { speechDurationMs } from "../world/cadence";

import { fitRate, pickVoice, utteranceSettings, VOICE_CPS } from "./tts";

const voices = [
  { name: "Bad News", lang: "en-US" },
  { name: "Samantha", lang: "en-US" },
  { name: "Daniel", lang: "en-GB" },
  { name: "Reed (English (United States))", lang: "en-US" },
  { name: "Thomas", lang: "fr-FR" },
];

describe("pickVoice", () => {
  it("takes the first preference available, by name prefix", () => {
    expect(pickVoice(voices, ["Rocko", "Reed", "Daniel"])?.name).toBe("Reed (English (United States))");
  });

  it("falls back to a natural English voice, never a novelty or another language", () => {
    expect(pickVoice(voices, ["Thomas"])?.name).toBe("Samantha");
    expect(pickVoice([{ name: "Zarvox", lang: "en-US" }, { name: "Thomas", lang: "fr-FR" }], [])).toBe(null);
  });
});

describe("utteranceSettings", () => {
  it("clamps pitch and rate to the synthesis range", () => {
    expect(utteranceSettings({ pitch: 3, rate: 0.1 })).toEqual({ pitch: 2, rate: 0.5 });
    expect(utteranceSettings({ pitch: 0.9, rate: 1.05 })).toEqual({ pitch: 0.9, rate: 1.05 });
  });
});

describe("fitRate", () => {
  it("keeps the persona's rate when the voice ends within the line's speaking time", () => {
    expect(fitRate("Yes.", 1)).toBe(1);
    expect(fitRate("Yes.", 0.95)).toBe(0.95);
  });

  it("speeds a long line up so the voice ends with its speaking time, up to the synthesis limit", () => {
    const long = "word ".repeat(50).trim();
    const rate = fitRate(long, 1);
    expect(rate).toBeGreaterThan(1);
    expect((long.length / (VOICE_CPS * rate)) * 1000).toBeCloseTo(speechDurationMs(long), 0);
    expect(fitRate("word ".repeat(400), 1)).toBe(2);
  });
});
