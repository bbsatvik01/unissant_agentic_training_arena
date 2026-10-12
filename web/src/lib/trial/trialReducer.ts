/**
 * The room's trial lifecycle reducer (S6 6.1): pure, no React, no I/O.
 *
 * `trialReducer(state, action)` starts from the REST snapshot (S6 5.1) and folds the stream's deltas. Its
 * inputs are kept as data (the snapshot, the persisted frames after `snapshot.last_seq` by `seq`, the
 * synthesized hints as a set) and the view is derived from them on every change, persisted frames in `seq`
 * order (TechnoMile `lib/war-room/office.ts` lines 76-111, `foldOffice`). So the result does not depend on
 * arrival order, and a duplicate (a `seq` at or below the snapshot's `last_seq`, a `seq` already held, a hint
 * already held) changes nothing and returns the same state object (FE-SSE-2).
 *
 * Synthesized frames (`seq: null`: `subject.thinking`, `coach.working`, `trial.status` of a completed trial,
 * `notice`) are idempotent hints: they never stand in for a persisted row. The completion pair (SG4-02) is
 * `trial.status` (a hint when the trial completed) then `trial.finalized` (the row's `seq`): the room is
 * `ended` on the status and shows the commitment hash, once, when `trial.finalized` arrives.
 *
 * Visibility re-check (S6 5.4; defense in depth, the server filters first): in a running assessment no
 * coaching frame (`coach.working`, `coach.card`, `coach.update`, `coach.failed`) and no assistant finding is
 * folded, and a running assessment snapshot's coaching is withheld; a voice trial takes no text turns and no
 * coaching from the stream (S6 5.1: voice exchanges travel on the voice socket). Each refusal is recorded once
 * in `violations` for the controller to report; nothing from it is rendered (FE-SSE-3).
 *
 * Complete-card reveal (S6 4.5, SG4-23, FE-COACH-7): one rule for the snapshot and the stream (`judgeCard`),
 * applied once everything below the card is known.
 * A card for turn n at row seq S reading version v is stale when a later turn's question comes before S; otherwise
 * its context version is the newest of its answer's version and every release after the answer and before S, and
 * the card is shown only at exactly that version, else it is stale. The snapshot carries the seqs the rule needs
 * (`question_seq`, release and card `event_seq`). In a practice text trial (the only one with live cards) every
 * event row is live, so the owner's stream is gap-free (S5 6.1): a streamed card with a `seq` above the contiguous
 * prefix (`contiguousSeq`) is pending, neither shown nor refused, until the frames below it arrive; the session
 * controller re-reads the snapshot to cover the gap. Coaching frames never move the transcript version. A
 * `seq` the controller refused (a card failing validation, `seq_skipped`) counts toward the prefix without being
 * folded. A card that failed the schema is recorded by turn only (`card_refused`; nothing of it is kept), and a
 * refused card never shows again, from the stream or a snapshot (it was acknowledged invalid). A stale, pending or
 * refused card still closes its turn (the server closed it on the card row) and never reaches `cards`. Hints, the
 * client's own submit and refused cards survive a newer snapshot.
 *
 * Derived room status (C-45): `connecting` before the snapshot; `ended` on any terminal status;
 * `finalizing` from the client's own finding submit, or a `finding.committed` frame, until then; in a text trial
 * `subject_answering` while the newest turn has no answer, `coach_working` (practice) until its card or
 * `coach.failed`; `cap_reached` at the exchange cap; else `awaiting_question`. `reconnecting` is the
 * connection's state, kept by the session controller, not by this reducer.
 */

import type {
  CoachCard,
  CoachFailed,
  CoachUpdate,
  Notice,
  RequestableRecord,
  SnapshotRelease,
  SnapshotTurn,
  StoredFinding,
  TrialFrame,
  TrialSnapshot,
  VoiceExchange,
} from "../contracts/generated/types";

