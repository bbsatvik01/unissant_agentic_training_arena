/**
 * The world's state (D-020): everything the 3D scene shows, derived from the trial reducer's view, the time on the
 * session clock and when each frame arrived. The scene is a pure function of this value; it holds no session data
 * of its own and reads nothing else (FE-SSE-7: one data path for motion, the projected reducer state, S6 5.4).
 *
 * Rules carried here, not in the scene:
 *  - The subject's pose comes from the turn lifecycle and the speaking clock only (who is talking, for how long).
 *    No input reads an answer's category, a flag, a finding, the role or the style, and there is no demeanor pose
 *    (PRB-4; S6 6.4 forbidden inputs).
 *  - Coaching is visible only in practice (S6 5.4). In assessment the observation room is empty and the companion
 *    sleeps; no coaching-derived moment (card handed over, flag noticed) is produced.
 *  - The companion's pose comes from `petStateFor` (S6 6.3) with its one-shots timed from card arrivals.
 */

import { activeOneShot, cardSignals, petStateFor, type OneShot, type PetPose } from "../companion/fsm";
import { contentText, quoteOk } from "../contracts/quote";
import type { RoomStatus, TrialView } from "../trial/trialReducer";
import { speechDurationMs } from "./cadence";
import { SNAPSHOT_ARRIVAL } from "./recording";
import type { ShotName } from "./layout";

export type FigurePose = "idle" | "listening" | "thinking" | "speaking";
export type CoachPose = "away" | "idle" | "thinking" | "typing" | "handing" | "pointing";
export type CoachDesk = "question" | "flags" | "follow_up";

/** A line being spoken: the figure's mouth follows it from `startedAt` on the session clock. */
export interface Speech {
  readonly turn: number;
  readonly text: string;
  readonly startedAt: number;
}

export interface WallPaper {
  readonly record_id: string;
  readonly title: string;
  readonly releasedAtTurn: number;
  readonly trigger: "scheduled" | "requested";
  /** Released within EVIDENCE_MS: the camera turns to the wall (signature moment). */
  readonly fresh: boolean;
  /** When it arrived on the session clock, or null for a record already on file at the snapshot; the scene's
   * flight onto the wall is a function of the clock since then, so pause, speed and scrub drive it. */
  readonly releasedAt: number | null;
}

/** An accepted practice card's conflict flag, while it is being pointed out (contradiction noticed). */
export interface FlagMoment {
  readonly kind: "contradiction" | "evidence_conflict";
  readonly turn: number;
  readonly conflictTurn: number | null;
  readonly conflictRecord: string | null;
}

export interface WorldState {
  readonly status: RoomStatus;
  readonly mode: "practice" | "assessment";
  readonly subject: { readonly pose: FigurePose; readonly speech: Speech | null };
  readonly investigator: { readonly speech: Speech | null };
  readonly coaches: readonly { readonly desk: CoachDesk; readonly pose: CoachPose }[];
  readonly wall: readonly WallPaper[];
  readonly flag: FlagMoment | null;
  readonly pet: PetPose;
  /** The commitment hash once the trial is finalized; `fresh` while the seal is being stamped. */
  readonly seal: { readonly hash: string; readonly fresh: boolean; readonly at: number | null } | null;
  readonly debriefReady: boolean;
  /** The shot the room camera holds now. */
  readonly shot: ShotName;
  /** The same state in words (every animated state has a text equivalent, S6 6.6). */
  readonly caption: string;
  readonly exchanges: { readonly used: number; readonly cap: number };
}

export interface WorldInput {
  readonly view: TrialView | null;
  /** Now, on the session clock (playback time, or ms since the live session opened). */
  readonly nowMs: number;
  readonly arrivals: ReadonlyMap<string, number>;
  readonly subjectName: string;
  readonly investigatorActive: boolean;
  readonly reducedMotion: boolean;
  readonly paused: boolean;
}

/** How long a released record counts as fresh (its flight onto the wall). */
export const EVIDENCE_MS = 2_600;
/** How long the coaches hand a finished card over. */
export const HAND_MS = 1_400;
/** How long a conflict flag is pointed out. */
export const FLAG_MS = 6_000;
/** How long the seal is stamped. */
export const SEAL_MS = 2_400;

/** The neutral words for a session that ended other than by a committed finding (S6 4.3). */
const ENDED: Readonly<Partial<Record<TrialView["serverStatus"], string>>> = {
  subject_quarantined: "The session was stopped for a platform check. It is not counted.",
  infra_failed: "The session stopped because of a technical fault.",
  budget_skipped: "The session stopped because the spend limit was reached.",
  budget_truncated: "The session stopped because the spend limit was reached.",
};

