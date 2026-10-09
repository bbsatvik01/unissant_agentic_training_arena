/**
 * @module voice/voiceMachine
 *
 * The PURE core of the voice channel: no React, no Web Audio, no WebSocket (S6 6.2).
 *
 * Lifted from gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/voiceMachine.ts`
 * (see web/ATTRIBUTIONS.md). Kept from the donor: the pure reducer shape, the terminal `ended`
 * state that absorbs every later event, the frame whitelist with unknown frames ignored (no cost
 * frame can ever reach the UI: the event union has no cost variant), the terminal-versus-transient
 * close-code split, and caption fragments merged by role.
 *
 * Arena changes (S6 6.2; S5 7.2-7.5, C-29):
 *   - States `idle, consent, connecting, listening, recording, thinking, speaking, reconnecting,
 *     ended`. The consent gate comes before the microphone: `connect` is accepted only from
 *     `consent`. `recording` exists only under push-to-talk while the talk control is held.
 *   - `status` is derived after every event from four kinds of fact: the connection, the server's
 *     activity (open utterance, investigator turn ended, investigator speaking), the talk control
 *     and actual playback (UI direction 3). `speaking` means audio is audible: queued audio keeps
 *     the subject speaking after `utterance_end`, and an open utterance whose audio is not playing
 *     yet (start-up, an underrun) reads as `thinking`, the subject preparing its answer.
 *   - Playback reports come from the audio layer across an asynchronous port and name the
 *     utterance being played, so a report the worklet posted before it flushed an interrupted
 *     utterance is recognised as stale and ignored. Playback progress stays in the browser: it
 *     drives the speaking state and nothing about it is sent to the server (S5 7.3, D7); the only
 *     controls the browser can send are `stop` and `interrupt` (`VoiceControl`).
 *   - Frames are the S5 7.3 set, checked field by field; a malformed frame is ignored like an
 *     unknown one. Turn text arrives on SSE: the machine keeps at most one live caption line.
 *     Each speaker's fragments build that speaker's own line until their final, whatever the other
 *     speaker sends in between, and the visible line is the latest speaker's. Nothing else cuts a
 *     line (not an utterance marker, a commit or a resume): transcription is not ordered against
 *     those events (S5 7.7).
 *   - Server activity is changed only by server activity: a commit records the committed turn and
 *     nothing else (it can arrive after the next question has begun), and a transport drop keeps
 *     an unfinished utterance, a pending answer and the question counts for the resumed session to
 *     continue or close. A drop changes no correlation; it only stops showing the investigator as
 *     speaking until a fragment of their question arrives on the new socket.
 *   - Input transcription is not ordered against the model's turns (S5 7.7), and no frame says which
 *     question an utterance answers. The machine pairs them by count instead, from S5 7.4: a turn
 *     commits only with both a question and an answer, so answers and questions pair off in order.
 *     It counts completed questions and started answers; a question is pending while completed
 *     questions outnumber started answers. An utterance that starts answers the next question, even
 *     one whose transcription has not arrived yet; questions completed before it beyond that one
 *     merged into its turn. Each `exchange_count` resynchronises both counts with the commits it
 *     reports (the trial count less the count when the session started, so a lost count is made good
 *     by the next and a session that starts mid-trial is not offset): commits bound started answers
 *     and completed questions from below, and never reduce what this client observed, however far
 *     the counts lag. An utterance answering no investigator input would never commit and would
 *     shift later questions by one; S5 7.4 commits every answer with its input and Live answers only
 *     input, so this is not corrected without relay correlation. A commit can count questions whose
 *     finals have not arrived (`aheadCount`): each such final then closes one without counting it
 *     again. Without relay correlation a question counted before its final is certainly late unless
 *     the socket dropped since the last count with no fragment of it arriving on the new socket; a
 *     drop also turns every counted question whose final is outstanding into such a guess, since
 *     that final may have been lost. It is read as late, and if the final so taken was really the
 *     next question's, the next commit's extra count corrects it first (`consumedGuesses`), so the
 *     bar under-reports at most that one pending answer. A count that covers every started answer
 *     shows an utterance whose end marker was lost in a drop as finished (display only; audio
 *     attribution follows utterance markers alone); a stale or repeated count changes nothing.
 *   - Close codes are the S5 7.5 table, including 4400, 4409 (subject guard hit), 4410, 4413 and
 *     4423; v1's 4429 is not recognised and so counts as transient.
 *   - Resume policy: a transient close resumes with `["voice-resume", token]` after 500, 1000 and
 *     2000 ms, at most three times per session (S5 7.2), and never after the server's `ended`
 *     frame, which precedes every terminal close.
 */