export type ServerStatus = TrialSnapshot["status"];
/** The interview room's own modes. A harness (tournament) trial has no investigator; the room shows it the
 * way it shows an assessment, coaching held back until the trial ends. */
export type RoomMode = "practice" | "assessment";

export type RoomStatus =
  | "connecting"
  | "awaiting_question"
  | "subject_answering"
  | "coach_working"
  | "cap_reached"
  | "finalizing"
  | "ended";

/** One text turn as the room shows it. `question` is null only while its question frame is still missing. */
export interface TurnView {
  readonly turn_no: number;
  readonly question: string | null;
  readonly source: SnapshotTurn["source"] | null;
  readonly answer: string | null;
  readonly partial: boolean;
  readonly committed_at: string | null;
}

export interface CommittedFinding {
  /**
   * Null when it came from the snapshot's `finding` (S6 5.3), which does not say who committed it. The snapshot's
   * finding alone never makes the room `finalizing`: the commit and the trial's end are one `finalize_trial` step.
   */
  readonly by: "investigator" | "assistant" | null;
  readonly finding: StoredFinding;
  readonly committed_at: string | null;
}

export type ViolationReason =
  | "assessment_coaching"
  | "assessment_assistant_finding"
  | "assessment_unattributed_finding"
  | "voice_text_frame";

/** A frame the projection should never have sent this viewer (S6 5.4), recorded once. */
export interface Violation {
  readonly key: string;
  readonly frame_type: string;
  readonly seq: number | null;
  readonly reason: ViolationReason;
}

export interface TrialView {
  readonly status: Exclude<RoomStatus, "connecting">;
  readonly serverStatus: ServerStatus;
  readonly reasonCode: string | null;
  readonly mode: RoomMode;
  readonly channel: TrialSnapshot["channel"];
  readonly split: TrialSnapshot["split"];
  readonly exchangesUsed: number;
  readonly exchangesCap: number;
  /** The newest transcript version seen: the next question's `expected_version`. */
  readonly transcriptVersion: number;
  /** The highest persisted `seq` folded or refused (the snapshot's `last_seq` at least). */
  readonly lastSeq: number;
  /** The end of the gap-free run of persisted `seq`s after the snapshot's `last_seq`. */
  readonly contiguousSeq: number;
  readonly turns: readonly TurnView[];
  readonly voiceExchanges: readonly VoiceExchange[];
  readonly released: readonly SnapshotRelease[];
  readonly requestable: readonly RequestableRecord[];
  /** Accepted cards only, by turn. */
  readonly cards: readonly CoachCard[];
  /** Turns whose card was refused: stale by the complete-card rule, or failing the schema. */
  readonly rejectedCards: readonly number[];
  /** Turns whose card reads a version not folded yet (S6 4.5); neither shown nor refused yet. */
  readonly pendingCards: readonly number[];
  readonly updates: readonly CoachUpdate[];
  readonly coachFailures: readonly CoachFailed[];
  /** The turn the coach is reading ("Coach is reading T5"), between `coach.working` and its card. */
  readonly coachReading: number | null;
  /** Practice: the newest coaching finding (a deep update supersedes its turn's card). */
  readonly runningFinding: StoredFinding | null;
  readonly committedFinding: CommittedFinding | null;
  readonly commitmentHash: string | null;
  /** The session id once `debrief.ready` arrived. */
  readonly debriefReady: string | null;
  readonly notices: readonly Notice[];
}

export interface TrialState {
  readonly snapshot: TrialSnapshot | null;
  /** Persisted frames after the snapshot's `last_seq`, by `seq`, one per `seq`. */
  readonly log: ReadonlyMap<number, TrialFrame>;
  /** Synthesized frames, one per distinct (type, data). */
  readonly hints: ReadonlyMap<string, TrialFrame>;
  readonly findingSubmitted: boolean;
  /** Turns whose `coach.card` frame failed the schema (no payload kept). */
  readonly refusedCards: ReadonlySet<number>;
  /** Persisted `seq`s known and deliberately not folded (a frame failing validation, or a gap given up on). */
  readonly skippedSeqs: ReadonlySet<number>;
  readonly violations: readonly Violation[];
  readonly view: TrialView | null;
}

