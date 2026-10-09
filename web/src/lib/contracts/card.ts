/**
 * The card.v1 `question` block (S2 4.1, C-04): the only part of a coaching card the companion may
 * read (S6 6.3). Mirrored by hand from S2 until WP-02 exports the contract schemas and the frontend
 * generates its types from them (S6 5.2); the enums below are S2's, verbatim.
 */

export const QUESTION_TYPES = [
  "open",
  "probing",
  "closed",
  "leading",
  "suggestive",
  "compound",
  "forced_choice",
  "opinion",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export const NEUTRALITY_ISSUES = [
  "presupposes_fact",
  "accusatory_wording",
  "demeanor_reference",
  "multiple_questions",
  "limits_options",
  "solicits_opinion",
  "emotionally_loaded",
  "pressure_or_inducement",
] as const;

export type NeutralityIssue = (typeof NEUTRALITY_ISSUES)[number];

export interface CardQuestion {
  readonly question_type: QuestionType;
  /** Empty when the question is neutral (S2 4.1, at most 4). */
  readonly neutrality_issues: readonly NeutralityIssue[];
  /** One sentence on the question. */
  readonly assessment: string;
}
