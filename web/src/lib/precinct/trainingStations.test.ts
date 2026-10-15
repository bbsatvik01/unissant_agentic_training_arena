import { describe, expect, it } from "vitest";
import { canReplayTape, caseBoardEntries, caseDifficulties, COURSE_PRIMERS, skillNodes, type ArchiveTape, type CaseBoardEntry } from "./trainingStations";
import type { ScoreState } from "../progress/progress";
import { RUBRIC } from "../copy/rubric";

const entry = (id: string, level: number): CaseBoardEntry => ({ card: { case_id: id, title: `Case ${id}`, objective: "Establish the timeline", domain: "Access", difficulty_level: level, subject: { display_name: "Public person", position: "Staff" }, facility: "Training site", initial_documents: 2, requestable_records: 1 }, availability: { kind: "preview", detail: "No session adapter" } });
const tape: ArchiveTape = { session: { session_id: "session", trial_id: "trial", phase: "practice", mode: "practice", voice: false, status: "finalized", created_at: "2026-10-15", case_title: "Practice case" }, replayAvailable: true, sourceLabel: "Published" };

describe("public case board", () => {
  it("orders the public difficulty ladder stably without changing supplied cards or access", () => {
    const entries = [entry("A", 3), entry("B", 1), entry("C", 3)];
    expect(caseBoardEntries(entries, "", null).map((e) => e.card.case_id)).toEqual(["B", "A", "C"]);
    expect(entries.map((e) => e.card.case_id)).toEqual(["A", "B", "C"]);
    expect(caseBoardEntries(entries, "", null)[0]).toBe(entries[1]);
    expect(caseDifficulties(entries)).toEqual([1, 3]);
  });
  it("searches only public descriptions and filters difficulty", () => {
    const entries = [entry("A", 1), entry("B", 2)];
    expect(caseBoardEntries(entries, "  CASE a  ", null)).toEqual([entries[0]]);
    expect(caseBoardEntries(entries, "timeline", 2)).toEqual([entries[1]]);
    expect(caseBoardEntries(entries, "Access", null)).toHaveLength(2);
    expect(caseBoardEntries(entries, "public person", null)).toEqual([]);
    expect(caseBoardEntries(entries, "nonexistent", null)).toEqual([]);
    expect(caseBoardEntries([], "", null)).toEqual([]);
    expect(caseDifficulties([])).toEqual([]);
  });
});
describe("published skill nodes", () => {
  it("shows exactly the five rubric dimensions and preserves the server's 0 to 4 scores", () => {
    const score: ScoreState = { kind: "scored", total: 91, reason: null, dimensions: [0, 1, 2, 3, 4].map((value, index) => ({ id: `D${String(index + 1)}`, score: value })) };
    const nodes = skillNodes(score);
    expect(nodes.map((n) => n.score)).toEqual([0, 1, 2, 3, 4]);
    expect(nodes.map((n) => n.title)).toEqual(Object.values(RUBRIC).map((r) => r.name));
    expect(nodes.every((n) => n.anchor !== null && n.status === "Published rubric score")).toBe(true);
    expect(JSON.stringify(nodes)).not.toContain("91");
  });
  it.each([undefined, "none"] as const)("keeps missing %s figures unmeasured, never zero", (score) => {
    expect(skillNodes(score).every((n) => n.score === null && n.anchor === null && n.status === "Not measured")).toBe(true);
  });
  it("reports scoring and unscorable reasons without manufacturing figures", () => {
    expect(skillNodes("scoring")[0]?.status).toBe("Scoring in progress");
    expect(skillNodes({ kind: "unscorable", total: null, dimensions: [], reason: "Not enough material" })[0]?.status).toBe("Not enough material");
    expect(skillNodes({ kind: "unscored", total: null, dimensions: [], reason: null })[0]?.status).toBe("No published score");
  });
  it("does not render unknown, fractional, out-of-range or nonfinite dimensions", () => {
    const nodes = skillNodes({ kind: "scored", total: 0, reason: null, dimensions: [{ id: "D1", score: 5 }, { id: "D2", score: 0.5 }, { id: "D3", score: -1 }, { id: "D4", score: NaN }, { id: "secret", score: 4 }] });
    expect(nodes.every((n) => n.score === null && n.anchor === null)).toBe(true);
  });
  it("provides one authored, case-independent technique primer per skill", () => {
    expect(COURSE_PRIMERS.map((p) => p.id)).toEqual(["D1", "D2", "D3", "D4", "D5"]);
    for (const primer of COURSE_PRIMERS) {
      expect(primer.title).toBe(RUBRIC[primer.id].name);
      expect(primer.steps).toHaveLength(3);
      expect(primer.example.length).toBeGreaterThan(10);
      expect(primer.reflection.length).toBeGreaterThan(10);
    }
  });
});
describe("archive playback eligibility", () => {
  it("requires both a finished session and a verified recording source", () => {
    expect(canReplayTape(tape)).toBe(true);
    expect(canReplayTape({ ...tape, session: { ...tape.session, status: "terminated", voice: true } })).toBe(true);
    expect(canReplayTape({ ...tape, replayAvailable: false })).toBe(false);
    expect(canReplayTape({ ...tape, session: { ...tape.session, status: "running" } })).toBe(false);
  });
});
