import { describe, expect, it } from "vitest";

import type { AgentCard } from "@/lib/contracts/run-events";

import type { OfficeRecord } from "./office";
import { officeHasScene, sceneAt, seatKnown, stillKnown, type SceneInput } from "./scene";
import type { SwarmView } from "./swarm";

const T0 = Date.parse("2026-10-04T02:48:10.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const card = (agentId: string, group: string): AgentCard => ({ agentId, name: agentId, role: "pricing", group, groupLabel: group, stage: "S9", skills: [], reads: "" });

function input(): SceneInput {
  const record: OfficeRecord = {
    lanes: [
      { key: "ACME", label: "Acme", home: false, seq: 3, ts: T0 + 3000 },
      { key: "BETA", label: "Beta", home: false, seq: 7, ts: T0 + 7000 },
    ],
    fetches: [],
    verifies: [],
    stages: [],
    parks: [],
    notes: [],
    lastSeq: 20,
  };
  const view = {
    cards: { a1: card("a1", "g-acme"), a2: card("a2", "g-acme"), b1: card("b1", "g-beta") },
    cardSeen: { a1: { seq: 10, ts: iso(T0 + 10_000) }, a2: { seq: 12, ts: iso(T0 + 12_000) }, b1: { seq: 11, ts: iso(T0 + 11_000) } },
    groups: [],
    messages: [],
    board: null,
    boardSeen: null,
    totals: { agents: 3, messages: 0 },
  } as unknown as SwarmView;
  return {
    record,
    view,
    calls: [
      { endpoint: "vertex", start: 5000 },
      { endpoint: "groq", start: 9000 },
      { endpoint: "vertex", start: 9500 },
    ],
    clockAt: (ts) => ts - T0,
    settledSeq: 0,
  };
}

describe("the scene at the cursor", () => {
  it("knows no rival, agent or endpoint before the plan names the lanes", () => {
    const s = sceneAt(input(), 1000);
    expect(s.rivals).toEqual([]);
    expect(s.agents).toEqual([]);
    expect(s.endpoints).toEqual([]);
    expect(s.groupSize("g-acme")).toBe(0);
  });

  it("names each rival from the frame that first named its lane, in that order", () => {
    expect(sceneAt(input(), 3000).rivals).toEqual(["ACME"]);
    expect(sceneAt(input(), 7000).rivals).toEqual(["ACME", "BETA"]);
  });

  it("between cards, counts only the agents whose cards are recorded", () => {
    const s = sceneAt(input(), 11_500);
    expect(s.agents).toEqual(["a1", "b1"]);
    expect(s.groupSize("g-acme")).toBe(1);
    expect(s.hasAgent("a2")).toBe(false);
    expect(sceneAt(input(), 12_000).groupSize("g-acme")).toBe(2);
  });

  it("lists an endpoint only once its first call has started", () => {
    expect(sceneAt(input(), 4999).endpoints).toEqual([]);
    expect(sceneAt(input(), 5000).endpoints).toEqual(["vertex"]);
    expect(sceneAt(input(), 9000).endpoints).toEqual(["vertex", "groq"]);
  });

  it("puts history (at or before the settled boundary) in place at once, and the final frame sees everything", () => {
    expect(sceneAt({ ...input(), settledSeq: 7 }, -1).rivals).toEqual(["ACME", "BETA"]);
    const end = sceneAt(input(), Infinity);
    expect(end.agents).toHaveLength(3);
    expect(end.endpoints).toEqual(["vertex", "groq"]);
  });
});

describe("a seat at the cursor", () => {
  it("is known off the rival floors, and on a rival's floor only once that rival is named", () => {
    const early = sceneAt(input(), 1000);
    const later = sceneAt(input(), 3000);
    expect(seatKnown({ pod: null }, early)).toBe(true);
    expect(seatKnown({ pod: "ACME" }, early)).toBe(false);
    expect(seatKnown({ pod: "ACME" }, later)).toBe(true);
    expect(seatKnown({ pod: "BETA" }, later)).toBe(false);
  });
});

describe("whether the office has a scene to draw", () => {
  const empty = { lanes: [], stages: [] };
  const early = { lanes: [], stages: [{ seq: 1, ts: T0, stage: "S0" as const, edge: "started" as const }] };
  it("Classic needs lanes or cards; the other styles draw the early stages and gates from the first stage edge", () => {
    expect(officeHasScene(true, early, false)).toBe(false);
    expect(officeHasScene(false, early, false)).toBe(true);
    expect(officeHasScene(false, empty, false)).toBe(false);
    expect(officeHasScene(true, empty, true)).toBe(true);
  });
});

describe("an open card at the cursor", () => {
  it("stays only while what it names is still known (after a seek backward it closes)", () => {
    const s = sceneAt(input(), 11_500);
    expect(stillKnown({ agentId: "a1" }, s)).toBe(true);
    expect(stillKnown({ agentId: "a2" }, s)).toBe(false);
    expect(stillKnown({ rival: "ACME" }, sceneAt(input(), 1000))).toBe(false);
    expect(stillKnown({}, s)).toBe(true);
  });
});
