import { describe, expect, it } from "vitest";
import { actualPrecinctWorld, PRECINCT_WORLDS } from "./knownWorlds";
import { precinctAsset, precinctMinimapFrame } from "./worldVariant";

describe("paired original and courtyard scenes", () => {
  it("pairs each known scene with its own asset, manifest and footprint", () => {
    expect(precinctAsset(PRECINCT_WORLDS.office.manifest)).toBe("/world/precinct.glb");
    expect(precinctAsset(PRECINCT_WORLDS.courtyard.manifest)).toBe("/world/precinct-courtyard.glb");
    expect(precinctMinimapFrame(PRECINCT_WORLDS.courtyard.manifest).viewBox).toBe("-15 -37 30 58");
    expect(PRECINCT_WORLDS.courtyard.manifest.navigationNodes.length).toBeGreaterThan(PRECINCT_WORLDS.office.manifest.navigationNodes.length);
  });
  it("preserves every original hotspot and all original room coordinates", () => {
    expect(PRECINCT_WORLDS.courtyard.manifest.hotspots).toEqual(PRECINCT_WORLDS.office.manifest.hotspots);
    expect(PRECINCT_WORLDS.courtyard.authored.rooms.slice(0, PRECINCT_WORLDS.office.authored.rooms.length)).toEqual(PRECINCT_WORLDS.office.authored.rooms);
  });
  it("legacy playback always uses Office and stopping restores preference", () => {
    expect(actualPrecinctWorld("courtyard", true, undefined)).toBe("office");
    expect(actualPrecinctWorld("courtyard", false, undefined)).toBe("courtyard");
  });
  it("known playback identity controls the actual world independently of preference", () => {
    expect(actualPrecinctWorld("office", true, "courtyard")).toBe("courtyard");
    expect(actualPrecinctWorld("courtyard", true, "office")).toBe("office");
    expect(actualPrecinctWorld("office", false, "courtyard")).toBe("office");
  });
});
