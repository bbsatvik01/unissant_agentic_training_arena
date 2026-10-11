/**
 * The debrief as data for its scene (S6 4.7, stage 2): the per-question review built from the ended trial's turns and
 * the coaching the snapshot then includes, and the detection figures read from the published `debrief.v1`. Nothing
 * is scored here: every number comes from the document, and the review only lines up what was asked, what was
 * answered, how the coach read it and what the coach suggested next against the question actually asked next.
 */
import type { Debrief, ScoredDebrief } from "../contracts/generated/types";
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
  readonly flags: readonly { readonly kind: string; readonly quote: string }[];
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
      flags: card?.flags.map((f) => ({ kind: f.kind, quote: f.quote })) ?? [],
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