export type TrialAction =
  | { readonly type: "snapshot"; readonly snapshot: TrialSnapshot }
  | { readonly type: "frame"; readonly frame: TrialFrame }
  | { readonly type: "card_refused"; readonly turn_no: number }
  | { readonly type: "seq_skipped"; readonly seq: number }
  | { readonly type: "finding_submitted" }
  | { readonly type: "finding_failed" };

/** What `applyFrame` did: folded it, already held it, refused it (S6 5.4), or had no snapshot to fold into. */
export type FrameOutcome = "applied" | "duplicate" | "violation" | "ignored";

const TERMINAL: ReadonlySet<ServerStatus> = new Set([
  "completed",
  "subject_quarantined",
  "assistant_failed",
  "infra_failed",
  "budget_skipped",
  "budget_truncated",
  "source_unavailable",
]);

const COACHING: ReadonlySet<TrialFrame["type"]> = new Set(["coach.working", "coach.card", "coach.update", "coach.failed"]);
const TEXT_TURN: ReadonlySet<TrialFrame["type"]> = new Set(["question.accepted", "subject.thinking", "subject.answer", ...COACHING]);

export function initialTrialState(): TrialState {
  return { snapshot: null, log: new Map(), hints: new Map(), findingSubmitted: false, refusedCards: new Set(), skippedSeqs: new Set(), violations: [], view: null };
}

export function roomStatus(state: TrialState): RoomStatus {
  return state.view?.status ?? "connecting";
}

function isTerminal(status: ServerStatus): boolean {
  return TERMINAL.has(status);
}

/** The snapshot's coaching is visible unless it is a running assessment (S6 5.4). */
function snapshotCoachingVisible(snapshot: TrialSnapshot): boolean {
  return snapshot.mode === "practice" || isTerminal(snapshot.status);
}

function snapshotLeaks(snapshot: TrialSnapshot): boolean {
  return !snapshotCoachingVisible(snapshot) && snapshot.cards.length + snapshot.updates.length + snapshot.coach_failures.length > 0;
}

/** Why the projection should not have sent this frame to this viewer, or null. */
function violationOf(snapshot: TrialSnapshot, frame: TrialFrame): ViolationReason | null {
  if (snapshot.channel === "voice" && TEXT_TURN.has(frame.type)) return "voice_text_frame";
  if (snapshot.mode === "assessment" && !isTerminal(snapshot.status)) {
    if (COACHING.has(frame.type)) return "assessment_coaching";
    if (frame.type === "finding.committed" && frame.data.by === "assistant") return "assessment_assistant_finding";
  }
  return null;
}

function hintKey(frame: TrialFrame): string {
  // A notice repeated later is news (the newest one shows), so its time is part of its identity.
  const when = frame.type === "notice" ? `@${frame.ts}` : "";
  return `${frame.type}:${JSON.stringify(frame.data)}${when}`;
}

/** A frame time as an instant: milliseconds, then the digits beyond them, so offsets and precision compare right. */
function instant(ts: string): readonly [number, string] {
  const ms = Date.parse(ts);
  const fraction = /\.(\d+)/.exec(ts)?.[1] ?? "";
  return [Number.isNaN(ms) ? -Infinity : ms, fraction.slice(3).padEnd(9, "0")];
}

function later(a: string, b: string): number {
  const [ams, arest] = instant(a);
  const [bms, brest] = instant(b);
  if (ams !== bms) return ams - bms;
  return arest < brest ? -1 : arest > brest ? 1 : 0;
}

function withViolation(state: TrialState, violation: Violation): TrialState {
  if (state.violations.some((v) => v.key === violation.key)) return state;
  return { ...state, violations: [...state.violations, violation] };
}

