import { describe, expect, it } from "vitest";

import boards from "../../fixtures/leaderboard.example.json";
import { parseBoard, rankStatus } from "./leaderboard";
import { standings, standingsKey, standingsLayout } from "./standings";

const assistant = parseBoard(boards.assistant);

describe("standings on the precinct wall (S6 4.10)", () => {
  it("shows the ranked coaches in the server's order with their rank intervals, the ineligible apart, never re-ranked", () => {
    const s = standings(assistant, { kind: "published", tournamentId: "t", label: null });
    expect(s?.note).toBe(`Bound to manifest ${boards.assistant.binding.manifest_sha256.slice(0, 12)}. Not certification.`);
    expect(s?.rows.map((r) => r.name)).toEqual(["Evidence Strategist", "Conservative Corroborator"]);
    expect(s?.rows.map((r) => r.rank)).toEqual(["1", "2"]);
    expect(s?.rows[0]?.detail).toMatch(/^Recall \d+%, interval \d+%-\d+%; ranks \d-\d$/);
    // The board's provisional status and each row's reasons reach the wall, worded as in the panel.
    if (assistant === null) throw new Error("fixture");
    expect(s?.rows.map((r) => r.status)).toEqual(assistant.rows.filter((r) => r.rank !== null).map((r) => rankStatus(assistant, r)));
    expect(s?.rows.some((r) => r.status.startsWith("provisional"))).toBe(true);
    expect(s?.excluded).toEqual(["Cognitive-Load Prober: ineligible: FPR above 5%"]);
  });

  it("is sealed before reveal with no numbers, labels the example, and is absent without a board", () => {
    const sealed = standings(null, { kind: "sealed" });
    expect(sealed).toEqual({ heading: "Standings", note: "Sealed until reveal.", rows: [], excluded: [] });
    expect(standings(assistant, { kind: "example" })?.note).toBe("Example data. Not a result.");
    expect(standings(null, { kind: "missing" })).toBe(null);
    expect(standings(null, { kind: "error" })).toBe(null);
    expect(standings(null, { kind: "published", tournamentId: "t", label: null })).toBe(null);
  });

  it("says the board is not ranked when the isolation gate failed", () => {
    if (assistant === null) throw new Error("fixture");
    const s = standings({ ...assistant, notRanked: true, rows: [] }, { kind: "published", tournamentId: "t", label: null });
    expect(s?.rows).toEqual([]);
    expect(s?.note).toBe("Not ranked: the isolation gate failed.");
  });

  it("reads unavailable intervals plainly, and keys equal content equally", () => {
    if (assistant === null) throw new Error("fixture");
    const bare = { ...assistant, rows: assistant.rows.map((r) => ({ ...r, rankInterval: null, metrics: {} })) };
    const s = standings(bare, { kind: "published", tournamentId: "t", label: null });
    expect(s?.rows[0]?.detail).toBe("Recall not computed; rank interval unavailable");
    const again = standings(parseBoard(boards.assistant), { kind: "published", tournamentId: "t", label: null });
    expect(standingsKey(again)).toBe(standingsKey(standings(assistant, { kind: "published", tournamentId: "t", label: null })));
    expect(standingsKey(again)).not.toBe(standingsKey(standings(null, { kind: "sealed" })));
  });

  it("lays out every ranked row and every ineligible candidate inside the board, shrinking evenly when crowded", () => {
    const rows = [1, 2, 3].map((n) => ({ rank: String(n), name: `Coach ${String(n)}`, detail: "Recall 50%, interval 20%-80%; ranks 1-3", status: "provisional ranking" }));
    const excluded = ["A4: ineligible: FPR above 5%", "A5: ineligible: FPR above 5%", "A6: insufficient"];
    const lines = standingsLayout({ heading: "Standings", note: "n", rows, excluded }, 280, 630);
    expect(lines.filter((l) => l.kind === "row")).toHaveLength(3);
    expect(lines.flatMap((l) => (l.kind === "status" ? [l.text] : []))).toEqual(["provisional ranking", "provisional ranking", "provisional ranking"]);
    expect(lines.flatMap((l) => (l.kind === "excluded" ? [l.text] : []))).toEqual(excluded.map((e) => `Not ranked: ${e}`));
    expect(Math.max(...lines.map((l) => l.y))).toBeLessThanOrEqual(630);
    expect(lines[0]?.size).toBeLessThan(56);
    const roomy = standingsLayout({ heading: "Standings", note: "n", rows: rows.slice(0, 1), excluded: [] }, 280, 630);
    expect(roomy[0]?.size).toBeCloseTo(56 * 0.86);
    expect(standingsLayout({ heading: "Standings", note: "Sealed until reveal.", rows: [], excluded: [] }, 280, 630)).toEqual([]);
  });
});
