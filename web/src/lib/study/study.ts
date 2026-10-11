/**
 * The KPI-1 study as the room shows it (S6 3.2, S3 6.1): two pre-tests, three practice sessions, two post-tests,
 * in that order. The server derives each session's phase and enforces the order; the client only reads the status
 * from `GET /api/me` (`study`) and words it: the step label, which modes the next session may use, and the seven
 * steps with their state for the progress view. Tests are assessment-mode text sessions; a practice step counts
 * only a practice-mode text session (an assessment or voice session does not, SG3-31), so a participant on a
 * practice step is offered Practice only.
 */
import type { Study } from "../api/client";

export type { Study };

export const PRE_TESTS = 2;
export const PRACTICE_SESSIONS = 3;
export const POST_TESTS = 2;

export type StudyMode = "practice" | "assessment";

/** The step the participant is on, in words: "Pre-test 1 of 2", "Practice 2 of 3", "Post-test 1 of 2". */
export function stepLabel(study: Study): string {
  switch (study.next_phase) {
    case "pre":
      return `Pre-test ${String(Math.min(study.ended.pre + 1, PRE_TESTS))} of ${String(PRE_TESTS)}`;
    case "practice":
      return `Practice ${String(Math.min(study.ended.practice + 1, PRACTICE_SESSIONS))} of ${String(PRACTICE_SESSIONS)}`;
    case "post":
      return `Post-test ${String(Math.min(study.ended.post + 1, POST_TESTS))} of ${String(POST_TESTS)}`;
    case "done":
      return "Study complete";
  }
}

/** The modes the next session may use: tests are assessments, practice steps are practice; anyone not in the
 * study (or done with it) may use either. */
export function allowedModes(study: Study | null): readonly StudyMode[] {
  if (study === null || study.next_phase === "done") return ["practice", "assessment"];
  return study.next_phase === "practice" ? ["practice"] : ["assessment"];
}

/** What the participant should do next, in one sentence. */
export function nextStepText(study: Study): string {
  switch (study.next_phase) {
    case "pre":
      return "Interview the subject on the case offered, without coaching, and commit your finding. Coaching for this test is saved for your debrief.";
    case "practice":
      return "Interview the subject in Practice mode, with the coach's cards beside you, and commit your finding.";
    case "post":
      return "Interview the subject on a new case, without coaching, and commit your finding. Coaching is saved for your debrief.";
    case "done":
      return "You have finished the study. Thank you. You can keep practising.";
  }
}

export interface StudyStep {
  readonly label: string;
  readonly state: "done" | "current" | "upcoming";
}

/** The seven steps in order with their state. */
export function studySteps(study: Study): readonly StudyStep[] {
  const phases: readonly { phase: Study["next_phase"]; name: string; total: number; ended: number }[] = [
    { phase: "pre", name: "Pre-test", total: PRE_TESTS, ended: study.ended.pre },
    { phase: "practice", name: "Practice", total: PRACTICE_SESSIONS, ended: study.ended.practice },
    { phase: "post", name: "Post-test", total: POST_TESTS, ended: study.ended.post },
  ];
  return phases.flatMap(({ phase, name, total, ended }) =>
    Array.from({ length: total }, (_, i) => {
      const doneHere = i < ended;
      const current = !doneHere && study.next_phase === phase && i === ended;
      return { label: `${name} ${String(i + 1)} of ${String(total)}`, state: doneHere ? "done" : current ? "current" : "upcoming" } as const;
    }),
  );
}