/** Fold one validated frame; says what it did. A duplicate returns the same state object. */
export function applyFrame(state: TrialState, frame: TrialFrame): { state: TrialState; outcome: FrameOutcome } {
  const { snapshot } = state;
  if (snapshot === null) return { state, outcome: "ignored" };
  const reason = violationOf(snapshot, frame);
  if (reason !== null) {
    const turn = "turn_no" in frame.data ? `turn ${String(frame.data.turn_no)}` : "";
    const key = `${reason}:${frame.type}:${frame.seq === null ? turn : String(frame.seq)}`;
    return { state: withViolation(state, { key, frame_type: frame.type, seq: frame.seq, reason }), outcome: "violation" };
  }
  if (frame.seq === null) {
    // A running status is no news: the snapshot said so, and a terminal status is never undone.
    if (frame.type === "trial.status" && frame.data.status === "running") return { state, outcome: "duplicate" };
    const key = hintKey(frame);
    if (state.hints.has(key)) return { state, outcome: "duplicate" };
    const hints = new Map(state.hints).set(key, frame);
    return { state: derive({ ...state, hints }), outcome: "applied" };
  }
  if (frame.seq <= snapshot.last_seq || state.log.has(frame.seq)) return { state, outcome: "duplicate" };
  const log = new Map(state.log).set(frame.seq, frame);
  return { state: derive({ ...state, log }), outcome: "applied" };
}

export function trialReducer(state: TrialState, action: TrialAction): TrialState {
  switch (action.type) {
    case "snapshot": {
      const { snapshot } = action;
      // Reads can overlap and settle out of order: a snapshot older than the one installed never replaces it.
      if (state.snapshot !== null && snapshot.last_seq < state.snapshot.last_seq) return state;
      // The snapshot holds everything up to its last_seq, with the seqs the card rule needs: frames and skip
      // markers at or below it are superseded.
      const log = new Map([...state.log].filter(([seq]) => seq > snapshot.last_seq));
      const skippedSeqs = new Set([...state.skippedSeqs].filter((seq) => seq > snapshot.last_seq));
      // Hints, the client's own submit and refused cards stay: they are facts a newer snapshot does not undo.
      let next: TrialState = { ...state, snapshot, log, skippedSeqs };
      if (snapshotLeaks(snapshot)) {
        next = withViolation(next, { key: "snapshot:assessment_coaching", frame_type: "snapshot", seq: null, reason: "assessment_coaching" });
      }
      // A running assessment shows only the investigator's own finding (S6 5.4); the snapshot's `finding` does not
      // say who wrote it (the commit and the end are one step, so a running snapshot should carry none).
      if (!snapshotCoachingVisible(snapshot) && snapshot.finding !== null) {
        next = withViolation(next, {
          key: "snapshot:assessment_unattributed_finding",
          frame_type: "snapshot",
          seq: null,
          reason: "assessment_unattributed_finding",
        });
      }
      return derive(next);
    }
    case "frame":
      return applyFrame(state, action.frame).state;
    case "card_refused":
      if (state.snapshot === null || state.refusedCards.has(action.turn_no)) return state;
      return derive({ ...state, refusedCards: new Set(state.refusedCards).add(action.turn_no) });
    case "seq_skipped": {
      const { snapshot } = state;
      if (snapshot === null || action.seq <= snapshot.last_seq || state.skippedSeqs.has(action.seq)) return state;
      return derive({ ...state, skippedSeqs: new Set(state.skippedSeqs).add(action.seq) });
    }
    case "finding_submitted":
      return state.findingSubmitted ? state : derive({ ...state, findingSubmitted: true });
    case "finding_failed":
      return state.findingSubmitted ? derive({ ...state, findingSubmitted: false }) : state;
  }
}

interface MutableTurn {
  turn_no: number;
  question: string | null;
  source: SnapshotTurn["source"] | null;
  answer: string | null;
  partial: boolean;
  committed_at: string | null;
  answerVersion: number | null;
}

