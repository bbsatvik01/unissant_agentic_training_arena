import { describe, expect, it } from "vitest";

import example from "../../fixtures/leaderboard.example.json";
import { boardsFailure, fprGate, metricText, metricView, otherLabelHref, parseBoard, rankBar } from "./leaderboard";

describe("leaderboard bodies (WP-16 shape)", () => {
  it("reads both boards in the server's order with ranks, eligibility and intervals as published", () => {
    const a = parseBoard(example.assistant);
    expect(a?.rows.map((r) => [r.candidate_id, r.rank, r.eligible])).toEqual([
      ["A1", 1, true],
      ["A3", 2, true],
      ["A2", null, false],
    ]);
    expect(a?.rows[1]?.provisional).toBe(true);
    expect(a?.rows[0]?.rankInterval).toEqual({ lo: 1, hi: 2 });
    expect(a?.rows[2]?.reason).toBe("ineligible: FPR above 5%");
    expect(a?.manifestHash).toBe(example.assistant.binding.manifest_sha256);
    expect(a?.manifestHash).toHaveLength(64);
    expect(a?.isolationHash).toBe(example.assistant.isolation_evidence_hash);
    expect(a?.notRanked).toBe(false);
    const s = parseBoard(example.subject);
    expect(s?.board).toBe("subject");
    expect(s?.rows[0]?.metrics["M12_subject_fidelity"]?.ratio).toEqual({ num: 52, den: 54 });
  });

  it("states each candidate's FPR gate as the server decided it, with the zero-event family bound (EVL-6, FE-LB-1)", () => {
    const a = parseBoard(example.assistant);
    const [a1, a3, a2] = a?.rows ?? [];
    if (a1 === undefined || a3 === undefined || a2 === undefined) throw new Error("rows");
    expect(fprGate(a1)).toEqual({ result: "passed", fpr: "0%, interval 0%-12%", bound: "0 of 9 truthful families; one-sided 95% zero-event bound (equal sizes) 28.3%" });
    expect(fprGate(a3).fpr).toBe("0%, interval unavailable");
    expect(fprGate(a2)).toEqual({ result: "failed", fpr: "33%, interval 11%-60%", bound: null });
    expect(fprGate({ ...a1, eligible: false, eligibilityStatus: "insufficient: no included truthful trials", fpr: null })).toMatchObject({ result: "insufficient (no included truthful trials)", fpr: "undefined" });
  });

  it("reads a not-ranked board (isolation failed) as having no ranks", () => {
    const b = parseBoard({ board: "assistant", status: "not ranked: isolation gate failed", rows: [] });
    expect(b?.notRanked).toBe(true);
    expect(b?.manifestHash).toBe(null);
  });

  it("refuses what is not a board", () => {
    expect(parseBoard(null)).toBe(null);
    expect(parseBoard({ board: "x", status: "ranked", rows: [] })).toBe(null);
    expect(parseBoard({ board: "assistant", status: "ranked", rows: [{ candidate_id: 1 }] })).toBe(null);
    expect(parseBoard({ board: "assistant", status: "ranked", rows: [{ candidate_id: "A", display_name: "A", rank: "1" }] })).toBe(null);
  });

  it("formats a metric and a rank bar without computing anything new", () => {
    expect(metricText(metricView({ point: { num: 8, den: 9, value: 8 / 9 }, interval: { lo: 0.62, hi: 1 } }) ?? undefined)).toBe("89%, interval 62%-100%");
    // FE-LB-2: never a bare point; a metric without a point is undefined, an absent one not computed.
    expect(metricText(metricView({ num: 1, den: 4, value: 0.25 }) ?? undefined)).toBe("25%, interval unavailable");
    expect(metricText(metricView({ point: null, interval: { lo: null, hi: null } }) ?? undefined)).toBe("undefined");
    expect(metricText(undefined)).toBe("not computed");
    expect(metricView("x")).toBe(null);
    expect(rankBar({ lo: 1, hi: 2 }, 3)).toEqual({ left: 0, width: 2 / 3 });
  });

  it("reads 409 not_revealed as sealed and 404 as none published; links between a corrected board and its original", () => {
    expect(boardsFailure(409, "not_revealed")).toEqual({ kind: "sealed" });
    expect(boardsFailure(404, null)).toEqual({ kind: "missing" });
    expect(boardsFailure(409, "other")).toEqual({ kind: "error" });
    expect(boardsFailure(null, null)).toEqual({ kind: "error" });
    expect(otherLabelHref("t 1", null, 1)).toBe(null);
    expect(otherLabelHref("t 1", null, 2)).toEqual({ heading: "Corrected leaderboard", text: "See the original leaderboard", href: "?tournament=t%201&label=original" });
    expect(otherLabelHref("t 1", "original", 1)).toEqual({ heading: "Original leaderboard", text: "See the corrected leaderboard", href: "?tournament=t%201" });
  });
});
