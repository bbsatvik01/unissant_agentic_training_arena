import { describe, expect, it } from "vitest";

import boards from "../../fixtures/leaderboard.example.json";
import { parseBoard } from "./leaderboard";
import { standings } from "./standings";

const assistant = parseBoard(boards.assistant);

describe("standings on the precinct wall (S6 4.10)", () => {
  it("shows the ranked coaches in the server's order with their rank intervals, the ineligible apart, never re-ranked", () => {
    const s = standings(assistant, { kind: "published", tournamentId: "t", label: null });
    expect(s?.note).toBe(`Bound to manifest ${boards.assistant.binding.manifest_sha256.slice(0, 12)}. Not certification.`);
    expect(s?.rows.map((r) => r.name)).toEqual(["Evidence Strategist", "Conservative Corroborator"]);
    expect(s?.rows.map((r) => r.rank)).toEqual(["1", "2"]);
    expect(s?.rows[0]?.detail).toMatch(/^Recall \d+%, ranks \d-\d$/);
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
});
