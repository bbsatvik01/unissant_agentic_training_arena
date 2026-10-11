/**
 * The lip-sync clock for spoken lines (stage 2): when a line is voiced, its mouth follows the voice, not the text
 * cadence alone. The voice reports where it is on the session clock: queued (waiting behind another utterance; the
 * mouth stays closed), started, each word boundary, ended. `elapsedFor` maps the last report onto the line's viseme
 * timeline (`timeAtChar`) and runs on from it, so a late start or a slower voice moves the mouth with it, and the
 * mouth closes when the voice ends; `activeFor` tells the world a voiced line is still being spoken (or waits to
 * be), so the line stays on stage until its voice is done. A line with no report (sound off) keeps the text
 * cadence. `clear` starts a new epoch, and reports from an older epoch (a cancelled utterance's late callbacks) are
 * ignored. Any source that reports positions (Gemini TTS or Live, WP-22) drives it the same way.
 */
import { speechDurationMs } from "../world/cadence";
import { timeAtChar } from "../world/visemes";

export interface SpokenLine {
  readonly turn: number;
  readonly text: string;
  readonly startedAt: number;
}

type Report = { readonly kind: "queued"; readonly atMs: number } | { readonly kind: "speaking"; readonly charIndex: number; readonly atMs: number } | { readonly kind: "ended" };

/** A queued line whose voice has not started after this long falls back to the cadence (a voice that never came). */
export const QUEUE_GIVE_UP_MS = 20_000;

export interface SpeechSync {
  /** The current epoch; pass it back with each report. */
  readonly epoch: () => number;
  /** The line's voice is queued behind another utterance at `atMs`. */
  readonly queue: (line: SpokenLine, atMs: number, epoch: number) => void;
  /** The voice reached `charIndex` of the line at `atMs` on the session clock (0 at its start). */
  readonly at: (line: SpokenLine, charIndex: number, atMs: number, epoch: number) => void;
  /** The voice finished (or was cancelled). */
  readonly end: (line: SpokenLine, epoch: number) => void;
  /** Forget every report and start a new epoch (a new session, a rewind, sound off). */
  readonly clear: () => void;
  /** How far into the line's viseme timeline the mouth is at `nowMs`; negative while the voice waits. */
  readonly elapsedFor: (line: SpokenLine, nowMs: number) => number;
  /** True while the line's voice waits or speaks, false once it ended, null when it is not voiced (cadence). */
  readonly activeFor: (line: SpokenLine, nowMs: number) => boolean | null;
}

export function lineKey(line: SpokenLine): string {
  return `${String(line.turn)}:${String(line.startedAt)}:${String(line.text.length)}`;
}

export function createSpeechSync(): SpeechSync {
  const reports = new Map<string, Report>();
  let epoch = 0;
  const current = (line: SpokenLine, nowMs: number): Report | undefined => {
    const r = reports.get(lineKey(line));
    return r?.kind === "queued" && nowMs - r.atMs > QUEUE_GIVE_UP_MS ? undefined : r;
  };
  return {
    epoch: () => epoch,
    queue: (line, atMs, e) => {
      if (e === epoch && !reports.has(lineKey(line))) reports.set(lineKey(line), { kind: "queued", atMs });
    },
    at: (line, charIndex, atMs, e) => {
      if (e !== epoch || reports.get(lineKey(line))?.kind === "ended") return;
      reports.set(lineKey(line), { kind: "speaking", charIndex, atMs });
    },
    end: (line, e) => {
      if (e === epoch) reports.set(lineKey(line), { kind: "ended" });
    },
    clear: () => {
      reports.clear();
      epoch += 1;
    },
    elapsedFor: (line, nowMs) => {
      const r = current(line, nowMs);
      if (r === undefined) return nowMs - line.startedAt;
      if (r.kind === "queued") return -1;
      const duration = speechDurationMs(line.text);
      if (r.kind === "ended") return duration;
      // Run on from the last report, never past the line's end while the voice is still going.
      return Math.min(duration - 1, timeAtChar(line.text, r.charIndex) + (nowMs - r.atMs));
    },
    activeFor: (line, nowMs) => {
      const r = current(line, nowMs);
      return r === undefined ? null : r.kind !== "ended";
    },
  };
}

/** The room's one sync: the voice hook writes it, the world and the avatars read it each frame. */
export const speechSync = createSpeechSync();
