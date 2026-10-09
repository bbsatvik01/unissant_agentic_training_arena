/**
 * @module companion/fsm
 *
 * The coach companion's pose: a PURE transition table, no state library (S6 6.3; UI direction 1.1;
 * C-38d). It shows the session's real work state, never anyone's demeanor (PRB-4).
 *
 * Lifted from gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/kin/fsm.ts`
 * lines 25-122 (see web/ATTRIBUTIONS.md). Kept: the pure `petStateFor(input)`, the precedence
 * ladder of one-shot windows over the status table, `SLEEP_AFTER_MS` and `ONE_SHOT_MS`, and the
 * reduced-motion and mobile collapse of every animation to a still pose (here also under the pause
 * control). Dropped: `approach` (roaming), `talk-sync` (the companion does not speak), dragging,
 * `farewell` and `error` (transport faults show in the room's status line, not on the pet).
 *
 * Arena rules (PRB-4, AST-10, C-38d):
 *   - Assessment mode, or an ended session, gives `sleeping`; in assessment no coaching-derived
 *     input reaches the companion at all (`trackOneShots` takes no signal there).
 *   - `encouraging` comes only from a practice card's `question` block, through `encourages()`.
 *   - `noticing` reads only that a card has at least one flag; no state reads the finding, the flag
 *     content, the answer category, role, style or any rubric score; no celebrating on findings.
 */

import type { CardQuestion } from "../contracts/card";

export type PetState = "idle" | "listening" | "thinking" | "noticing" | "encouraging" | "celebrating" | "sleeping";

/** `loop`: breathing, a looped gesture. `burst`: a one-shot. `still`: no animation at all. */
export type PetMotion = "loop" | "burst" | "still";

export interface PetPose {
  readonly state: PetState;
  readonly motion: PetMotion;
}

/** How long nothing may happen before an idle companion sleeps. */
export const SLEEP_AFTER_MS = 45_000;

/** How long a one-shot (`noticing`, `encouraging`, `celebrating`) holds. */
export const ONE_SHOT_MS = 1_600;

export type CompanionMode = "practice" | "assessment";

/**
 * The room's derived status (S6 6.1) as the companion sees it. There is no `reconnecting`: during a
 * stream retry the room keeps passing the status it had, so the pose stays unchanged.
 */
export type CompanionStatus =
  | "connecting"
  | "awaiting_question"
  | "subject_answering"
  | "coach_working"
  | "cap_reached"
  | "finalizing"
  | "ended";

export type OneShot = "noticing" | "encouraging" | "celebrating";

/** Everything the pose may depend on (FE-PET-2: nothing typed from findings, flags, categories, role, style or scores). */
export interface CompanionInput {
  readonly mode: CompanionMode;
  readonly status: CompanionStatus;
  /** Between `coach.working` and `coach.card` or `coach.failed`. */
  readonly coachWorking: boolean;
  /** The investigator typed (composer focused, draft changed within ONE_SHOT_MS) or voice capture is above the floor. */
  readonly investigatorActive: boolean;
  /** The active one-shot window (`activeOneShot`), or null. */
  readonly oneShot: OneShot | null;
  readonly reducedMotion: boolean;
  readonly isMobile: boolean;
  /** The header's pause control (S6 6.6). */
  readonly paused: boolean;
  /** How long nothing has happened, in ms. */
  readonly idleMs: number;
}

function motionFor(state: PetState, still: boolean): PetMotion {
  if (still || state === "sleeping") return "still";
  return state === "noticing" || state === "encouraging" || state === "celebrating" ? "burst" : "loop";
}

/**
 * The pose. Precedence: assessment or an ended session gives `sleeping`; otherwise the active
 * one-shot, then `thinking`, then `listening` (only while a question can be asked, S6 6.1), then
 * `idle`, which becomes `sleeping` after SLEEP_AFTER_MS. Under reduced motion, mobile or the pause
 * control the same pose is shown still.
 */
