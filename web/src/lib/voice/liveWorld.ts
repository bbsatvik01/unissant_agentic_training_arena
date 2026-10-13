/**
 * The room during a live voice session (WP-22): who is talking comes from the voice machine and the microphone, not
 * from turns (a voice session has none). `withLiveVoice` lays that over the world the trial view derived: the
 * subject speaks while its Live audio is audible and thinks while an answer is awaited, the investigator speaks while
 * the microphone is above its floor, and the camera and caption follow (`shotFor`). Captions are display only and
 * never paired (SG3-40). `CaptureEdges` turns the microphone level into the machine's capture edges with a
 * hangover, so a breath between words does not end the investigator's turn.
 */
import { EXCHANGE_CAP, type CaptionLine, type VoiceEvent, type VoiceState } from "./voiceMachine";
import { shotFor, type Speech, type WorldState } from "../world/worldState";

/** Microphone RMS above which the investigator counts as speaking. */
export const CAPTURE_FLOOR = 0.02;
/** Quiet this long ends the investigator's turn (the server's own end-of-speech is 700 ms). */
export const HANGOVER_MS = 800;
/** Speech line numbers for live voice, clear of text turns. */
const LIVE_TURN = 10_000;

export interface LiveVoiceView {
  readonly subject: "speaking" | "thinking" | null;
  readonly investigatorSpeaking: boolean;
  readonly utterance: number | null;
  readonly subjectText: string;
  readonly investigatorText: string;
}

function newest(captions: readonly CaptionLine[], role: CaptionLine["role"]): string {
  return captions.findLast((c) => c.role === role)?.text ?? "";
}

/** The room's view of the voice session now. */
export function liveVoiceView(voice: VoiceState, captureAboveFloor: boolean): LiveVoiceView {
  const open = voice.connection === "open" || voice.connection === "draining";
  const subject = !open ? null : voice.audible !== null ? "speaking" : voice.status === "thinking" ? "thinking" : null;
  return {
    subject,
    investigatorSpeaking: open && voice.connection === "open" && (captureAboveFloor || voice.investigatorActive),
    utterance: voice.audible ?? voice.openUtterance,
    subjectText: newest(voice.captions, "subject"),
    investigatorText: newest(voice.captions, "investigator"),
  };
}

function line(turn: number, text: string): Speech {
  // The mouth follows the Live audio (audioMouth), so the line's own timing never moves it.
  return { turn, text: text === "" ? "..." : text, startedAt: 0 };
}

/** The world with the live voice session's speakers, shot and caption laid over it. */
export function withLiveVoice(world: WorldState, voice: LiveVoiceView, subjectName: string): WorldState {
  if (world.status === "ended") return world;
  const subject =
    voice.subject === "speaking"
      ? { pose: "speaking" as const, speech: line(LIVE_TURN + (voice.utterance ?? 0), voice.subjectText) }
      : { pose: voice.subject === "thinking" ? ("thinking" as const) : ("listening" as const), speech: null };
  const investigator = { speech: voice.investigatorSpeaking ? line(LIVE_TURN, voice.investigatorText) : null };
  const caption =
    subject.pose === "speaking"
      ? `${subjectName} is answering.`
      : investigator.speech !== null
        ? "You are speaking."
        : subject.pose === "thinking"
          ? `${subjectName} is about to answer.`
          : `${subjectName} is listening.`;
  const next = { ...world, subject, investigator, caption };
  return { ...next, shot: shotFor(next, false) };
}

/** Capture edges from the microphone level, with a hangover before silence. */
export class CaptureEdges {
  private speaking = false;
  private quietSince: number | null = null;

  /** The edge this frame produces, if any. */
  next(level: number, nowMs: number): VoiceEvent | null {
    if (level > CAPTURE_FLOOR) {
      this.quietSince = null;
      if (this.speaking) return null;
      this.speaking = true;
      return { type: "investigator_audio" };
    }
    if (!this.speaking) return null;
    this.quietSince ??= nowMs;
    if (nowMs - this.quietSince < HANGOVER_MS) return null;
    this.speaking = false;
    this.quietSince = null;
    return { type: "investigator_silence" };
  }

  get active(): boolean {
    return this.speaking;
  }
}

/** The header's exchange count in voice: the stored count, plus the exchange whose answer is being spoken (it is
 * stored when the answer ends). */
export function voiceShownCount(state: VoiceState, fallback: number): number {
  const used = state.exchangeCount?.used ?? fallback;
  // The answer has started (its utterance is open, or its caption is up) and its window is not stored yet: the
  // `exchange` frame that stores it clears the captions, and its `exchange_count` follows, so the same exchange is
  // never counted twice; audio still playing after that is already counted.
  const started = state.openUtterance !== null || state.captions.some((c) => c.role === "subject");
  const answering = state.connection === "open" && started;
  return Math.min(EXCHANGE_CAP, used + (answering ? 1 : 0));
}