/** The machine's states (S6 6.2). */
export type VoiceStateName =
  | "idle"
  | "consent"
  | "connecting"
  | "listening"
  | "recording"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "ended";

/** OD-6 voice branch: open microphone or push-to-talk. Fixed for a session. */
export type VoiceMode = "live" | "push_to_talk";

/** The socket's lifecycle, as the machine knows it. */
export type VoiceConnection = "idle" | "consent" | "connecting" | "open" | "reconnecting" | "ended";

/** Why a session ended: the key the ended copy is chosen by. Never carries cost. */
export type VoiceEndKey =
  | "normal"
  | "protocol"
  | "unavailable"
  | "idle"
  | "subject_guard"
  | "exchange_cap"
  | "cost_cap"
  | "paused"
  | "resume_failed"
  | "transient_exhausted"
  | "error";

export type CaptionRole = "investigator" | "subject";

/** One speaker's fragments since their last final: `done` once that final arrived. */
export interface SpeechSegment {
  readonly text: string;
  readonly done: boolean;
}

/** The one live caption line; committed turns arrive on the trial stream (S6 5.1). */
export interface CaptionLine {
  readonly role: CaptionRole;
  readonly text: string;
}

/** The machine's full state. Never carries cost. */
export interface VoiceState {
  /** Derived from the facts below after every event. */
  readonly status: VoiceStateName;
  readonly mode: VoiceMode;
  readonly connection: VoiceConnection;
  /** The push-to-talk control is held. */
  readonly talkHeld: boolean;
  /** The server warned that its upstream session dropped and is resuming (`connection_lost_resume`). */
  readonly upstreamResuming: boolean;
  /** The subject utterance the server has open, or null. */
  readonly openUtterance: number | null;
  /** The highest utterance number seen this session (stale-frame guard). */
  readonly lastUtterance: number | null;
  /** Investigator questions completed (a final) this session, resynchronised at each commit. */
  readonly questionsDone: number;
  /** Subject answers started (`utterance_start`) this session, resynchronised at each commit. */
  readonly answersStarted: number;
  /** The trial's committed exchanges when this voice session started (from the trial stream). */
  readonly exchangesBefore: number;
  /** Exchanges committed in this voice session: the latest `exchange_count` less `exchangesBefore`. */
  readonly commits: number;
  /** The investigator has a question in progress (partials, no final yet). Kept across a drop. */
  readonly questionOpen: boolean;
  /**
   * Questions commits counted before their final arrived (late, or lost in a drop), oldest first:
   * their fragments continue them and each final closes one without counting it again.
   */
  readonly aheadCount: number;
  /**
   * How many of them, the newest, are guesses: counted after a drop with no fragment seen, so they
   * may have been lost rather than late. The rest are certainly late and are closed first.
   */
  readonly aheadGuesses: number;
  /**
   * Finals taken, on a guess (late, not lost), as late finals of counted questions and not yet
   * corrected. Later counts' extra commits correct these first, however many counts that takes.
   */
  readonly consumedGuesses: number;
  /** The socket dropped since the last count: frames may have been lost. */
  readonly droppedSinceCount: boolean;
  /**
   * The open utterance, once a count shows every started answer committed: its end marker was lost.
   * Display only: it reads as finished, but its audio stays attributed until a newer marker.
   */
  readonly settledUtterance: number | null;
  /** A fragment of the open question arrived on the current socket (a drop clears it). */
  readonly questionLive: boolean;
  /** Derived: a completed question is waiting for its answer. */
  readonly awaitingAnswer: boolean;
  /** Derived: the investigator is speaking a question no utterance has answered yet. */
  readonly investigatorSpeaking: boolean;
  /** The utterance whose audio is audible now, as the audio layer reports it, or null. */
  readonly audible: number | null;
  /** The last interrupted utterance: its audio, and any older, was flushed and cannot play again. */
  readonly interruptedUtterance: number | null;
  /** Each speaker's current line, built from their fragments until their final. */
  readonly speech: { readonly investigator: SpeechSegment | null; readonly subject: SpeechSegment | null };
  /** Whose text arrived last: the visible caption is that speaker's line. */
  readonly lastSpeaker: CaptionRole | null;
  /** Derived: the visible live caption line. */
  readonly caption: CaptionLine | null;
  readonly committedTurn: { readonly turnNo: number; readonly version: number } | null;
  readonly exchanges: { readonly used: number; readonly cap: number } | null;
  /** Seconds left from the latest `timer_tick` or `warning`, or null before the first. */
  readonly timeRemaining: number | null;
  /** The 60 s audio-cap warning arrived (S6 6.2: "Voice ends in 60 s; you can continue in text"). */
  readonly endingSoon: boolean;
  /** Client resumes used this session. */
  readonly resumeAttempts: number;
  /** The server sent `ended`: the close that follows is final. */
  readonly serverEnded: boolean;
  /** Set only when `status` is `ended`. */
  readonly endedKey: VoiceEndKey | null;
}

