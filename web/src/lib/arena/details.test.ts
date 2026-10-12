import { describe, expect, it } from "vitest";

import example from "../../fixtures/leaderboard.example.json";
import { assistantDetails, countMatrix, subjectDetails } from "./details";
import { parseBoard, rankStatus } from "./leaderboard";

const assistant = parseBoard(example.assistant);
const subject = parseBoard(example.subject);

function value(lines: readonly { label: string; value: string }[], label: string): string | undefined {
  return lines.find((l) => l.label === label)?.value;
}

describe("leaderboard detail (S6 4.10 item 5, subject board)", () => {
  it("reads the count matrix as published raw counts, and refuses a partial one", () => {
    const a1 = assistant?.rows[0];
    expect(a1 === undefined ? null : countMatrix(a1.published)).toEqual([
      { role: "truthful", cells: [8, 0, 1] },
      { role: "deceptive", cells: [1, 8, 0] },
    ]);
    expect(countMatrix({ M05_count_matrix: { truthful: { truthful: 1 } } })).toBe(null);
    expect(countMatrix({})).toBe(null);
  });

  it("formats every assistant detail from the body, undefined and missing intervals said as such", () => {
    const lines = assistantDetails(assistant?.rows[0]?.published ?? {});
    expect(value(lines, "Evasion recall, strict and broad (M07)")).toBe("56%, interval 30%-80%; undefined");
    expect(value(lines, "Unsupported flags (M08)")).toBe("8%, interval 0%-20%; by reason: citation 1, demeanor 0, claim 0");
    expect(value(lines, "Coaching latency p95 (M16)")).toBe("2.41 s, interval 2.10 s-2.90 s; within 3 s: 95%, interval unavailable; measured 84, unmeasured 0");
    expect(value(lines, "Cost per trial (M22)")).toMatch(/^\$[\d.]+ per included, \$[\d.]+ per planned; total \$[\d.]+$/);
    expect(value(lines, "Execution states, truthful role (M23)")).toBe("completed 9");
    expect(value(lines, "Unresolved, deceptive role (M04)")).toBe("0%, interval 0%-20%");
    expect(value(assistantDetails({}), "Closure support, mean D5 of 4 (M10)")).toBe("not computed");
    // M10 is the mean D5 on the rubric's 0-4 scale, never a percentage.
    expect(value(assistantDetails({ M10_closure_support: { point: { num: 3, den: 1, value: 3 }, interval: { lo: 2, hi: 4, status: "ok" } } }), "Closure support, mean D5 of 4 (M10)")).toBe("3.0 of 4, interval 2.0-4.0");
    expect(value(assistantDetails({ M10_closure_support: { point: null, interval: { lo: null, hi: null } } }), "Closure support, mean D5 of 4 (M10)")).toBe("undefined");
    // The share within 3 s carries its own published interval.
    const latency = { M16_coaching_latency: { share_within_3s: { num: 9, den: 10, value: 0.9 }, p95_s: 2, interval_share: [0.8, 0.97], interval_p95: null, measured: 10, unmeasured: 0 } };
    expect(value(assistantDetails(latency), "Coaching latency p95 (M16)")).toBe("2.00 s, interval unavailable; within 3 s: 90%, interval 80%-97%; measured 10, unmeasured 0");
    expect(value(assistantDetails({ M22_cost: { total: null, mean_per_included: null, mean_per_planned: null } }), "Cost per trial (M22)")).toBe("undefined per included, undefined per planned; total undefined");
  });

  it("formats the subject detail: valid-session fidelity, deceptive-success outcomes, truthful credit", () => {
    const lines = subjectDetails(subject?.rows[0]?.published ?? {});
    expect(value(lines, "Deceptive success outcomes (M14)")).toMatch(/misleading clearance \d+/);
    expect(value(lines, "Correct recognition (M15)")).toMatch(/%, interval /);
    expect(value(subjectDetails({}), "Fidelity, valid sessions (M12)")).toBe("not computed");
  });

  it("says a ranking is provisional when the board is, with the row's own published reasons", () => {
    if (assistant === null) throw new Error("board");
    const [a1, a3] = assistant.rows;
    if (a1 === undefined || a3 === undefined) throw new Error("rows");
    expect(rankStatus(assistant, a1)).toBe("provisional ranking");
    expect(rankStatus(assistant, a3)).toBe("provisional ranking (false-positive attrition sensitivity)");
    expect(rankStatus({ ...assistant, status: "definitive" }, a1)).toBe("definitive");
    expect(rankStatus({ ...assistant, status: "definitive" }, { ...a1, qqProvisional: true })).toBe("provisional ranking (questioning quality coverage)");
  });
});
