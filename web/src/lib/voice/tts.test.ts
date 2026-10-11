import { describe, expect, it } from "vitest";

import { pickVoice, utteranceSettings } from "./tts";

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
