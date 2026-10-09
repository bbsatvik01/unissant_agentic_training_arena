/**
 * @module voice/voiceMachine
 *
 * The PURE core of the voice channel: no React, no Web Audio, no WebSocket (S6 6.2).
 *
 * Lifted from gokbase `recruiter-frontend/src/sections/knowledge-base/public/voice/voiceMachine.ts`
 * (see web/ATTRIBUTIONS.md). Kept from the donor: the pure reducer shape, the terminal `ended`
 * state that absorbs every later event, the frame whitelist with unknown frames ignored (no cost
 * frame can ever reach the UI: the event union has no cost variant), and caption fragments merged
 * by role.
 *
 * Protocol v2.5 (S5 7.3-7.5, S6 6.2; D7, D-016): voice is display-only and unscored.
 *   - The stored `exchange {exchange_no, question, answer, partial}` frame is the transcript: the
 *     only place a question is paired with its answer, with either text null after the server's
 *     grace. Live captions (`transcription`) are display-only, kept in arrival order and never
 *     paired; an `exchange` frame replaces them. Voice creates no turns, cards or acknowledgements.
 *   - There is no `ended` frame and no `turn_committed` frame: the WebSocket close code alone ends
 *     the session (SG4-32).
 *   - There is no session resumption. Every close is terminal: a known code ends with its own key,
 *     and any other code (a transport drop: 1006, 1011; the withdrawn 4429 and 4503) ends with the
 *     key `transport`, for which the bar offers "Reconnect". That starts a NEW ticketed session
 *     (`reconnectState`), carrying nothing but the stored transcript.
 *   - Close 4410 (exchange cap) enters `draining`: capture stops, the already-received audio plays
 *     to its end and `ended` follows the audio layer's drained report (`playback` null; the hook
 *     sends it at once when nothing is queued), SG4-28. Every other close, and an `interrupted`
 *     frame, flushes at once.
 *   - "The investigator's turn ended" comes from capture edges (`investigator_audio` and
 *     `investigator_silence`, or push-to-talk press and release), never from captions: transcription
 *     is not ordered against audio or turns (SG3-40), so captions change no activity.
 *   - `status` is derived after every event from the connection, the server's activity, the talk
 *     control and actual playback (UI direction 3). Playback reports name the utterance being played,
 *     so a report posted before the worklet flushed an interrupted utterance is recognised as stale.
 *     Playback progress stays in the browser and nothing about it is sent to the server (D7); the
 *     only controls the browser can send are `stop` and `interrupt` (`VoiceControl`).
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
  | "draining"
  | "ended";

/** OD-6 voice branch: open microphone or push-to-talk. Fixed for a session. */
export type VoiceMode = "live" | "push_to_talk";

/** The socket's lifecycle, as the machine knows it. */
export type VoiceConnection = "idle" | "consent" | "connecting" | "open" | "draining" | "ended";

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
  | "transport"
  | "error";

export type CaptionRole = "investigator" | "subject";

/** One live caption line: a speaker's fragments up to their final (`done`). Display only, unpaired. */
export interface CaptionLine {
  readonly role: CaptionRole;
  readonly text: string;
  readonly done: boolean;
}

/** One stored exchange (S5 7.4): the transcript entry `V{exchangeNo}`. Either text may be null. */
export interface ExchangeEntry {
  readonly exchangeNo: number;
  readonly question: string | null;
  readonly answer: string | null;
  /** The subject's utterance was interrupted: its text can include words never heard. */
  readonly partial: boolean;
}

