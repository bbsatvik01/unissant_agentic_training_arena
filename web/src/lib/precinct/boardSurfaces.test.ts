import { describe, expect, it } from "vitest";
import { parseBoard, type Board } from "../arena/leaderboard";
import { CASES } from "../world/cases";
import { stationCaseEntries } from "./stationSources";
import { CASE_BOARD_SURFACES, RECOGNITION_SURFACE, projectCaseSurfaces, projectRecognitionSurface, type BoardSurfaceContext, type RecognitionRead } from "./boardSurfaces";

const context: BoardSurfaceContext = { scope: "local:user:idle:case", backend: "connected", userId: "user", assessment: false };
function board(overrides: Record<string, unknown> = {}): Board {
  const result = parseBoard({ board: "assistant", status: "provisional", rows: [
    { candidate_id: "b", display_name: "Supplied B", rank: 7, eligibility: { eligible: true, status: "provisional", provisional: true }, rank_interval: { lo: 3, hi: 9 }, metrics: {} },
    { candidate_id: "a", display_name: "Supplied A", rank: 2, eligibility: { eligible: false, status: "insufficient: no included truthful trials" }, reason: "Supplied gate reason", metrics: {} },
  ], ...overrides });
  if (result === null) throw new Error("Invalid synthetic publication fixture");
  return result;
}
const read: RecognitionRead = { scope: context.scope, tournamentId: "actual-selection", label: null, ledger: "revealed", state: { kind: "published", tournamentId: "actual-selection", label: null }, assistant: board() };
const words = (value: ReturnType<typeof projectRecognitionSurface>) => [value.eyebrow, value.heading, ...value.lines, value.footer].join(" ");

describe("physical public case board", () => {
  it("uses only actual source entries, their order and explicit availability", () => {
    const entries = stationCaseEntries(CASES, false);
    const result = projectCaseSurfaces({ ...context, backend: "offline", userId: null }, entries, entries[0]?.card.case_id ?? null, false);
    expect(result).toHaveLength(3);
    result.forEach((surface, index) => {
      const entry = entries[index];
      if (entry === undefined) throw new Error("Fixture requires three public cases");
      expect(surface.heading).toBe(entry.card.title);
      expect(surface.eyebrow).toContain(entry.card.case_id);
      expect(surface.eyebrow).toContain("OFFLINE PUBLIC METADATA");
      expect(surface.lines).toContain(entry.availability.detail);
      expect(surface.lines[1]).toBe(entry.availability.kind === "available" ? "Available public case" : "Preview only · session unavailable");
      expect(surface.target).toBe("case_board");
    });
    expect(result[0]?.lines).toContain("Selected public case");
    expect(result[1]?.lines).not.toContain("Selected public case");
  });
  it("does not infer an unlock requirement or offer absent entries", () => {
    const entry = stationCaseEntries(CASES.slice(0, 1), true)[0];
    if (entry === undefined) throw new Error("Missing case fixture");
    const result = projectCaseSurfaces(context, [{ ...entry, availability: { kind: "locked", detail: "Explicit supplied restriction" } }], null, false);
    expect(result[0]?.lines).toContain("Locked by the supplied source");
    expect(result[0]?.lines).toContain("Explicit supplied restriction");
    expect(result[1]?.heading).toBe("Explore the case board");
    expect(JSON.stringify(result)).not.toMatch(/complete .* to unlock|streak|points|%/i);
  });
  it("clears every old case title on pending, failed identity and assessment transitions", () => {
    const entries = stationCaseEntries(CASES, true);
    const shown = projectCaseSurfaces(context, entries, null, false);
    for (const [change, pending] of [
      [{ assessment: true }, false], [{ backend: "connecting" }, false], [{ backend: "error" }, false], [{ userId: null }, false], [{}, true],
    ] as const) {
      const next = projectCaseSurfaces({ ...context, ...change }, entries, null, pending);
      expect(next.every((surface) => !entries.some((entry) => surface.heading === entry.card.title))).toBe(true);
      expect(next[0]?.key).not.toBe(shown[0]?.key);
    }
    expect(projectCaseSurfaces({ ...context, scope: "another source" }, entries, null, false)[0]?.key).not.toBe(shown[0]?.key);
  });
  it("matches authored prop coordinates without rebuilding architecture", () => {
    expect(CASE_BOARD_SURFACES.map((item) => item.position)).toEqual([[5.03, 1.58, -9.63], [7.83, 1.58, -9.63], [10.63, 1.58, -9.63]]);
    expect(RECOGNITION_SURFACE.position).toEqual([0, 2.79, -35.70]);
  });
});

