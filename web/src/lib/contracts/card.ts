/**
 * The card.v1 `question` block (S2 4.1, C-04): the only part of a coaching card the companion may read
 * (S6 6.3). The type is generated from the exported wire schemas (WP-02, `generated/types.ts`); the two
 * lists below are the schema's enums as values, checked against the exported schema in `validate.test.ts`
 * and against the generated types at compile time.
 */

import type { Question } from "./generated/types";

export type QuestionType = Question["question_type"];
export type NeutralityIssue = Question["neutrality_issues"][number];
export type CardQuestion = Question;

export const QUESTION_TYPES = [
  "open",
  "probing",
  "closed",
  "leading",
  "suggestive",
  "compound",
  "forced_choice",
  "opinion",
] as const satisfies readonly QuestionType[];

export const NEUTRALITY_ISSUES = [
  "presupposes_fact",
  "accusatory_wording",
  "demeanor_reference",
  "multiple_questions",
  "limits_options",
  "solicits_opinion",
  "emotionally_loaded",
  "pressure_or_inducement",
] as const satisfies readonly NeutralityIssue[];
