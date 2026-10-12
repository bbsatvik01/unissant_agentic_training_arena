/**
 * The debrief as data for its scene (S6 4.7, stage 2): the per-question review built from the ended trial's turns and
 * the coaching the snapshot then includes, and the detection figures read from the published `debrief.v1`. Nothing
 * is scored here: every number comes from the document, and the review only lines up what was asked, what was
 * answered, how the coach read it and what the coach suggested next against the question actually asked next.
 */
import type { CoachCard, Debrief, ScoredDebrief, SnapshotRelease } from "../contracts/generated/types";
import { EX4_TEXT } from "../copy/ex4";
import type { TrialView } from "../trial/trialReducer";

export interface QuestionReview {
  readonly turn: number;
  readonly question: string;
  readonly answer: string | null;
  /** The coach's reading of the question (type and neutrality issues), when its card was shown. */
  readonly questionType: string | null;
  readonly neutralityIssues: readonly string[];
  readonly assessment: string | null;
  readonly answerCategory: string | null;
  /** The card the coach gave on this turn (its flags, with the server's citation checks), when there was one. */
  readonly card: CoachCard["card"] | null;
  /** Records released after this turn, in order. */
  readonly released: readonly SnapshotRelease[];
  /** The coach's suggested follow-up, and the question the investigator asked next. */
  readonly suggested: string | null;
  readonly askedNext: string | null;
}

/** One entry per answered turn, in order. */
export function questionReview(view: TrialView): readonly QuestionReview[] {
  const cards = new Map(view.cards.map((c) => [c.turn_no, c.card]));
  const turns = view.turns.filter((t) => t.question !== null);
  return turns.map((t, i) => {
    const card = cards.get(t.turn_no);
    return {
      turn: t.turn_no,
      question: t.question ?? "",
      answer: t.answer,
      questionType: card?.question.question_type ?? null,
      neutralityIssues: card?.question.neutrality_issues ?? [],
      assessment: card?.question.assessment ?? null,
      answerCategory: card?.answer_category ?? null,
      card: card ?? null,
      released: view.released.filter((r) => r.released_at_turn === t.turn_no),
      suggested: card?.follow_up.question ?? null,
      askedNext: turns[i + 1]?.question ?? null,
    };
  });
}

/** The coach's detection scorecard from an scored debrief, or null for an unscored (voice) one. The figures are the
 * document's own, shown as "found n of m"; the client does no arithmetic on them (FE-DEB-2, FE-DEB-3). */
export function detectionOf(debrief: Debrief): ScoredDebrief["scorecards"]["detection"] | null {
  return debrief.scored ? debrief.scorecards.detection : null;
}

/** "n of m", or "undefined" when there is nothing to find (a zero denominator, FE-DEB-3). */
export function ofText(found: number, total: number): string {
  return total === 0 ? "undefined" : `${String(found)} of ${String(total)}`;
}

/** The debrief's JSON export (S6 4.7 region 6): the published `debrief.v1` document as it is, with EX-4. */
export function debriefExport(debrief: Debrief): string {
  return `${JSON.stringify({ ex4: EX4_TEXT, debrief }, null, 2)}\n`;
}

/** The export's file name: the session it belongs to, no date. */
export function exportName(debrief: Debrief): string {
  return `debrief-${debrief.session_id}.json`;
}

/** The ended trial's own state, from its snapshot after the end (which includes coaching an assessment withheld). */
export interface EndedTrial {
  readonly trialId: string;
  readonly view: TrialView;
}

/** The view the debrief reviews: the ended trial's snapshot when one was read for this recording's trial (a replay of
 * one's own run; recordings carry an assessment's coaching only there, FE-DEB-4), else the view on screen. */
export function debriefView(onScreen: TrialView | null, ended: EndedTrial | null, recordingTrialId: string | null): TrialView | null {
  return ended !== null && recordingTrialId === ended.trialId ? ended.view : onScreen;
}
