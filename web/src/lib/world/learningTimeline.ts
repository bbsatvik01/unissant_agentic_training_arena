/** Post-publication review only. Joins actual public judgments to the existing cursor's exact arrivals. */
import type { Debrief, EvidenceCoverage, FlagCheck, FollowUp, KeyQuestion, RubricCheck, RubricDimension, StoredFlag, Unsupported } from "../contracts/generated/types";
import type { TrialView } from "../trial/trialReducer";
import { questionReview } from "./debrief";
import { seek, startCursor, type Recording } from "./recording";

export interface PublishedCheck extends RubricCheck { readonly dimension: RubricDimension["dim_id"] }
export interface LearningTurn {
  readonly turn: number;
  /** Exact recorded question.accepted arrival; null when only a snapshot contains this turn. */
  readonly atMs: number | null;
  readonly question: string;
  readonly answer: string | null;
  readonly coachAssessment: string | null;
  readonly neutralityIssues: readonly string[];
  readonly flags: readonly { readonly flag: StoredFlag; readonly validation: FlagCheck | null }[];
  readonly suggested: FollowUp | null;
  readonly askedNext: string | null;
  readonly checks: readonly PublishedCheck[];
  readonly learning: readonly KeyQuestion[];
}
export interface LearningTimeline {
  readonly trialId: string;
  readonly sessionId: string;
  readonly scored: boolean;
  readonly turns: readonly LearningTurn[];
  /** No fabricated turn location for judgments whose published references are absent or missing. */
  readonly unlocatedChecks: readonly PublishedCheck[];
  readonly unlocatedLearning: readonly KeyQuestion[];
  readonly evidenceCoverage: EvidenceCoverage | null;
  readonly unsupported: Unsupported | null;
}

/**
 * `published` and `shown` must be the parent's canonical visible debrief/view, not the file's hidden
 * future state. Identity, own-session readiness and ended-state gates prevent an unrelated run or an
 * active/rewound assessment from gaining this review. Uses the existing seek/arrival implementation.
 */
export function recordedLearningTimeline(recording: Recording | null, published: Debrief | null, shown: TrialView | null): LearningTimeline | null {
  if (recording === null || published === null || published !== recording.debrief || shown?.status !== "ended" || shown.debriefReady !== published.session_id) return null;
  const end = seek(recording, startCursor(recording), recording.durationMs);
  if (end.state.view?.status !== "ended" || end.state.view.debriefReady !== published.session_id) return null;
  const reviews = questionReview(end.state.view);
  const turns = new Set(reviews.map((review) => review.turn));
  const checks: PublishedCheck[] = published.scored ? published.rubric.dimensions.flatMap((dimension) => dimension.checks.map((check) => ({ ...check, dimension: dimension.dim_id }))) : [];
  const learning = published.scored ? published.scorecards.learning.key_questions : [];
  return structuredClone({ trialId: recording.trial_id, sessionId: published.session_id, scored: published.scored,
    turns: reviews.map((review) => ({ turn: review.turn, atMs: end.arrivals.get(`question.accepted:${String(review.turn)}`) ?? null,
      question: review.question, answer: review.answer, coachAssessment: review.assessment, neutralityIssues: review.neutralityIssues,
      flags: review.card?.flags.map((flag) => ({ flag, validation: review.card?.validation.flags[flag.flag_ref] ?? null })) ?? [],
      suggested: review.card?.follow_up ?? null, askedNext: review.askedNext,
      checks: checks.filter((check) => check.turns.includes(review.turn)), learning: learning.filter((item) => item.addressed_turns.includes(review.turn)),
    })),
    unlocatedChecks: checks.filter((check) => check.turns.length === 0 || check.turns.some((turn) => !turns.has(turn))),
    unlocatedLearning: learning.filter((item) => item.addressed_turns.length === 0 || item.addressed_turns.some((turn) => !turns.has(turn))),
    evidenceCoverage: published.scored ? published.scorecards.learning.evidence_coverage : null,
    unsupported: published.scored ? published.scorecards.detection.unsupported : null,
  });
}