/** Events the reducer folds: server frames (through `frameToEvent`) and the session hook's own. */
export type VoiceEvent =
  /** The voice control was pressed: show the consent gate before any microphone access. */
  | { readonly type: "open_consent" }
  | { readonly type: "consent_declined" }
  /** Consent affirmed: microphone and ticket mint underway. */
  | { readonly type: "connect" }
  | { readonly type: "socket_open" }
  /** The socket closed with `code`; `resumable` when the hook holds a resume token. */
  | { readonly type: "socket_closed"; readonly code: number; readonly resumable: boolean }
  /** The client ended the session (hang-up, a failed ticket mint). */
  | { readonly type: "ended"; readonly key: VoiceEndKey }
  | { readonly type: "talk_start" }
  | { readonly type: "talk_end" }
  /** The audio layer is playing `utterance`'s audio, or nothing (drained, an underrun, flushed). */
  | { readonly type: "playback"; readonly utterance: number | null }
  | { readonly type: "utterance_start"; readonly utterance: number }
  | { readonly type: "utterance_end"; readonly utterance: number }
  | { readonly type: "interrupted"; readonly utterance: number }
  | { readonly type: "transcription"; readonly role: CaptionRole; readonly text: string; readonly partial: boolean }
  | { readonly type: "turn_committed"; readonly turnNo: number; readonly version: number }
  | { readonly type: "exchange_count"; readonly used: number; readonly cap: number }
  | { readonly type: "timer_tick"; readonly timeRemaining: number }
  | {
      readonly type: "warning";
      readonly reason: "ending_soon" | "connection_lost_resume";
      readonly seconds: number | null;
    }
  /** The server's `ended` frame; it precedes every terminal close (S5 7.3). */
  | { readonly type: "server_ended" };

/** S5 7.3: a transcription frame's text is at most 500 characters (code points). */
export const MAX_CAPTION_CHARS = 500;

/** Resume backoff by attempt, in ms (S6 6.2); its length is the per-session resume cap (S5 7.2). */
export const RESUME_BACKOFF_MS = [500, 1000, 2000] as const;

