import { describe, expect, it } from "vitest";

import example from "../../fixtures/leaderboard.example.json";
import { metricText, metricView, parseBoard, rankBar } from "./leaderboard";

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
    expect(a?.rows[2]?.reason).toBe("false_positive_ceiling");
    const s = parseBoard(example.subject);
    expect(s?.board).toBe("subject");
    expect(s?.rows[0]?.metrics["M12_subject_fidelity"]?.ratio).toEqual({ num: 52, den: 54 });
  });

  it("refuses what is not a board", () => {
    expect(parseBoard(null)).toBe(null);
    expect(parseBoard({ board: "x", status: "ranked", rows: [] })).toBe(null);
    expect(parseBoard({ board: "assistant", status: "ranked", rows: [{ candidate_id: 1 }] })).toBe(null);
    expect(parseBoard({ board: "assistant", status: "ranked", rows: [{ candidate_id: "A", display_name: "A", rank: "1" }] })).toBe(null);
  });

  it("formats a metric and a rank bar without computing anything new", () => {
    expect(metricText(metricView({ point: { num: 8, den: 9, value: 8 / 9 }, interval: { lo: 0.62, hi: 1 } }) ?? undefined)).toBe("89% (8/9), interval 62%-100%");
    expect(metricText(metricView({ point: null }) ?? undefined)).toBe("not computed");
    expect(metricText(undefined)).toBe("not computed");
    expect(metricText(metricView({ num: 1, den: 4, value: 0.25 }) ?? undefined)).toBe("25% (1/4)");
    expect(metricView("x")).toBe(null);
    expect(rankBar({ lo: 1, hi: 2 }, 3)).toEqual({ left: 0, width: 2 / 3 });
  });
});