export function petStateFor(input: CompanionInput): PetPose {
  const still = input.reducedMotion || input.isMobile || input.paused;
  let state: PetState;
  if (input.mode === "assessment" || input.status === "ended") state = "sleeping";
  else if (input.oneShot !== null) state = input.oneShot;
  else if (input.coachWorking) state = "thinking";
  else if (input.investigatorActive && input.status === "awaiting_question") state = "listening";
  else if (input.idleMs > SLEEP_AFTER_MS) state = "sleeping";
  else state = "idle";
  return { state, motion: motionFor(state, still) };
}

/** True when a practice card's question earns a nod: open or probing, with no neutrality issue. */
export function encourages(question: CardQuestion): boolean {
  const { question_type: type, neutrality_issues: issues } = question;
  return issues.length === 0 && (type === "open" || type === "probing");
}

/**
 * What one accepted practice card contributes: `notice` when it has at least one flag (the flags'
 * content is typed `unknown` and never read) and `encourage` from its question block alone.
 */
export function cardSignals(card: { readonly question: CardQuestion; readonly flags: readonly unknown[] }): {
  readonly notice: boolean;
  readonly encourage: boolean;
} {
  return { notice: card.flags.length > 0, encourage: encourages(card.question) };
}

/** What the companion context publishes (S6 6.3 input): counters bumped by accepted practice cards. */
export interface CompanionSignals {
  readonly mode: CompanionMode;
  /** Bumped by each accepted practice card with at least one flag. */
  readonly flagSignal: number;
  /** Bumped by each accepted practice card whose question block `encourages()`. */
  readonly encourageSignal: number;
  /** The first snapshot of a new running session arrived. */
  readonly sessionReady: boolean;
}

/** One session's one-shot windows; the caller re-renders at `oneShotEndsAt`. */
export interface OneShotTracker {
  readonly flagSeen: number;
  readonly encourageSeen: number;
  readonly celebrated: boolean;
  readonly active: { readonly kind: OneShot; readonly startedAt: number } | null;
}

/** A tracker for one session, seeded from the current signals so that history never animates. */
export function startOneShots(signals: CompanionSignals): OneShotTracker {
  return {
    flagSeen: signals.flagSignal,
    encourageSeen: signals.encourageSignal,
    celebrated: signals.sessionReady,
    active: null,
  };
}

/**
 * Fold the latest signals at `nowMs`. A counter that rose starts its one-shot; when several start
 * together, `noticing` beats `encouraging` beats `celebrating`; a newer one-shot replaces an older
 * one. The celebration happens at most once per session. In assessment mode nothing starts.
 */
export function trackOneShots(tracker: OneShotTracker, signals: CompanionSignals, nowMs: number): OneShotTracker {
  const practice = signals.mode === "practice";
  const notice = practice && signals.flagSignal > tracker.flagSeen;
  const encourage = practice && signals.encourageSignal > tracker.encourageSeen;
  const celebrate = practice && signals.sessionReady && !tracker.celebrated;
  const kind: OneShot | null = notice ? "noticing" : encourage ? "encouraging" : celebrate ? "celebrating" : null;
  const unchanged =
    kind === null &&
    signals.flagSignal === tracker.flagSeen &&
    signals.encourageSignal === tracker.encourageSeen &&
    (tracker.celebrated || !signals.sessionReady);
  if (unchanged) return tracker;
  return {
    flagSeen: signals.flagSignal,
    encourageSeen: signals.encourageSignal,
    celebrated: tracker.celebrated || signals.sessionReady,
    active: kind === null ? tracker.active : { kind, startedAt: nowMs },
  };
}

/** The one-shot to show at `nowMs`, or null once its ONE_SHOT_MS window has passed. */
export function activeOneShot(tracker: OneShotTracker, nowMs: number): OneShot | null {
  const { active } = tracker;
  return active !== null && nowMs - active.startedAt < ONE_SHOT_MS ? active.kind : null;
}

/** When the current one-shot window closes, or null when none was started. */
export function oneShotEndsAt(tracker: OneShotTracker): number | null {
  return tracker.active === null ? null : tracker.active.startedAt + ONE_SHOT_MS;
}