/** The machine's full state. Never carries cost. */
export interface VoiceState {
  /** Derived from the facts below after every event. */
  readonly status: VoiceStateName;
  readonly mode: VoiceMode;
  readonly connection: VoiceConnection;
  /** The push-to-talk control is held. */
  readonly talkHeld: boolean;
  /** The subject utterance the server has open, or null. */
  readonly openUtterance: number | null;
  /** The highest utterance number seen this session (stale-frame guard). */
  readonly lastUtterance: number | null;
  /** The investigator is audibly speaking (capture edges), from `investigator_audio` to `investigator_silence`. */
  readonly investigatorActive: boolean;
  /** An utterance started during the investigator's current capture interval: its end is not a new wait. */
  readonly turnAnswered: boolean;
  /**
   * The utterance that began during the capture interval that has since ended, or null. If it is
   * interrupted later (the server's frame can trail the local silence edge), that interval's question
   * is still unanswered.
   */
  readonly coveredUtterance: number | null;
  /** The investigator's turn ended (capture fell silent) and no utterance has started since. */
  readonly awaitingAnswer: boolean;
  /** The utterance whose audio is audible now, as the audio layer reports it, or null. */
  readonly audible: number | null;
  /** The last interrupted utterance: its audio, and any older, was flushed and cannot play again. */
  readonly interruptedUtterance: number | null;
  /** Live captions in arrival order, replaced by the next `exchange` frame. */
  readonly captions: readonly CaptionLine[];
  /** Stored exchanges by number, the authoritative transcript. */
  readonly transcript: readonly ExchangeEntry[];
  readonly exchangeCount: { readonly used: number; readonly cap: number } | null;
  /** Seconds left from the latest `timer_tick` or `warning`, or null before the first. */
  readonly timeRemaining: number | null;
  /** The 60 s audio-cap warning arrived (S6 6.2: "Voice ends in 60 s; you can then commit in text"). */
  readonly endingSoon: boolean;
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
  /** The socket closed with `code`; the code alone says why (S5 7.5). */
  | { readonly type: "socket_closed"; readonly code: number }
  /** The client ended the session (hang-up, a failed ticket mint). */
  | { readonly type: "ended"; readonly key: VoiceEndKey }
  | { readonly type: "talk_start" }
  | { readonly type: "talk_end" }
  /**
   * Capture edges, sent by the hook in live mode (push-to-talk maps `talk_start` and `talk_end` to
   * them): the capture tap rose above the silence floor, or fell below it after a hangover. They,
   * not the captions, say when the investigator's turn ended: transcription is not ordered against
   * the model's turns (S5 7.3, SG3-40), so no caption can say whether a question is still pending.
   */
  | { readonly type: "investigator_audio" }
  | { readonly type: "investigator_silence" }
  /** The audio layer is playing `utterance`'s audio, or nothing (drained, an underrun, flushed). */
  | { readonly type: "playback"; readonly utterance: number | null }
  | { readonly type: "utterance_start"; readonly utterance: number }
  | { readonly type: "utterance_end"; readonly utterance: number }
  | { readonly type: "interrupted"; readonly utterance: number }
  | { readonly type: "transcription"; readonly role: CaptionRole; readonly text: string; readonly partial: boolean }
  | ({ readonly type: "exchange" } & ExchangeEntry)
  | { readonly type: "exchange_count"; readonly used: number; readonly cap: number }
  | { readonly type: "timer_tick"; readonly timeRemaining: number }
  | { readonly type: "warning"; readonly reason: "ending_soon"; readonly seconds: number | null };

/** S5 7.3: a transcription frame's text is at most 500 characters (code points). */
export const MAX_CAPTION_CHARS = 500;

/** The newest caption lines kept; `exchange` frames clear them long before this. */
export const MAX_CAPTION_LINES = 20;

/** S5 7.4: stored question and answer are cut to 600 and 900 characters. */
export const MAX_QUESTION_CHARS = 600;
export const MAX_ANSWER_CHARS = 900;

/** S5 7.3: `exchange_count.cap` is always 12 (BKO-8). */
export const EXCHANGE_CAP = 12;

/** The state before the voice control is used; `transcript` is the trial's stored exchanges. */
export function initialVoiceState(mode: VoiceMode, transcript: readonly ExchangeEntry[] = []): VoiceState {
  return {
    status: "idle",
    mode,
    connection: "idle",
    talkHeld: false,
    openUtterance: null,
    lastUtterance: null,
    investigatorActive: false,
    turnAnswered: false,
    coveredUtterance: null,
    awaitingAnswer: false,
    audible: null,
    interruptedUtterance: null,
    captions: [],
    transcript,
    exchangeCount: null,
    timeRemaining: null,
    endingSoon: false,
    endedKey: null,
  };
}

/**
 * Map a close code to the key its session ends with (S5 7.5). Every close is terminal. Codes outside
 * the table (1006, 1011, and the withdrawn 4429 and 4503) are transport drops: `transport`.
 */
export function closeCodeToEnded(code: number): VoiceEndKey {
  switch (code) {
    case 1000:
      return "normal";
    case 4400:
      return "protocol";
    case 4401:
    case 4403:
    case 4404:
      return "unavailable";
    case 4408:
      return "idle";
    case 4409:
      return "subject_guard";
    case 4410:
      return "exchange_cap";
    case 4413:
      return "cost_cap";
    case 4423:
      return "paused";
    default:
      return "transport";
  }
}

/** The bar offers "Reconnect" after a transport drop; it starts a new voice session. */
export function reconnectOffered(state: VoiceState): boolean {
  return state.status === "ended" && state.endedKey === "transport";
}

/**
 * The state of the new session a reconnect opens (S5 7.2 step 4: no resume credential). Utterance
 * numbering, captions, playback, timers and the exchange count restart; only the stored transcript
 * carries over, because it belongs to the trial.
 */
export function reconnectState(previous: VoiceState): VoiceState {
  return withStatus({ ...initialVoiceState(previous.mode, previous.transcript), connection: "connecting" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fits(value: unknown, max: number): value is string {
  return typeof value === "string" && Array.from(value).length <= max;
}

function nullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return fits(value, max) ? value : undefined;
}

/**
 * Map one decoded server frame to a machine event, or null for a frame the machine ignores: every
 * unknown type (including the withdrawn `ended`, `turn_committed`, `resume`), and any frame whose
 * fields do not match S5 7.3.
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
      if (!fits(text, MAX_CAPTION_CHARS) || typeof partial !== "boolean") return null;
      return { type, role, text, partial };
    }
    case "exchange": {
      const { exchange_no: exchangeNo, partial } = frame;
      const question = nullableText(frame["question"], MAX_QUESTION_CHARS);
      const answer = nullableText(frame["answer"], MAX_ANSWER_CHARS);
      if (!isCount(exchangeNo) || exchangeNo < 1 || exchangeNo > EXCHANGE_CAP) return null;
      if (question === undefined || answer === undefined || typeof partial !== "boolean") return null;
      return { type, exchangeNo, question, answer, partial };
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
      if (reason !== "ending_soon") return null;
      if (seconds === undefined) return { type, reason, seconds: null };
      return isCount(seconds) ? { type, reason, seconds } : null;
    }
    default:
      // `ended`, `turn_committed`, `resume`, any unknown or cost-shaped type: ignored.
      return null;
  }
}

/**
 * Add one fragment to its speaker's open line, wherever it sits in the log (transcription of the two
 * speakers is independent, so lines are never paired or reordered): it extends that speaker's open
 * line, or starts a new one. An empty final only closes the open line. The newest MAX_CAPTION_CHARS
 * code points of a line and the newest MAX_CAPTION_LINES lines are kept.
 */
function addFragment(captions: readonly CaptionLine[], role: CaptionRole, text: string, partial: boolean): readonly CaptionLine[] {
  const index = captions.findLastIndex((line) => line.role === role && !line.done);
  const open = captions[index] ?? null;
  if (text === "") {
    if (open === null) return captions;
    return captions.map((line, i) => (i === index ? { ...line, done: !partial } : line));
  }
  const merged = Array.from((open?.text ?? "") + text).slice(-MAX_CAPTION_CHARS).join("");
  const line: CaptionLine = { role, text: merged, done: !partial };
  const next = open === null ? [...captions, line] : captions.map((l, i) => (i === index ? line : l));
  return next.slice(-MAX_CAPTION_LINES);
}

function upsertExchange(transcript: readonly ExchangeEntry[], entry: ExchangeEntry): readonly ExchangeEntry[] {
  return [...transcript.filter((e) => e.exchangeNo !== entry.exchangeNo), entry].sort((a, b) => a.exchangeNo - b.exchangeNo);
}

type Facts = Omit<VoiceState, "status">;

function deriveStatus(s: Facts): VoiceStateName {
  switch (s.connection) {
    case "idle":
    case "consent":
    case "connecting":
    case "draining":
    case "ended":
      return s.connection;
    case "open":
      if (s.audible !== null) return "speaking";
      if (s.mode === "push_to_talk" && s.talkHeld) return "recording";
      if (s.awaitingAnswer || s.openUtterance !== null) return "thinking";
      return "listening";
  }
}

/** Recompute the derived status from the facts. */
function withStatus(next: Facts): VoiceState {
  return { ...next, status: deriveStatus(next) };
}

function endSession(state: VoiceState, key: VoiceEndKey): VoiceState {
  return withStatus({
    ...state,
    connection: "ended",
    openUtterance: null,
    investigatorActive: false,
    turnAnswered: false,
    coveredUtterance: null,
    awaitingAnswer: false,
    talkHeld: false,
    audible: null,
    captions: [],
    endingSoon: false,
    endedKey: key,
  });
}

function onClose(state: VoiceState, code: number): VoiceState {
  const key = closeCodeToEnded(code);
  // The exchange cap is the one close that lets audio finish: capture stops and the received audio
  // plays. The machine cannot see the audio queue (a playback-start report can still be in flight),
  // so it always waits for the audio layer's drained report (`playback` null). The hook owns that
  // report's correctness: it sends it only when every sample it queued has played (the worklet's
  // played count equals its queued count), at once when nothing is queued, and never a stale one.
  if (code === 4410 && state.connection === "open") {
    return withStatus({ ...state, connection: "draining", talkHeld: false, openUtterance: null, investigatorActive: false, turnAnswered: false, coveredUtterance: null, awaitingAnswer: false });
  }
  return endSession(state, key);
}

/** The investigator's turn ended: the subject is now to answer, until an utterance starts. */
function endTurn(state: VoiceState): VoiceState {
  // A turn the subject already began answering (voice activity detection can cut in while the
  // investigator is still holding the control) opens no new wait.
  return withStatus({
    ...state,
    investigatorActive: false,
    turnAnswered: false,
    coveredUtterance: state.turnAnswered ? state.lastUtterance : state.coveredUtterance,
    awaitingAnswer: !state.turnAnswered,
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
      | "exchange"
      | "exchange_count"
      | "timer_tick"
      | "warning";
  }
>;

function onServerFrame(state: VoiceState, event: ServerEvent): VoiceState {
  switch (event.type) {
    case "utterance_start":
      if (state.lastUtterance !== null && event.utterance <= state.lastUtterance) return state;
      return withStatus({ ...state, openUtterance: event.utterance, lastUtterance: event.utterance, awaitingAnswer: false, turnAnswered: state.investigatorActive, coveredUtterance: null });
    case "utterance_end":
      if (event.utterance !== state.openUtterance) return state;
      return withStatus({ ...state, openUtterance: null });
    case "interrupted":
      // Barge-in: the server flushed its audio and the hook flushes the playback queue, so nothing
      // queued up to this utterance can play again.
      if (event.utterance !== state.lastUtterance) return state;
      // Barge-in: input after the utterance began is a new question, so the interrupted answer no longer
      // covers it, whether the investigator is still speaking or the silence edge arrived first.
      return withStatus({
        ...state,
        openUtterance: null,
        audible: null,
        interruptedUtterance: event.utterance,
        turnAnswered: false,
        awaitingAnswer: state.awaitingAnswer || event.utterance === state.coveredUtterance,
        coveredUtterance: null,
      });
    case "transcription":
      // Captions are display only and change no activity: they arrive unordered against audio and turns.
      return withStatus({ ...state, captions: addFragment(state.captions, event.role, event.text, event.partial) });
    case "exchange": {
      const entry: ExchangeEntry = { exchangeNo: event.exchangeNo, question: event.question, answer: event.answer, partial: event.partial };
      return withStatus({ ...state, transcript: upsertExchange(state.transcript, entry), captions: [] });
    }
    case "exchange_count":
      // A stale or repeated count is ignored whole.
      if (state.exchangeCount !== null && event.used <= state.exchangeCount.used) return state;
      return withStatus({ ...state, exchangeCount: { used: event.used, cap: event.cap } });
    case "timer_tick":
      return withStatus({ ...state, timeRemaining: event.timeRemaining });
    case "warning":
      return withStatus({ ...state, endingSoon: true, timeRemaining: event.seconds ?? state.timeRemaining });
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
      return state.connection === "connecting" ? withStatus({ ...state, connection: "open" }) : state;
    case "socket_closed":
      if (state.connection === "idle" || state.connection === "consent") return state;
      return onClose(state, event.code);
    case "ended":
      return endSession(state, event.key);
    case "investigator_audio":
      return state.connection === "open" && !state.investigatorActive ? withStatus({ ...state, investigatorActive: true }) : state;
    case "investigator_silence":
      return state.investigatorActive ? endTurn(state) : state;
    case "talk_start":
      if (state.connection !== "open" || state.mode !== "push_to_talk") return state;
      return withStatus({ ...state, talkHeld: true, investigatorActive: true });
    case "talk_end":
      if (!state.talkHeld) return state;
      return endTurn({ ...state, talkHeld: false });
    case "playback": {
      const { utterance } = event;
      const flushed =
        utterance !== null && state.interruptedUtterance !== null && utterance <= state.interruptedUtterance;
      // A report posted before the worklet processed a flush names audio that can no longer play.
      if (flushed) return state;
      // Draining ends when the audio layer reports its queue empty; a start report only updates audibility.
      if (state.connection === "draining" && utterance === null) return endSession(state, "exchange_cap");
      if (state.connection !== "open" && state.connection !== "draining") return state;
      return withStatus({ ...state, audible: utterance });
    }
    default:
      return state.connection === "open" ? onServerFrame(state, event) : state;
  }
}

/**
 * The utterance an inbound audio frame belongs to, or null when it must be dropped. Audio is always
 * inside an open utterance (S5 7.3), so audio arriving after `utterance_end` or `interrupted` is
 * never queued and never counted as played.
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
  | "finishing_answer"
  | "ended";

export interface VoiceBarInput {
  /** Connection, server activity and playback. */
  readonly voice: VoiceState;
  /** Microphone capture: the capture tap's level is above the silence floor this frame. */
  readonly captureAboveFloor: boolean;
}

/** The bar's state from its four inputs: connection, capture, server activity and playback. */
export function voiceBarState({ voice, captureAboveFloor }: VoiceBarInput): VoiceBarState {
  // Capture is authoritative for "You are speaking": a late caption fragment (S5 7.4) never is.
  const investigatorSpeaking = captureAboveFloor || voice.investigatorActive;
  switch (voice.status) {
    case "idle":
    case "consent":
      return "hidden";
    case "connecting":
      return "connecting";
    case "draining":
      return "finishing_answer";
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
  const micLive = voice.connection === "connecting" || voice.connection === "open";
  return micLive && captureLevel > floor ? unit(captureLevel) : 0;
}