function byKey<T>(map: ReadonlyMap<number, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
}

/** Where a card stands under the complete-card rule (S6 4.5), given what is known below its seq. */
type CardVerdict = "current" | "stale" | "ahead";

interface Ordered {
  /** The seq of each turn's question. */
  readonly questions: ReadonlyMap<number, number>;
  /** Every release: its row seq and the version it set. */
  readonly releases: readonly { readonly seq: number; readonly version: number }[];
  readonly turns: ReadonlyMap<number, MutableTurn>;
}

/**
 * One rule for snapshot and stream cards alike: a card for turn n at seq S reading version v is stale when a later
 * turn's question comes before S; otherwise its context version is the newest of its answer's version and every
 * release after that answer and before S. At the context version it is current, below it stale, above it (or with
 * no answer) it reads a frame not known here ("ahead").
 */
function judgeCard(n: number, seq: number, version: number, known: Ordered): CardVerdict {
  for (const [turnNo, questionSeq] of known.questions) if (turnNo > n && questionSeq < seq) return "stale";
  const answer = known.turns.get(n)?.answerVersion ?? null;
  if (answer === null) return "ahead";
  const context = Math.max(answer, ...known.releases.filter((r) => r.seq < seq && r.version > answer).map((r) => r.version));
  if (version === context) return "current";
  return version < context ? "stale" : "ahead";
}

