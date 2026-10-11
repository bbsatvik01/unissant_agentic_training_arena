/**
 * The lip-sync clock for spoken lines (stage 2): when a line is voiced, its mouth follows the voice, not the text
 * cadence alone. The voice reports where it is (its start, then each word boundary, then its end) on the session
 * clock; `elapsedFor` maps the last report onto the line's viseme timeline (`timeAtChar`) and runs on from it, so a
 * late start or a slower voice moves the mouth with it, and the mouth closes when the voice ends. A line with no
 * report (sound off, or a voice that sends no boundaries before it starts) keeps the text cadence. Any source that
 * reports positions (Gemini TTS or Live, WP-22) drives it the same way.
 */
import { speechDurationMs } from "../world/cadence";
import { timeAtChar } from "../world/visemes";

export interface SpokenLine {
  readonly turn: number;
  readonly text: string;
  readonly startedAt: number;
}

interface Report {
  readonly charIndex: number;
  readonly atMs: number;
  readonly ended: boolean;
}

export interface SpeechSync {
  /** The voice reached `charIndex` of the line at `atMs` on the session clock (0 at its start). */
  readonly at: (line: SpokenLine, charIndex: number, atMs: number) => void;
  /** The voice finished (or was cancelled). */
  readonly end: (line: SpokenLine, atMs: number) => void;
  /** Forget every report (a new session, a rewind). */
  readonly clear: () => void;
  /** How far into the line's viseme timeline the mouth is at `nowMs`. */
  readonly elapsedFor: (line: SpokenLine, nowMs: number) => number;
}

export function lineKey(line: SpokenLine): string {
  return `${String(line.turn)}:${String(line.startedAt)}:${String(line.text.length)}`;
}

export function createSpeechSync(): SpeechSync {
  const reports = new Map<string, Report>();
  return {
    at: (line, charIndex, atMs) => {
      const prev = reports.get(lineKey(line));
      if (prev?.ended === true) return;
      reports.set(lineKey(line), { charIndex, atMs, ended: false });
    },
    end: (line, atMs) => {
      reports.set(lineKey(line), { charIndex: line.text.length, atMs, ended: true });
    },
    clear: () => {
      reports.clear();
    },
    elapsedFor: (line, nowMs) => {
      const r = reports.get(lineKey(line));
      if (r === undefined) return nowMs - line.startedAt;
      const duration = speechDurationMs(line.text);
      if (r.ended) return duration;
      // Run on from the last report, never past the line's end while the voice is still going.
      return Math.min(duration - 1, timeAtChar(line.text, r.charIndex) + (nowMs - r.atMs));
    },
  };
}

/** The room's one sync: the voice hook writes it, the avatars read it each frame. */
export const speechSync = createSpeechSync();