const DESKS: readonly CoachDesk[] = ["question", "flags", "follow_up"];
/** While the coach works, each desk does its part: the flags desk reads, the others write. */
const WORKING: Readonly<Record<CoachDesk, CoachPose>> = { question: "typing", flags: "thinking", follow_up: "typing" };

function within(arrivals: ReadonlyMap<string, number>, key: string, nowMs: number, windowMs: number): boolean {
  const at = arrivals.get(key);
  return at !== undefined && nowMs >= at && nowMs - at < windowMs;
}

function turnNo(id: string | null): number | null {
  return id === null ? null : Number(id.slice(1, 3));
}

/**
 * The line a figure is speaking now: the newest turn's line, while its speaking window is open. A newer turn
 * ends the older line (a new question stops the previous answer).
 */
function speaking(texts: readonly { turn: number; text: string | null }[], prefix: string, input: WorldInput): Speech | null {
  const newest = texts.at(-1);
  if (newest === undefined || newest.text === null) return null;
  const entry = { turn: newest.turn, text: newest.text };
  const at = input.arrivals.get(`${prefix}:${String(entry.turn)}`);
  if (at === undefined || input.nowMs < at || input.nowMs - at >= speechDurationMs(entry.text)) return null;
  return { turn: entry.turn, text: entry.text, startedAt: at };
}

/** The newest accepted card's one-shot, while its window is open (S6 6.3: noticing over encouraging). */
function cardOneShot(view: TrialView, input: WorldInput): { kind: OneShot; at: number } | null {
  const card = view.cards.at(-1);
  if (card === undefined) return null;
  const at = input.arrivals.get(`coach.card:${String(card.turn_no)}`);
  if (at === undefined) return null;
  const { notice, encourage } = cardSignals(card.card);
  const kind: OneShot | null = notice ? "noticing" : encourage ? "encouraging" : null;
  return kind === null ? null : { kind, at };
}

function oneShot(view: TrialView, input: WorldInput): OneShot | null {
  if (view.mode !== "practice") return null;
  const candidates: { kind: OneShot; at: number }[] = [];
  const card = cardOneShot(view, input);
  if (card !== null) candidates.push(card);
  const ready = input.arrivals.get(SNAPSHOT_ARRIVAL);
  if (ready !== undefined && view.serverStatus === "running") candidates.push({ kind: "celebrating", at: ready });
  // A newer one-shot replaces an older one (S6 6.3).
  const newest = candidates.filter((c) => c.at <= input.nowMs).sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return null;
  return activeOneShot({ flagSeen: 0, encourageSeen: 0, celebrated: true, active: { kind: newest.kind, startedAt: newest.at } }, input.nowMs);
}

function flagMoment(view: TrialView, input: WorldInput): FlagMoment | null {
  if (view.mode !== "practice") return null;
  const card = view.cards.at(-1);
  if (card === undefined || !within(input.arrivals, `coach.card:${String(card.turn_no)}`, input.nowMs, FLAG_MS)) return null;
  const answer = (n: number | null) => view.turns.find((t) => t.turn_no === n)?.answer ?? "";
  for (const flag of card.card.flags) {
    // Only a verified citation is pointed out (S6 4.5): the server's check and the shared predicate both agree,
    // for the flagged quote and for the turn or released record it conflicts with.
    const record = view.released.find((r) => r.record_id === flag.conflict_record_id);
    const verified =
      card.card.validation.flags[flag.flag_ref]?.citation_ok !== false &&
      quoteOk(flag.quote, answer(turnNo(flag.turn_id))) &&
      (flag.conflict_quote === null || quoteOk(flag.conflict_quote, answer(turnNo(flag.conflict_turn_id)))) &&
      (flag.conflict_record_quote === null || record === undefined || quoteOk(flag.conflict_record_quote, contentText(record.content)));
    if (verified && (flag.kind === "contradiction" || flag.kind === "evidence_conflict")) {
      return {
        kind: flag.kind,
        turn: turnNo(flag.turn_id) ?? card.turn_no,
        conflictTurn: turnNo(flag.conflict_turn_id),
        conflictRecord: flag.conflict_record_id,
      };
    }
  }
  return null;
}