describe("physical recognition eligibility gates", () => {
  it("preserves actual rank, interval, canonical provisional status and server order", () => {
    const result = projectRecognitionSurface(context, read);
    expect(result.eyebrow).toBe("SELECTED PUBLISHED SNAPSHOT");
    expect(result.lines).toEqual(["Rank 7 · Supplied B", "provisional ranking (false-positive attrition sensitivity) · interval 3–9", "Supplied A · not ranked", "Supplied gate reason"]);
    expect(result.target).toBe("trophies");
    expect(words(result)).not.toContain("Rank 2");
  });
  it("clears values across identity, offline, assessment and pending guards", () => {
    const shown = projectRecognitionSurface(context, read);
    for (const change of [{ backend: "offline" }, { backend: "connecting" }, { backend: "error" }, { userId: null }, { assessment: true }, { scope: "different source" }] as const) {
      const next = projectRecognitionSurface({ ...context, ...change }, read);
      expect(words(next)).not.toMatch(/Supplied [AB]|Rank 7/);
      expect(next.key).not.toBe(shown.key);
    }
    for (const ledger of ["pending", "sealed", "missing", "error"] as const) expect(words(projectRecognitionSurface(context, { ...read, ledger }))).not.toMatch(/Supplied [AB]|Rank 7/);
    expect(projectRecognitionSurface(context, { ...read, state: null }).heading).toBe("Publication pending");
    expect(projectRecognitionSurface(context, null).heading).toBe("Choose a supplied tournament");
  });
  it("rejects examples, mismatched publication identity and non-assistant substitutes", () => {
    for (const state of [{ kind: "example" }, { kind: "sealed" }, { kind: "missing" }, { kind: "error" }, { kind: "published", tournamentId: "wrong", label: null }, { kind: "published", tournamentId: read.tournamentId ?? "", label: "original" }] as const) expect(words(projectRecognitionSurface(context, { ...read, state }))).not.toMatch(/Supplied [AB]|Rank 7/);
    expect(projectRecognitionSurface(context, { ...read, assistant: null }).heading).toBe("Assistant board unavailable");
    expect(projectRecognitionSurface(context, { ...read, assistant: board({ board: "subject" }) }).heading).toBe("Assistant board unavailable");
    expect(projectRecognitionSurface(context, { ...read, tournamentId: null }).heading).toBe("Choose a supplied tournament");
  });
  it("never displays ranks through isolation, missing eligibility or insufficient-trials gates", () => {
    expect(projectRecognitionSurface(context, { ...read, assistant: board({ status: "not ranked: isolation gate failed" }) }).heading).toBe("Not ranked");
    for (const eligibility of [undefined, { eligible: true, status: "insufficient: missing trials" }, { eligible: null }, { eligible: false }]) {
      const unsafe = board({ rows: [{ candidate_id: "c", display_name: "Candidate", rank: 99, eligibility, metrics: {} }] });
      expect(words(projectRecognitionSurface(context, { ...read, assistant: unsafe }))).not.toContain("Rank 99");
    }
  });
  it("keeps original labels, missing intervals and empty publications honest", () => {
    const original = { ...read, label: "original" as const, state: { kind: "published" as const, tournamentId: "actual-selection", label: "original" as const } };
    expect(projectRecognitionSurface(context, original).eyebrow).toBe("ORIGINAL PUBLISHED SNAPSHOT");
    const withoutInterval = board({ rows: [{ candidate_id: "c", display_name: "Candidate", rank: 4, eligibility: { eligible: true }, metrics: {} }] });
    expect(words(projectRecognitionSurface(context, { ...read, assistant: withoutInterval }))).toContain("interval unavailable");
    expect(projectRecognitionSurface(context, { ...read, assistant: board({ rows: [] }) }).lines).toEqual(["The supplied board contains no candidates."]);
  });
});
