import { describe, expect, it } from "vitest";
import { annotationDraft, assignmentDraft, LOCAL_COACH_LAB } from "./stationLab";

describe("local instructor draft preparation", () => {
  it("produces a local assignment artifact, never an invented wire body", () => {
    expect(assignmentDraft("  Sample trainee A  ", " CASE-A ", "  Practice neutrality ")).toEqual({ kind: "local-assignment-draft", traineeLabel: "Sample trainee A", caseId: "CASE-A", note: "Practice neutrality" });
    expect(assignmentDraft("A", "C", "")).not.toBeNull();
    expect(assignmentDraft(" ", "C", "Note")).toBeNull();
    expect(assignmentDraft("A", " ", "Note")).toBeNull();
    expect(assignmentDraft("A", "C", "x".repeat(2001))).toBeNull();
  });
  it("prepares the exact documented annotation shape only", () => {
    expect(annotationDraft(1234, " Check the cited turn ")).toEqual({ t_ms: 1234, text: "Check the cited turn" });
    expect(annotationDraft(0, "A")).toEqual({ t_ms: 0, text: "A" });
    expect(annotationDraft(-1, "A")).toBeNull();
    expect(annotationDraft(1.5, "A")).toBeNull();
    expect(annotationDraft(Infinity, "A")).toBeNull();
    expect(annotationDraft(0, " ")).toBeNull();
    expect(annotationDraft(0, "x".repeat(2001))).toBeNull();
  });
  it("keeps every coach fixture visibly fictitious with no real tournament result", () => {
    expect(LOCAL_COACH_LAB.versions).toHaveLength(2);
    for (const version of LOCAL_COACH_LAB.versions) {
      expect(version.id).toMatch(/^DEMO-/u);
      expect(version.history.join(" ")).toContain("Local illustration only");
      expect(version.lessons.every((lesson) => lesson.sourceRuns.every((source) => source.startsWith("LOCAL-DEMO-")))).toBe(true);
    }
    expect(LOCAL_COACH_LAB.experiments.every((metric) => metric.unit.startsWith("illustrative"))).toBe(true);
  });
});