/** Recompute the view from the snapshot, the persisted frames in seq order, and the hints. */
function derive(state: TrialState): TrialState {
  const { snapshot } = state;
  if (snapshot === null) return state;

  const turns = new Map<number, MutableTurn>();
  for (const t of snapshot.turns) {
    turns.set(t.turn_no, { ...t, answerVersion: t.answer_version });
  }
  const released = new Map<string, SnapshotRelease>(snapshot.released.map((r) => [r.record_id, r]));
  const cards = new Map<number, CoachCard>();
  const rejected = new Set<number>();
  const pending = new Set<number>();
  const updates = new Map<number, CoachUpdate>();
  const failures = new Map<number, CoachFailed>();
  const questions = new Map<number, number>(snapshot.turns.map((t) => [t.turn_no, t.question_seq]));
  const releases: { seq: number; version: number }[] = snapshot.released.map((r) => ({ seq: r.event_seq, version: r.transcript_version }));
  /** Every card to judge, from the snapshot or the stream, with its seq. */
  const toJudge: { readonly card: CoachCard; readonly seq: number; readonly version: number; readonly streamed: boolean }[] = [];
  if (snapshotCoachingVisible(snapshot)) {
    for (const c of snapshot.cards) {
      toJudge.push({ card: { turn_no: c.turn_no, card: c.card }, seq: c.event_seq, version: c.card.transcript_version, streamed: false });
    }
    for (const u of snapshot.updates) updates.set(u.turn_no, u);
    for (const f of snapshot.coach_failures) failures.set(f.turn_no, f);
  }

  let serverStatus: ServerStatus = snapshot.status;
  let reasonCode = snapshot.reason_code;
  let commitmentHash = snapshot.commitment_hash;
  let committed: CommittedFinding | null =
    snapshot.finding === null || !snapshotCoachingVisible(snapshot) ? null : { by: null, finding: snapshot.finding, committed_at: null };
  let committedOnStream = false;
  let debriefReady: string | null = null;
  let version = Math.max(0, ...snapshot.turns.map((t) => t.answer_version ?? 0), ...snapshot.released.map((r) => r.transcript_version));
  // A refused seq is known to exist: it counts toward the highest seq seen (so a gap below it is noticed), never
  // toward the gap-free prefix's content.
  let lastSeq = Math.max(snapshot.last_seq, ...state.skippedSeqs);
  let exchangesUsed = snapshot.exchanges_used;

  const turn = (n: number): MutableTurn => {
    let t = turns.get(n);
    if (t === undefined) {
      t = { turn_no: n, question: null, source: null, answer: null, partial: false, committed_at: null, answerVersion: null };
      turns.set(n, t);
    }
    return t;
  };
  const end = (status: ServerStatus, reason: string | null) => {
    if (isTerminal(status) && !isTerminal(serverStatus)) {
      serverStatus = status;
      reasonCode = reason;
    }
  };

  let askedUpTo = Math.max(0, ...snapshot.turns.map((t) => t.turn_no));
  let contiguousSeq = snapshot.last_seq;
  while (state.log.has(contiguousSeq + 1) || state.skippedSeqs.has(contiguousSeq + 1)) contiguousSeq += 1;
  /** The seq of each card that came on the stream, by turn. */
  const cardSeq = new Map<number, number>();
  for (const frame of byKey(state.log)) {
    if (frame.seq === null) continue;
    const v = frame.transcript_version;
    // Coaching never moves the transcript version (S5 5.1): a card's claim is checked, not believed.
    if (!COACHING.has(frame.type)) version = Math.max(version, v);
    lastSeq = Math.max(lastSeq, frame.seq);
    switch (frame.type) {
      case "question.accepted": {
        const t = turn(frame.data.turn_no);
        t.question = frame.data.text;
        t.source = frame.data.source;
        askedUpTo = Math.max(askedUpTo, frame.data.turn_no);
        questions.set(frame.data.turn_no, frame.seq);
        break;
      }
      case "subject.answer": {
        const t = turn(frame.data.turn_no);
        t.answer = frame.data.text;
        t.partial = frame.data.partial;
        t.committed_at = frame.data.committed_at;
        t.answerVersion = v;
        exchangesUsed = Math.max(exchangesUsed, frame.data.turn_no);
        break;
      }
      case "evidence.released":
        if (!released.has(frame.data.record_id)) released.set(frame.data.record_id, { ...frame.data, transcript_version: v, event_seq: frame.seq });
        releases.push({ seq: frame.seq, version: v });
        break;
      case "coach.card":
        cardSeq.set(frame.data.turn_no, frame.seq);
        toJudge.push({ card: frame.data, seq: frame.seq, version: v, streamed: true });
        break;
      case "coach.update":
        updates.set(frame.data.turn_no, frame.data);
        break;
      case "coach.failed":
        failures.set(frame.data.turn_no, frame.data);
        break;
      case "finding.committed":
        committed = { by: frame.data.by, finding: frame.data.finding, committed_at: frame.data.committed_at };
        committedOnStream = true;
        break;
      case "trial.status":
        end(frame.data.status, frame.data.reason_code);
        break;
      case "trial.finalized":
        commitmentHash = frame.data.commitment_hash;
        end("completed", null);
        break;
      case "debrief.ready":
        debriefReady = frame.data.session_id;
        break;
      default:
        // Synthesized types never carry a seq (the schema says so); nothing else to fold.
        break;
    }
  }

  const thinking = new Set<number>();
  const working = new Set<number>();
  /** The newest notice of each kind, by its `ts`, ties broken by text: independent of arrival order (FE-SSE-2). */
  const notices = new Map<Notice["kind"], { readonly ts: string; readonly notice: Notice }>();
  for (const hint of state.hints.values()) {
    if (!COACHING.has(hint.type)) version = Math.max(version, hint.transcript_version);
    if (hint.type === "subject.thinking") thinking.add(hint.data.turn_no);
    else if (hint.type === "coach.working") working.add(hint.data.turn_no);
    else if (hint.type === "trial.status") end(hint.data.status, hint.data.reason_code);
    else if (hint.type === "notice") {
      const held = notices.get(hint.data.kind);
      const order = held === undefined ? 1 : later(hint.ts, held.ts);
      const newer = held === undefined || order > 0 || (order === 0 && hint.data.text > held.notice.text);
      if (newer) notices.set(hint.data.kind, { ts: hint.ts, notice: hint.data });
    }
  }

  // Judge every card by the one rule, once everything below it is known. A snapshot card has everything below it
  // in the snapshot. A practice text stream is gap-free (S5 6.1), so a streamed card at or below the contiguous
  // prefix is judged now, and one above a gap waits (pending) for the frames below it.
  const gapFree = snapshot.mode === "practice" && snapshot.channel === "text";
  const known: Ordered = { questions, releases, turns };
  for (const { card, seq, version: v, streamed } of toJudge) {
    const n = card.turn_no;
    if (cards.has(n)) continue;
    rejected.delete(n);
    pending.delete(n);
    if (streamed && gapFree && seq > contiguousSeq) pending.add(n);
    else if (judgeCard(n, seq, v, known) === "current") cards.set(n, card);
    else rejected.add(n);
  }
  // A refused card stays refused, from the stream or the snapshot: it was acknowledged invalid (S6 5.6).
  for (const n of state.refusedCards) {
    cards.delete(n);
    pending.delete(n);
    rejected.add(n);
  }

  const turnList = byKey(turns);
  const newest = Math.max(0, ...turnList.map((t) => t.turn_no), ...thinking);
  const open = newest === 0 ? null : (turns.get(newest) ?? null);
  const closedByCoach = (n: number) => cards.has(n) || rejected.has(n) || pending.has(n) || failures.has(n);
  if (snapshot.channel === "text") exchangesUsed = Math.max(exchangesUsed, turnList.filter((t) => t.answer !== null).length);

  let status: TrialView["status"];
  if (isTerminal(serverStatus)) status = "ended";
  else if (state.findingSubmitted || committedOnStream) status = "finalizing";
  else if (snapshot.channel === "text" && newest > 0 && (open?.answer ?? null) === null) status = "subject_answering";
  else if (snapshot.channel === "text" && newest > 0 && snapshot.mode === "practice" && !closedByCoach(newest)) status = "coach_working";
  else if (exchangesUsed >= snapshot.exchanges_cap) status = "cap_reached";
  else status = "awaiting_question";

  const coachingShown = snapshot.mode === "practice";
  const latestCoaching = coachingShown
    ? [...byKey(cards).map((c) => ({ turn: c.turn_no, rank: 0, finding: c.card.finding })), ...byKey(updates).map((u) => ({ turn: u.turn_no, rank: 1, finding: u.update.finding }))]
        .sort((a, b) => a.turn - b.turn || a.rank - b.rank)
        .at(-1)
    : undefined;

  const view: TrialView = {
    status,
    serverStatus,
    reasonCode,
    mode: snapshot.mode === "harness" ? "assessment" : snapshot.mode,
    channel: snapshot.channel,
    split: snapshot.split,
    exchangesUsed,
    exchangesCap: snapshot.exchanges_cap,
    transcriptVersion: version,
    lastSeq,
    contiguousSeq,
    turns: turnList.map((t) => ({
      turn_no: t.turn_no,
      question: t.question,
      source: t.source,
      answer: t.answer,
      partial: t.partial,
      committed_at: t.committed_at,
    })),
    voiceExchanges: snapshot.voice_exchanges,
    released: [...released.values()].sort((a, b) => a.transcript_version - b.transcript_version || a.record_id.localeCompare(b.record_id)),
    requestable: snapshot.requestable,
    cards: byKey(cards),
    rejectedCards: [...rejected].sort((a, b) => a - b),
    pendingCards: [...pending].sort((a, b) => a - b),
    updates: byKey(updates),
    coachFailures: byKey(failures),
    coachReading: status === "coach_working" && working.has(newest) ? newest : null,
    runningFinding: latestCoaching?.finding ?? null,
    committedFinding: committed,
    commitmentHash,
    debriefReady,
    notices: [...notices.values()].map((n) => n.notice).sort((a, b) => a.kind.localeCompare(b.kind)),
  };
  return { ...state, view };
}
