import { describe, expect, it } from "vitest";

import { T0, timedPods, timedSwarm } from "./__fixtures__/swarm-timed";
import { layoutNetwork } from "./swarm-net";
import { buildStrip, laneOf, nearestTick, nudge, sliderText, stepTick } from "./swarm-strip";
import { buildModel } from "./swarm-time";

const view = timedSwarm({ faults: true });
const layout = layoutNetwork(view, timedPods());
const model = buildModel(view, layout);
const strip = buildStrip(model, layout);
const s = (sec: number) => T0 + sec * 1000;

describe("buildStrip", () => {
  it("has a lane per rival in pod order, then the hubs", () => {
    expect(strip.lanes.map((l) => l.id)).toEqual(["cgi", "akumen", "zen", "deloitte", "red_team", "analyst", "board"]);
    expect(strip.from).toBe(model.origin - 1000);
    expect(strip.to).toBe(s(186) + 3000);
    expect(strip.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4]);
  });

  it("stacks concurrent calls in sub-rows (the red team holds three at +86)", () => {
    const red = strip.bars.filter((b) => b.lane === "red_team" && b.start <= s(86) && b.end >= s(86));
    expect(red.map((b) => b.row).sort()).toEqual([0, 1, 2]);
    expect(strip.rows.cgi).toBe(3);
    expect(strip.bars.some((b) => b.messageId === "cgi-i")).toBe(false);
  });

  it("ticks every message with its target lanes", () => {
    const r = strip.ticks.find((t) => t.messageId === "cgi-r")!;
    expect(r.targets).toEqual(["board", "red_team"]);
    expect(strip.ticks.find((t) => t.messageId === "cgi-b0")?.targets).toEqual([]);
    expect(strip.ticks.find((t) => t.messageId === "akumen-c")?.state).toBe("failed");
    expect(laneOf(layout, "anchor:board")).toBe("board");
    expect(laneOf(layout, "team:cgi")).toBe("cgi");
    expect(laneOf(layout, "nobody")).toBeNull();
  });
});

describe("strip helpers", () => {
  it("nudges marks apart by at most the gap, keeping their order", () => {
    expect(nudge([0, 1, 2, 10])).toEqual([0, 3, 5, 10]);
    expect(nudge([])).toEqual([]);
  });

  it("finds the nearest and the next tick, and speaks the slider value", () => {
    expect(nearestTick(strip.ticks, s(86.9))?.messageId).toBe("cgi-c");
    expect(nearestTick([], 0)).toBeNull();
    expect(stepTick(strip.ticks, s(87), 1)?.messageId).toBe("zen-s");
    expect(stepTick(strip.ticks, s(87), -1)?.messageId).toBe("deloitte-s");
    expect(stepTick(strip.ticks, s(999), 1)).toBeNull();
    expect(sliderText(strip, model.origin, s(87))).toBe("S9+01:37.6, round 2");
    expect(sliderText(strip, model.origin, s(-10))).toBe("S9+00:00.6, before the first message");
    expect(sliderText(strip, model.origin, s(185))).toBe("S9+03:15.6, board");
  });
});
