import { describe, expect, it } from "vitest";
import raw from "../../../public/world/precinct-manifest.json";
import { isWalkable, nearestHotspot } from "../../lib/precinct/movement";
import type { Collider, Hotspot, Vec3 } from "../../lib/precinct/types";
import { STATIONS } from "./sceneTypes";

const xyz = (value: readonly number[]): Vec3 => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
const colliders: readonly Collider[] = raw.colliders.map((item) => ({ ...item, min: xyz(item.min), max: xyz(item.max) }));
const hotspots: readonly Hotspot[] = raw.hotspots.map((item) => ({ ...item, position: xyz(item.position) }));

describe("precinct station travel anchors", () => {
  it.each(STATIONS)("lands at an accessible interaction in $label", (station) => {
    expect(isWalkable(station.anchor, colliders)).toBe(true);
    const destination = hotspots.find((hotspot) => hotspot.room === station.id);
    expect(destination).toBeDefined();
    expect(nearestHotspot(station.anchor, hotspots)?.id).toBe(destination?.id);
  });
});