function coachPoses(view: TrialView, input: WorldInput, flag: FlagMoment | null): WorldState["coaches"] {
  if (view.mode !== "practice") return DESKS.map((desk) => ({ desk, pose: "away" as const }));
  const card = view.cards.at(-1);
  const handing = card !== undefined && within(input.arrivals, `coach.card:${String(card.turn_no)}`, input.nowMs, HAND_MS);
  return DESKS.map((desk) => {
    let pose: CoachPose = "idle";
    if (view.status === "coach_working") pose = WORKING[desk];
    else if (handing) pose = "handing";
    else if (flag !== null && desk === "flags") pose = "pointing";
    else if (view.status === "subject_answering") pose = "thinking";
    return { desk, pose };
  });
}

function caption(view: TrialView, input: WorldInput, wall: readonly WallPaper[], subjectPose: FigurePose): string {
  const fresh = wall.find((p) => p.fresh);
  if (view.status === "ended") {
    if (view.commitmentHash !== null) return "Session ended. Finding committed and sealed.";
    return ENDED[view.serverStatus] ?? "Session ended.";
  }
  if (view.status === "finalizing") return "Saving the finding.";
  if (fresh !== undefined) return `Record released: ${fresh.title}.`;
  const answering = subjectPose === "speaking" ? `${input.subjectName} is answering. ` : "";
  if (view.coachReading !== null) return `${answering}Coach is reading T${String(view.coachReading)}.`;
  if (view.status === "coach_working") return `${answering}Coach is reading the answer.`;
  if (answering !== "") return answering.trimEnd();
  if (view.status === "subject_answering") return `${input.subjectName} is preparing an answer.`;
  if (view.status === "cap_reached") return "This interview has reached its length limit; commit your finding.";
  return "Waiting for the next question.";
}

function shotFor(world: Pick<WorldState, "wall" | "flag" | "seal">): ShotName {
  if (world.seal?.fresh === true) return "table";
  if (world.wall.some((p) => p.fresh)) return "wall";
  // A conflict between two turns is pointed out from the observation room; one with a record is shown in the
  // room shot, where the thread from the wall to the subject's seat is in view.
  if (world.flag !== null && world.flag.conflictRecord === null) return "mirror";
  return "room";
}

/** The world at `input.nowMs`, or null before the snapshot. */
export function deriveWorld(input: WorldInput): WorldState | null {
  const { view } = input;
  if (view === null) return null;
  const turns = view.turns;
  const answer = speaking(turns.map((t) => ({ turn: t.turn_no, text: t.answer })), "subject.answer", input);
  const question = speaking(turns.map((t) => ({ turn: t.turn_no, text: t.question })), "question.accepted", input);
  let pose: FigurePose = "idle";
  if (view.status !== "ended") {
    if (answer !== null) pose = "speaking";
    else if (view.status === "subject_answering") pose = question === null ? "thinking" : "listening";
  }
  const wall: WallPaper[] = view.released.map((r) => ({
    record_id: r.record_id,
    title: r.title,
    releasedAtTurn: r.released_at_turn,
    trigger: r.trigger,
    fresh: within(input.arrivals, `evidence.released:${r.record_id}`, input.nowMs, EVIDENCE_MS),
    releasedAt: input.arrivals.get(`evidence.released:${r.record_id}`) ?? null,
  }));
  const flag = flagMoment(view, input);
  const seal = view.commitmentHash === null ? null : { hash: view.commitmentHash, fresh: within(input.arrivals, "trial.finalized", input.nowMs, SEAL_MS), at: input.arrivals.get("trial.finalized") ?? null };
  const latest = Math.max(0, ...[...input.arrivals.values()].filter((at) => at <= input.nowMs));
  const pet = petStateFor({
    mode: view.mode,
    status: view.status,
    coachWorking: view.mode === "practice" && view.status === "coach_working",
    investigatorActive: input.investigatorActive,
    oneShot: oneShot(view, input),
    reducedMotion: input.reducedMotion,
    isMobile: false,
    paused: input.paused,
    idleMs: input.nowMs - latest,
  });
  const partial = { wall, flag, seal };
  return {
    status: view.status,
    mode: view.mode,
    subject: { pose, speech: answer },
    investigator: { speech: question },
    coaches: coachPoses(view, input, flag),
    wall,
    flag,
    pet,
    seal,
    debriefReady: view.debriefReady !== null,
    shot: shotFor(partial),
    caption: caption(view, input, wall, pose),
    exchanges: { used: view.exchangesUsed, cap: view.exchangesCap },
  };
}

