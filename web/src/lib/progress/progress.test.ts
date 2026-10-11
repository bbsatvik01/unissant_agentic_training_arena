import { describe, expect, it } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import { fixture } from "../../test/wire-fixtures";
import type { Debrief, ScoredDebrief } from "../contracts/generated/types";
import { parseRecording } from "../world/parseRecording";
import { dayOf, kpi1Text, parseProgress, scoreOf, sessionLabels } from "./progress";

const row = (over: Record<string, unknown> = {}) => ({
  session_id: "s1",
  trial_id: "t1",
  phase: "practice",
  mode: "practice",
  voice: false,
  status: "finalized",
  created_at: "2026-10-24T14:00:00Z",
  ...over,
});

describe("progress (S6 4.8)", () => {
  it("reads the session list in the server's order and refuses what is not one", () => {
    const p = parseProgress({ sessions: [row({ phase: "pre", mode: "assessment" }), row({ session_id: "s2", case_title: "Records vault entry" })], kpi1: null });
    expect(p?.sessions.map((s) => [s.session_id, s.phase, s.case_title])).toEqual([
      ["s1", "pre", null],
      ["s2", "practice", "Records vault entry"],
    ]);
    expect(p?.kpi1).toBe(null);
    expect(parseProgress({ sessions: [row({ phase: "free" })] })).toBe(null);
    expect(parseProgress({ sessions: [row({ voice: "no" })] })).toBe(null);
    expect(parseProgress({ sessions: "x" })).toBe(null);
    expect(parseProgress({ sessions: [], kpi1: { pre: 40 } })).toBe(null);
  });

  it("labels each session as its study step or practice", () => {
    const p = parseProgress({ sessions: [row({ phase: "pre" }), row({ phase: "pre" }), row(), row(), row({ phase: "post" })] });
    expect(sessionLabels(p?.sessions ?? [])).toEqual(["Pre-test 1", "Pre-test 2", "Practice 1", "Practice 2", "Post-test 1"]);
  });

  it("reads a debrief's own total and dimensions, and says when it is not scored", () => {
    const rec = parseRecording(structuredClone(raw));
    if (!rec.ok || rec.recording.debrief === null) throw new Error("fixture");
    const scored = rec.recording.debrief as ScoredDebrief;
    expect(scoreOf(scored)).toEqual({ kind: "scored", total: scored.rubric.total, dimensions: scored.rubric.dimensions.map((d) => ({ id: d.dim_id, score: d.score })), reason: null });
    expect(scoreOf(fixture("debrief:unscored") as Debrief).kind).toBe("unscored");
    expect(scoreOf(fixture("debrief:unscorable") as Debrief)).toMatchObject({ kind: "unscorable", total: null });
  });

  it("words KPI-1 as published, undefined at a zero baseline, and not measured without it (FE-PRG-1)", () => {
    expect(kpi1Text({ pre: 40, post: 55, absolute_change: 15, relative_change: 0.375 })).toEqual({ pre: "40", post: "55", absolute: "+15", relative: "+38%" });
    expect(kpi1Text({ pre: 0, post: 30, absolute_change: 30, relative_change: null }).relative).toBe("undefined (baseline 0)");
    expect(kpi1Text(null).relative).toBe("KPI-1 not measured");
    expect(parseProgress({ sessions: [], kpi1: { pre: 0, post: 30, absolute_change: 30, relative_change: null } })?.kpi1?.relative_change).toBe(null);
  });

  it("shows a day, never a time", () => {
    expect(dayOf("2026-10-24T14:05:00Z")).toMatch(/2026/);
    expect(dayOf("2026-10-24T14:05:00Z")).not.toMatch(/14:05|2:05/);
    expect(dayOf("not a date")).toBe("");
  });
});
