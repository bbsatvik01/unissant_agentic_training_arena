import { describe, expect, it } from "vitest";
import { deriveAgentWork, type WorkFrame } from "../agent-work/model";
import { monitorBudget, monitorStyleAtUv, observationWork } from "./observationScreens";

describe("physical observation monitor", () => {
  it("maps texture quadrants in screen reading order", () => {
    expect(monitorStyleAtUv(0.25, 0.75)).toBe("office");
    expect(monitorStyleAtUv(0.75, 0.75)).toBe("case-board");
    expect(monitorStyleAtUv(0.25, 0.25)).toBe("playhouse");
    expect(monitorStyleAtUv(0.75, 0.25)).toBe("tower");
    expect(monitorStyleAtUv(0, 0)).toBe("playhouse");
    expect(monitorStyleAtUv(1, 1)).toBe("case-board");
    expect(monitorStyleAtUv(0.5, 0.5)).toBe("case-board");
  });
  it.each([[NaN, 0], [0, Infinity], [-0.1, 0], [1.1, 0], [0, -0.1], [0, 1.1]])("rejects invalid UV %s, %s", (u, v) => {
    expect(monitorStyleAtUv(u, v)).toBeNull();
  });
  it("uses one bounded low-cost atlas cadence per quality tier", () => {
    expect(monitorBudget("high")).toEqual({ seconds: 0.25, width: 1024, height: 576 });
    expect(monitorBudget("medium")).toEqual({ seconds: 0.5, width: 768, height: 432 });
    expect(monitorBudget("low")).toEqual({ seconds: 1, width: 512, height: 288 });
  });
  it("keeps the canonical practice frame and strips stale coaching on either assessment signal", () => {
    const empty = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: true, reducedMotion: false });
    const stale: WorkFrame = { ...empty, cards: 2, updates: 1,
      flags: [{ id: "flag", label: "old", turn: 1, quote: "private old coaching", recordId: null, conflictTurn: null }],
      items: [{ id: "card:1", kind: "card", label: "old card", turn: 1, atMs: 0 }, { id: "evidence:r1", kind: "evidence", label: "public file", turn: 1, atMs: 0 }, { id: "referee", kind: "referee", label: "Published scoring ready", turn: null, atMs: 0 }],
      transfers: [{ id: "old", from: "coach", to: "evidence", progress: 0.4 }],
    };
    expect(observationWork(stale, false)).toBe(stale);
    for (const safe of [observationWork(stale, true), observationWork({ ...stale, assessment: true }, false)]) {
      expect(safe.assessment).toBe(true);
      expect(safe.cards).toBe(0); expect(safe.updates).toBe(0);
      expect(safe.flags).toEqual([]); expect(safe.transfers).toEqual([]);
      expect(safe.items.map((item) => item.kind)).toEqual(["evidence", "referee"]);
      expect(safe.agents.find((agent) => agent.id === "coach")).toMatchObject({ count: 0, status: "withheld", task: "Coaching withheld in assessment" });
      expect(safe.agents.find((agent) => agent.id === "subject")).toBe(stale.agents.find((agent) => agent.id === "subject"));
    }
    expect(stale.cards).toBe(2);
  });
});
