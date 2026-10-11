import { describe, expect, it } from "vitest";

import { speechDurationMs } from "./cadence";
import { BLEND_MS, beatTimes, VISEMES, visemeTrack, visemeUnits, visemeWeightsAt } from "./visemes";

describe("visemes from the text stream", () => {
  it("maps letters and digraphs to the Oculus visemes", () => {
    expect(visemeUnits("the ship").map((u) => u.key)).toEqual(["TH", "E", "sil", "CH", "I", "PP"]);
    expect(visemeUnits("moon, fee").map((u) => u.key)).toEqual(["PP", "U", "nn", "sil", "sil", "FF", "I"]);
    expect(visemeUnits("phone ring quick 7").map((u) => u.key)).toEqual(["FF", "O", "nn", "E", "sil", "RR", "I", "nn", "sil", "kk", "I", "kk", "sil", "aa"]);
    expect(VISEMES).toHaveLength(15);
  });

  it("stretches the timeline over the line's speaking time and merges repeated visemes", () => {
    const track = visemeTrack("Yes. I did.");
    expect(track.at(-1)?.end).toBeCloseTo(speechDurationMs("Yes. I did."));
    for (let i = 1; i < track.length; i += 1) expect(track[i]?.key).not.toBe(track[i - 1]?.key);
    expect(visemeTrack("")).toEqual([]);
  });

  it("gives the current viseme full weight and blends across boundaries, nothing outside the line", () => {
    const track = visemeTrack("mama papa");
    const first = track[0];
    if (first === undefined) throw new Error("empty");
    expect(visemeWeightsAt(track, (first.start + first.end) / 2)).toMatchObject({ PP: 1 });
    const boundary = visemeWeightsAt(track, first.end);
    expect(boundary.PP ?? 0).toBeGreaterThan(0);
    expect(boundary.aa ?? 0).toBeGreaterThan(0);
    expect(visemeWeightsAt(track, -1)).toEqual({});
    expect(visemeWeightsAt(track, (track.at(-1)?.end ?? 0) + BLEND_MS)).toEqual({});
    expect(visemeWeightsAt([], 10)).toEqual({});
    expect(Object.keys(visemeWeightsAt(visemeTrack("...."), 100))).toEqual([]);
  });

  it("puts beats on words of four letters or more, in order", () => {
    const beats = beatTimes("I left once it was running again.");
    expect(beats).toHaveLength(4);
    expect([...beats].sort((a, b) => a - b)).toEqual(beats);
    expect(beatTimes("No. I am ok.")).toEqual([]);
  });
});
