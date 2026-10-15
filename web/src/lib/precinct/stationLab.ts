/** UI-only seam models. These are not generated API contracts and are never sent anywhere. */
export interface CoachMetric { readonly label: string; readonly before: number; readonly after: number; readonly unit: string; readonly min: number; readonly max: number }
export interface CoachLesson { readonly title: string; readonly technique: string; readonly sourceRuns: readonly string[] }
export interface CoachVersion {
  readonly id: string;
  readonly name: string;
  readonly parent: string | null;
  readonly status: "champion" | "challenger";
  readonly lessons: readonly CoachLesson[];
  readonly history: readonly string[];
}
export interface CoachLabView {
  readonly versions: readonly CoachVersion[];
  readonly experiments: readonly CoachMetric[];
}
/** Intentionally fictitious, opt-in display data. Never treat as a tournament result or promote a candidate. */
export const LOCAL_COACH_LAB: CoachLabView = {
  versions: [
    { id: "DEMO-COACH-01", name: "Neutral inquiry / v1", parent: null, status: "champion", lessons: [{ title: "Ask for the missing detail", technique: "After an indirect answer, name the gap and ask one neutral follow-up.", sourceRuns: ["LOCAL-DEMO-RUN-A"] }], history: ["Local illustration only. No sealed tournament result."] },
    { id: "DEMO-COACH-02", name: "Neutral inquiry / v2", parent: "DEMO-COACH-01", status: "challenger", lessons: [{ title: "Test the alternative", technique: "Ask which released record could distinguish the offered explanation from another plausible account.", sourceRuns: ["LOCAL-DEMO-RUN-B"] }], history: ["Local illustration only. Promotion is not available."] },
  ],
  experiments: [
    { label: "Questioning quality", before: 62, after: 68, min: 0, max: 100, unit: "illustrative points / 100" },
    { label: "False-positive rate", before: 4, after: 4, min: 0, max: 100, unit: "illustrative percent" },
  ],
};

export interface LocalAssignmentDraft {
  readonly kind: "local-assignment-draft";
  readonly traineeLabel: string;
  readonly caseId: string;
  readonly note: string;
}
/** Assignment wire shape is unspecified in the brief: deliberately produce a local draft, not a request body. */
export function assignmentDraft(traineeLabel: string, caseId: string, note: string): LocalAssignmentDraft | null {
  if (traineeLabel.trim() === "" || caseId.trim() === "" || note.length > 2000) return null;
  return { kind: "local-assignment-draft", traineeLabel: traineeLabel.trim(), caseId: caseId.trim(), note: note.trim() };
}
export interface AnnotationBody { readonly t_ms: number; readonly text: string }
/** Exact documented POST /api/trials/{id}/annotations body; preparation only, no transmission. */
export function annotationDraft(tMs: number, text: string): AnnotationBody | null {
  if (!Number.isSafeInteger(tMs) || tMs < 0 || text.trim() === "" || text.length > 2000) return null;
  return { t_ms: tMs, text: text.trim() };
}
