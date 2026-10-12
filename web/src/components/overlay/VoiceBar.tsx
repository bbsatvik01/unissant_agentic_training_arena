/**
 * The voice pill bar and its consent screen (S6 3.3, 6.2; WP-22). Docked at the bottom of the room, never a
 * full-screen takeover: the bar's words carry the state (connecting, listening, you are speaking, the subject is
 * preparing or speaking, finishing the answer, ended), live captions show each speaker's line in arrival order and
 * are never paired, and the controls are hang up, interrupt and, after a dropped connection, reconnect. The consent
 * screen comes before the microphone opens. Voice practice is not scored.
 */
import type { CSSProperties } from "react";

import {
  reconnectOffered,
  voiceBarState,
  type VoiceBarState,
  type VoiceEndKey,
  type VoiceState,
} from "../../lib/voice/voiceMachine";

interface VoiceBarProps {
  readonly state: VoiceState;
  readonly captureAboveFloor: boolean;
  readonly subjectName: string;
  readonly error: string | null;
  /** The subject's amplitude now, 0-1, for the ring (0 under reduced motion). */
  readonly talk: number;
  readonly onOpen: () => void;
  readonly onConsent: () => void;
  readonly onDecline: () => void;
  readonly onStop: () => void;
  readonly onInterrupt: () => void;
  readonly onReconnect: () => void;
}

const ENDED: Readonly<Record<VoiceEndKey, string>> = {
  normal: "Voice ended. Commit your finding in text when you are ready.",
  protocol: "Voice stopped: the connection sent something unexpected.",
  unavailable: "Voice is not available for this interview right now.",
  idle: "Voice ended after 90 seconds of silence.",
  subject_guard: "Voice stopped for a platform check. It is not counted.",
  exchange_cap: "The interview reached its 12 exchanges. Commit your finding in text.",
  cost_cap: "Voice stopped: the spend limit was reached.",
  paused: "Voice is paused by the operator.",
  transport: "The voice connection dropped.",
  error: "Voice could not start.",
};

function words(bar: VoiceBarState, subjectName: string): string {
  switch (bar) {
    case "hidden":
      return "";
    case "connecting":
      return "Connecting";
    case "listening":
      return "Listening";
    case "recording":
    case "investigator_speaking":
      return "You are speaking";
    case "preparing_answer":
      return `${subjectName} is preparing an answer`;
    case "subject_speaking":
      return `${subjectName} is speaking`;
    case "finishing_answer":
      return "Finishing the answer";
    case "ended":
      return "Voice ended";
  }
}

function seconds(s: number): string {
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceBar({ state, captureAboveFloor, subjectName, error, talk, onOpen, onConsent, onDecline, onStop, onInterrupt, onReconnect }: VoiceBarProps) {
  if (state.status === "idle") {
    return (
      <div className="voice-bar" role="group" aria-label="Voice">
        <button type="button" className="btn-primary" onClick={onOpen}>
          Start speaking
        </button>
        <span className="fine">Voice practice: not scored. Speak your questions; {subjectName} answers aloud.</span>
      </div>
    );
  }
  if (state.status === "consent") {
    return (
      <div className="voice-consent" role="dialog" aria-modal="false" aria-labelledby="voice-consent-title">
        <h3 id="voice-consent-title">Before the microphone opens</h3>
        <p>
          Your voice is sent to Google&apos;s Gemini Live service on the arena&apos;s project to play {subjectName}, a simulated subject. The words both of
          you say are transcribed and stored with this practice session for your transcript; the audio itself is not stored. Voice practice is not scored and
          has no coach. Headphones keep {subjectName} from hearing itself.
        </p>
        <div className="start-row">
          <button type="button" className="btn-primary" onClick={onConsent}>
            Allow the microphone and start
          </button>
          <button type="button" className="btn-secondary-sm" onClick={onDecline}>
            Not now
          </button>
        </div>
      </div>
    );
  }
  const bar = voiceBarState({ voice: state, captureAboveFloor });
  const ended = state.status === "ended";
  const ring = { "--arena-talk": String(talk) } as CSSProperties;
  return (
    <div className="voice-bar" data-state={bar} role="group" aria-label="Voice">
      <span className="voice-ring" style={ring} aria-hidden="true" />
      <p className="voice-status" role="status" aria-live="polite">
        {ended && state.endedKey !== null ? ENDED[state.endedKey] : words(bar, subjectName)}
        {error === null ? null : <span className="fine"> {error}</span>}
      </p>
      {!ended && state.exchangeCount !== null ? (
        <span className="mono fine">
          {state.exchangeCount.used}/{state.exchangeCount.cap} exchanges
          {state.timeRemaining === null ? "" : `, ${seconds(state.timeRemaining)} left`}
        </span>
      ) : null}
      {state.endingSoon && !ended ? <span className="fine">Voice ends in 60 s; you can then commit your finding in text.</span> : null}
      {!ended ? (
        <div className="voice-captions" aria-label="Live captions">
          {state.captions.map((c, i) => (
            <p key={`${c.role}-${String(i)}`} className={`caption-line ${c.role}`}>
              <strong>{c.role === "investigator" ? "You" : subjectName}:</strong> {c.text}
            </p>
          ))}
        </div>
      ) : null}
      <div className="start-row">
        {bar === "subject_speaking" ? (
          <button type="button" className="btn-secondary-sm" onClick={onInterrupt}>
            Interrupt
          </button>
        ) : null}
        {!ended && state.status !== "draining" ? (
          <button type="button" className="btn-secondary-sm" onClick={onStop}>
            Hang up
          </button>
        ) : null}
        {reconnectOffered(state) ? (
          <button type="button" className="btn-primary" onClick={onReconnect}>
            Reconnect
          </button>
        ) : null}
      </div>
    </div>
  );
}
