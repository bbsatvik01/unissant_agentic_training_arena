/**
 * The room's bottom controls: the question composer (S6 4.3) and, for a recorded run, the playback bar (D-021:
 * play and pause, 1x / 2x / 4x, scrub). Every control is a native element, keyboard-operable.
 */
import { useEffect, useId, useState, type RefObject } from "react";

import { SPEEDS, type Speed } from "../../lib/world/recording";

export const QUESTION_MAX_CHARS = 600;

interface ComposerProps {
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  /** Null when no question can be sent; `reason` says why. */
  readonly onSend: ((text: string) => void) | null;
  readonly reason: string;
}

export function Composer({ draft, onDraft, onSend, reason }: ComposerProps) {
  const id = useId();
  const disabled = onSend === null;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim() !== "") onSend?.(draft);
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your question
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={QUESTION_MAX_CHARS}
        placeholder={disabled ? reason : "Ask your next question"}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          onDraft(e.target.value);
        }}
      />
      <span className="counter mono" aria-live="off">
        {draft.length}/{QUESTION_MAX_CHARS}
      </span>
      <button type="submit" className="btn-primary" disabled={disabled || draft.trim() === ""}>
        Send
      </button>
    </form>
  );
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

interface PlaybackBarProps {
  readonly playing: boolean;
  readonly speed: Speed;
  /** The playback clock in ms; the bar reads it a few times a second, so playback does not re-render the room. */
  readonly clock: RefObject<number>;
  readonly duration: number;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onSpeed: (speed: Speed) => void;
  readonly onSeek: (t: number) => void;
}

export function PlaybackBar({ playing, speed, clock: playClock, duration, onPlay, onPause, onSpeed, onSeek }: PlaybackBarProps) {
  const id = useId();
  const [time, setTime] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(playClock.current);
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, [playClock]);
  return (
    <div className="playback" role="group" aria-label="Playback">
      <span className="eyebrow">Recorded run</span>
      <button type="button" className="btn-primary-sm" onClick={playing ? onPause : onPlay} aria-pressed={playing}>
        {playing ? "Pause" : time >= duration && duration > 0 ? "Replay" : "Play"}
      </button>
      <div className="speeds" role="radiogroup" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={speed === s}
            className="speed"
            onClick={() => {
              onSpeed(s);
            }}
          >
            {s}x
          </button>
        ))}
      </div>
      <label htmlFor={id} className="sr-only">
        Position in the recording
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={duration}
        step={250}
        value={Math.min(time, duration)}
        aria-valuetext={`${clock(time)} of ${clock(duration)}`}
        onChange={(e) => {
          const t = Number(e.target.value);
          setTime(t);
          onSeek(t);
        }}
      />
      <span className="mono time">
        {clock(time)} / {clock(duration)}
      </span>
    </div>
  );
}