/** First subprotocol value of a resume connection: `["voice-resume", token]` (S5 7.2). */
export const RESUME_SUBPROTOCOL = "voice-resume";

/** S5 7.3: `exchange_count.cap` is always 12 (BKO-8). */
export const EXCHANGE_CAP = 12;

/**
 * The state before the voice control is used. `exchangesBefore` is the trial's committed exchange
 * count when the session starts, so `exchange_count` (a trial count) reconciles against this
 * session's own commits even when one count is lost in a drop.
 */
export function initialVoiceState(mode: VoiceMode, exchangesBefore = 0): VoiceState {
  return {
    status: "idle",
    mode,
    connection: "idle",
    talkHeld: false,
    upstreamResuming: false,
    openUtterance: null,
    lastUtterance: null,
    questionsDone: 0,
    answersStarted: 0,
    exchangesBefore,
    commits: 0,
    questionOpen: false,
    aheadCount: 0,
    aheadGuesses: 0,
    consumedGuesses: 0,
    droppedSinceCount: false,
    settledUtterance: null,
    questionLive: false,
    awaitingAnswer: false,
    investigatorSpeaking: false,
    audible: null,
    interruptedUtterance: null,
    speech: { investigator: null, subject: null },
    lastSpeaker: null,
    caption: null,
    committedTurn: null,
    exchanges: null,
    timeRemaining: null,
    endingSoon: false,
    resumeAttempts: 0,
    serverEnded: false,
    endedKey: null,
  };
}

/** True iff `code` is one of the S5 7.5 terminal close codes (no resume). */
export function isTerminalCloseCode(code: number): boolean {
  return closeCodeToEnded(code).terminal;
}

/**
 * Map a close code to `{ terminal, key }` (S5 7.5). Terminal codes carry their cause's key; any
 * other code (1006, 1011, v1's 4429) is transient and drives a resume, and its key is the one the
 * session ends with if no resume is possible.
 */
export function closeCodeToEnded(code: number): { terminal: boolean; key: VoiceEndKey } {
  switch (code) {
    case 1000:
      return { terminal: true, key: "normal" };
    case 4400:
      return { terminal: true, key: "protocol" };
    case 4401:
    case 4403:
    case 4404:
      return { terminal: true, key: "unavailable" };
    case 4408:
      return { terminal: true, key: "idle" };
    case 4409:
      return { terminal: true, key: "subject_guard" };
    case 4410:
      return { terminal: true, key: "exchange_cap" };
    case 4413:
      return { terminal: true, key: "cost_cap" };
    case 4423:
      return { terminal: true, key: "paused" };
    case 4503:
      return { terminal: true, key: "resume_failed" };
    default:
      return { terminal: false, key: "transient_exhausted" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Map one decoded server frame to a machine event, or null for a frame the machine ignores:
 * `resume` (the session hook keeps the token), every unknown type, and any frame whose fields do
 * not match S5 7.3.
 */
export function frameToEvent(frame: unknown): VoiceEvent | null {
  if (!isRecord(frame)) return null;
  const type = frame["type"];
  switch (type) {
    case "utterance_start":
    case "utterance_end":
    case "interrupted": {
      const utterance = frame["utterance"];
      return isCount(utterance) ? { type, utterance } : null;
    }
    case "transcription": {
      const { role, text, partial } = frame;
      if (role !== "investigator" && role !== "subject") return null;
      if (typeof text !== "string" || Array.from(text).length > MAX_CAPTION_CHARS || typeof partial !== "boolean") return null;
      return { type, role, text, partial };
    }
    case "turn_committed": {
      const { turn_no: turnNo, version } = frame;
      return isCount(turnNo) && isCount(version) ? { type, turnNo, version } : null;
    }
    case "exchange_count": {
      const { used, cap } = frame;
      return isCount(used) && cap === EXCHANGE_CAP && used <= cap ? { type, used, cap } : null;
    }
    case "timer_tick": {
      const remaining = frame["time_remaining"];
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
      return { type, timeRemaining: Math.max(0, Math.floor(remaining)) };
    }
    case "warning": {
      const { reason, seconds } = frame;
      if (reason !== "ending_soon" && reason !== "connection_lost_resume") return null;
      if (seconds === undefined) return { type, reason, seconds: null };
      return isCount(seconds) ? { type, reason, seconds } : null;
    }
    case "ended":
      // The close code that follows is authoritative for the cause.
      return { type: "server_ended" };
    default:
      // `resume`, any unknown or cost-shaped type: ignored (defence in depth).
      return null;
  }
}

/**
 * Add one fragment to its speaker's line (the donor's merge by role, kept per speaker): it extends
 * the line until that speaker's final, and after a final it starts a new one. An empty final only
 * closes the line. The newest MAX_CAPTION_CHARS code points are kept.
 */
function addFragment(segment: SpeechSegment | null, text: string, partial: boolean): SpeechSegment | null {
  const open = segment !== null && !segment.done ? segment : null;
  if (text === "") return open === null ? segment : { text: open.text, done: !partial };
  const points = Array.from((open?.text ?? "") + text);
  return { text: points.slice(-MAX_CAPTION_CHARS).join(""), done: !partial };
}

/**
 * What a transport drop or reopen makes stale: the server's upstream-resume notice (the client's own
 * resume supersedes it) and the sign that the investigator is speaking right now (no fragment has
 * arrived on the new socket). Correlation carries over: an unfinished utterance, a pending answer,
 * the open question's mark, the caption and actual playback. The resumed session continues or
 * closes them with its own frames, so a late final of a question an utterance already answered
 * still retires it, as it would without the drop.
 */
const FRESH_ACTIVITY = {
  upstreamResuming: false,
  questionLive: false,
} as const;

type Facts = Omit<VoiceState, "status" | "awaitingAnswer" | "investigatorSpeaking" | "caption">;

function deriveStatus(s: Facts & Pick<VoiceState, "awaitingAnswer">): VoiceStateName {
  switch (s.connection) {
    case "idle":
    case "consent":
    case "connecting":
    case "reconnecting":
    case "ended":
      return s.connection;
    case "open":
      if (s.upstreamResuming) return "reconnecting";
      if (s.audible !== null) return "speaking";
      if (s.mode === "push_to_talk" && s.talkHeld) return "recording";
      if (s.awaitingAnswer || (s.openUtterance !== null && s.openUtterance !== s.settledUtterance)) return "thinking";
      return "listening";
  }
}

/** Recompute the derived fields from the facts. */
function withStatus(next: Facts): VoiceState {
  const awaitingAnswer = next.questionsDone > next.answersStarted;
  // The question in progress is number questionsDone + 1 (questionsDone once a commit counted it);
  // it is unanswered unless an answer to it started.
  const inProgress = next.questionsDone - next.aheadCount + 1;
  const investigatorSpeaking = next.questionOpen && next.questionLive && inProgress > next.answersStarted;
  const line = next.lastSpeaker === null ? null : next.speech[next.lastSpeaker];
  const caption = next.lastSpeaker === null || line === null ? null : { role: next.lastSpeaker, text: line.text };
  return { ...next, awaitingAnswer, investigatorSpeaking, caption, status: deriveStatus({ ...next, awaitingAnswer }) };
}

function endSession(state: VoiceState, key: VoiceEndKey): VoiceState {
  return withStatus({
    ...state,
    connection: "ended",
    upstreamResuming: false,
    openUtterance: null,
    questionOpen: false,
    aheadCount: 0,
    aheadGuesses: 0,
    consumedGuesses: 0,
    droppedSinceCount: false,
    settledUtterance: null,
    questionLive: false,
    questionsDone: 0,
    answersStarted: 0,
    talkHeld: false,
    audible: null,
    speech: { investigator: null, subject: null },
    lastSpeaker: null,
    endingSoon: false,
    endedKey: key,
  });
}

function onClose(state: VoiceState, code: number, resumable: boolean): VoiceState {
  const { terminal, key } = closeCodeToEnded(code);
  if (terminal) return endSession(state, key);
  if (state.serverEnded) return endSession(state, "normal");
  if (!resumable || state.resumeAttempts >= RESUME_BACKOFF_MS.length) return endSession(state, key);
  return withStatus({
    ...state,
    ...FRESH_ACTIVITY,
    droppedSinceCount: true,
    // A final still outstanding may be lost in this drop: every counted question becomes a guess.
    aheadGuesses: state.aheadCount,
    connection: "reconnecting",
    resumeAttempts: state.resumeAttempts + 1,
  });
}

/** The events `frameToEvent` produces: server activity, applied only on an open socket. */
type ServerEvent = Extract<
  VoiceEvent,
  {
    readonly type:
      | "utterance_start"
      | "utterance_end"
      | "interrupted"
      | "transcription"
      | "turn_committed"
      | "exchange_count"
      | "timer_tick"
      | "warning"
      | "server_ended";
  }
>;

function onServerFrame(state: VoiceState, event: ServerEvent): VoiceState {
  switch (event.type) {
    case "utterance_start":
      if (state.lastUtterance !== null && event.utterance <= state.lastUtterance) return state;
      return withStatus({
        ...state,
        upstreamResuming: false,
        openUtterance: event.utterance,
        lastUtterance: event.utterance,
        answersStarted: state.answersStarted + 1,
        // It answers the next question; any further completed questions merged into its turn.
        questionsDone: Math.min(state.questionsDone, state.answersStarted + 1),
      });
    case "utterance_end":
      if (event.utterance !== state.openUtterance) return state;
      return withStatus({ ...state, upstreamResuming: false, openUtterance: null });
    case "interrupted":
      // Barge-in: the server flushed its audio and the hook flushes the playback queue, so nothing
      // queued up to this utterance can play again.
      if (event.utterance !== state.lastUtterance) return state;
      return withStatus({
        ...state,
        upstreamResuming: false,
        openUtterance: null,
        audible: null,
        interruptedUtterance: event.utterance,
      });
    case "transcription": {
      const speech = { ...state.speech, [event.role]: addFragment(state.speech[event.role], event.text, event.partial) };
      const lastSpeaker = event.text === "" ? state.lastSpeaker : event.role;
      const heard = { ...state, upstreamResuming: false, speech, lastSpeaker };
      if (event.role === "subject") return withStatus(heard);
      if (event.partial) return withStatus({ ...heard, questionOpen: true, questionLive: true });
      // A final completes the question in progress; an empty final with none in progress is no question,
      // and the final of a question a commit already counted only closes it.
      const ahead = state.aheadCount > 0;
      const guess = ahead && state.aheadCount === state.aheadGuesses;
      const completes = !ahead && (state.questionOpen || event.text !== "");
      return withStatus({
        ...heard,
        questionOpen: false,
        // Certain ones (older) close first; closing a guess records it for the next count to check.
        aheadCount: ahead ? state.aheadCount - 1 : 0,
        aheadGuesses: guess ? state.aheadGuesses - 1 : state.aheadGuesses,
        consumedGuesses: guess ? state.consumedGuesses + 1 : state.consumedGuesses,
        questionLive: false,
        questionsDone: completes ? state.questionsDone + 1 : state.questionsDone,
      });
    }
    case "turn_committed": {
      // Records the committed turn only. Its text arrives on SSE; the caption keeps the latest
      // speech until the next speaker replaces it, and the next question's activity, which may
      // already be under way when this frame arrives, is left alone.
      const previous = state.committedTurn;
      const newer =
        previous === null ||
        event.turnNo > previous.turnNo ||
        (event.turnNo === previous.turnNo && event.version > previous.version);
      return withStatus({
        ...state,
        upstreamResuming: false,
        committedTurn: newer ? { turnNo: event.turnNo, version: event.version } : previous,
      });
    }
    case "exchange_count": {
      // The count is the trial's, absolute: this session's commits are it less the count at its start,
      // so a lost count is made good by the next one. An older count changes nothing.
      // A stale or repeated count is ignored whole, like a stale utterance marker.
      if (state.exchanges !== null && event.used <= state.exchanges.used) return state;
      const commits = Math.max(state.commits, event.used - state.exchangesBefore);
      const answering = state.openUtterance !== null && state.openUtterance !== state.settledUtterance;
      // Commits only add: answers this client saw start stay counted however far the counts lag.
      const answersStarted = Math.max(state.answersStarted, commits);
      // Extra commits first correct finals guessed late since the last count (those questions were
      // lost in a drop and the finals were the next questions'); the rest are questions still to come.
      const extra = Math.max(0, commits - state.questionsDone);
      const corrected = Math.min(extra, state.consumedGuesses);
      const added = extra - corrected;
      // The oldest added question is certainly late, not lost, if its partials are arriving on this
      // socket (questionLive implies a question in progress).
      const inProgressCounted = added > 0 && state.aheadCount === 0 && state.questionLive ? 1 : 0;
      return withStatus({
        ...state,
        upstreamResuming: false,
        exchanges: { used: event.used, cap: event.cap },
        commits,
        answersStarted,
        // Every started answer has committed, so the open one finished: its end marker was lost in a
        // drop. Only the display follows; audio attribution changes only on utterance markers.
        settledUtterance: answering && commits >= answersStarted ? state.openUtterance : state.settledUtterance,
        questionsDone: Math.max(state.questionsDone, commits),
        // The added questions' finals are still to come. Without a drop since the last count none can
        // have been lost, so they are certainly late; after one, those with no fragment seen are guesses.
        aheadCount: state.aheadCount + added,
        aheadGuesses: state.aheadGuesses + (state.droppedSinceCount ? added - inProgressCounted : 0),
        // A correction this count could not apply yet (the next question beat it) waits for the next.
        consumedGuesses: state.consumedGuesses - corrected,
        droppedSinceCount: false,
      });
    }
    case "timer_tick":
      return withStatus({ ...state, timeRemaining: event.timeRemaining });
    case "warning":
      if (event.reason === "connection_lost_resume") return withStatus({ ...state, upstreamResuming: true });
      return withStatus({ ...state, endingSoon: true, timeRemaining: event.seconds ?? state.timeRemaining });
    case "server_ended":
      return withStatus({ ...state, serverEnded: true });
  }
}

/**
 * The pure reducer. Once `ended`, every later event returns the same state object: a late frame
 * after the close cannot resurrect the session. Never mutates `state`.
 */
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  if (state.connection === "ended") return state;
  switch (event.type) {
    case "open_consent":
      return state.connection === "idle" ? withStatus({ ...state, connection: "consent" }) : state;
    case "consent_declined":
      return state.connection === "consent" ? withStatus({ ...state, connection: "idle" }) : state;
    case "connect":
      return state.connection === "consent" ? withStatus({ ...state, connection: "connecting", endedKey: null }) : state;
    case "socket_open":
      if (state.connection !== "connecting" && state.connection !== "reconnecting") return state;
      return withStatus({ ...state, ...FRESH_ACTIVITY, connection: "open" });
    case "socket_closed":
      if (state.connection === "idle" || state.connection === "consent") return state;
      return onClose(state, event.code, event.resumable);
    case "ended":
      return endSession(state, event.key);
    case "talk_start":
      return state.connection === "open" && state.mode === "push_to_talk"
        ? withStatus({ ...state, talkHeld: true })
        : state;
    case "talk_end":
      return state.talkHeld ? withStatus({ ...state, talkHeld: false }) : state;
    case "playback": {
      const { utterance } = event;
      const flushed =
        utterance !== null && state.interruptedUtterance !== null && utterance <= state.interruptedUtterance;
      // A report posted before the worklet processed a flush names audio that can no longer play.
      return flushed ? state : withStatus({ ...state, audible: utterance });
    }
    default:
      return state.connection === "open" ? onServerFrame(state, event) : state;
  }
}

/** The delay before the pending client resume, or null when none is pending. */
export function resumeDelayMs(state: VoiceState): number | null {
  if (state.connection !== "reconnecting") return null;
  return RESUME_BACKOFF_MS[state.resumeAttempts - 1] ?? null;
}

/**
 * The utterance an inbound audio frame belongs to, or null when it must be dropped. Audio is always
 * inside an open utterance (S5 7.3), so audio arriving after `utterance_end` or `interrupted` is
 * never queued and never counted as played (S5 7.8).
 */
export function audioUtterance(state: VoiceState): number | null {
  return state.connection === "open" ? state.openUtterance : null;
}

/**
 * The controls the browser may send (S5 7.3). Audio goes as binary frames. There is no playback
 * control: playback progress stays in the browser (D7), and a `played` or `context_changed` frame
 * from the browser closes the session with 4400.
 */
export type VoiceControl = { readonly type: "stop" } | { readonly type: "interrupt" };

/** The text frame for a control. */
export function controlFrame(control: VoiceControl): string {
  return JSON.stringify({ type: control.type });
}

/** The voice bar's states (S6 6.2); the copy for each lives with the component. */
export type VoiceBarState =
  | "hidden"
  | "connecting"
  | "listening"
  | "recording"
  | "investigator_speaking"
  | "preparing_answer"
  | "subject_speaking"
  | "ended";

export interface VoiceBarInput {
  /** Connection, server activity and playback. */
  readonly voice: VoiceState;
  /** Microphone capture: the capture tap's level is above the silence floor this frame. */
  readonly captureAboveFloor: boolean;
}

/** The bar's state from its four inputs: connection, capture, server activity and playback. */
export function voiceBarState({ voice, captureAboveFloor }: VoiceBarInput): VoiceBarState {
  const investigatorSpeaking = captureAboveFloor || voice.investigatorSpeaking;
  switch (voice.status) {
    case "idle":
    case "consent":
      return "hidden";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "ended":
      return "ended";
    case "speaking":
      return "subject_speaking";
    case "recording":
      return "recording";
    case "thinking":
      return investigatorSpeaking ? "investigator_speaking" : "preparing_answer";
    case "listening":
      return investigatorSpeaking ? "investigator_speaking" : "listening";
  }
}

/** Motion settings every per-frame value honours (S6 6.6). */
export interface MotionGate {
  readonly reducedMotion: boolean;
  readonly paused: boolean;
}

function unit(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/**
 * The one amplitude the subject's mouth and the bar's ring both read (`--arena-talk`, 0-1), taken
 * from the playback node's analyser. It reads 0 unless audio is actually playing, so `interrupted`
 * stops playback, ring and mouth on the same frame; under reduced motion or the pause control it
 * stays 0 and the bar's words carry the state.
 */
export function talkLevel(voice: VoiceState, playbackLevel: number, motion: MotionGate): number {
  if (motion.reducedMotion || motion.paused || voice.audible === null) return 0;
  return unit(playbackLevel);
}

/**
 * The investigator's own input meter (`--arena-input-level`, 0-1): shown only while capture is
 * above the floor and the microphone is live; still under reduced motion or the pause control.
 */
export function inputLevel(voice: VoiceState, captureLevel: number, floor: number, motion: MotionGate): number {
  if (motion.reducedMotion || motion.paused) return 0;
  const micLive = voice.connection === "connecting" || voice.connection === "open" || voice.connection === "reconnecting";
  return micLive && captureLevel > floor ? unit(captureLevel) : 0;
}
