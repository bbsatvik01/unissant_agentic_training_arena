/**
 * The room's voice engines (stage 5). An engine speaks one item at a time, in order, and tells the caller when the
 * item starts, how far it has got (a character index into its text) and when it ends, which is what the lip-sync
 * clock (`speechSync`) and the coach-queue rules in `useVoice` need. Two engines share that shape: the browser's
 * speech synthesis, and Gemini TTS, defined here.
 *
 * The Gemini engine fetches each item's audio as soon as it is queued (so the next line is ready when the current
 * one ends), plays the items in order, and reports progress from the audio's own clock: the character index is the
 * played fraction of the clip times the text's length. An item whose audio cannot be had (the server is away, the
 * speech route refused it, or the server's fake mode answered with silence) is spoken by the fallback engine, and
 * so is every item after the first such failure: one failure is enough to stop asking.
 */
import type { SpokenLine } from "./speechSync";

/** A persona's voice: its prebuilt Gemini voice, and the browser voices, pitch and rate the fallback uses. */
export interface ItemVoice {
  readonly gemini: string;
  readonly prefer: readonly string[];
  readonly pitch: number;
  readonly rate: number;
}

export interface SpeakItem {
  readonly voice: ItemVoice;
  readonly text: string;
  readonly volume: number;
  readonly line: SpokenLine | null;
}

export interface SpeakHooks {
  readonly onstart: () => void;
  readonly onprogress: (charIndex: number) => void;
  readonly onend: () => void;
}

export interface VoiceEngine {
  readonly speak: (item: SpeakItem, hooks: SpeakHooks) => void;
  /** Stop the item speaking and drop the queue; every dropped item's `onend` runs. */
  readonly cancel: () => void;
}

export interface Clip {
  /** Seconds. */
  readonly duration: number;
}

export interface Playing {
  readonly stop: () => void;
  /** Seconds played so far. */
  readonly elapsed: () => number;
}

/** Where the Gemini engine gets and plays audio: the speech route and Web Audio in the browser, fakes in tests. */
export interface AudioPort<C extends Clip> {
  /** The item's clip, or null when it cannot be had (the item is then spoken by the fallback). */
  readonly fetchClip: (voice: string, text: string) => Promise<C | null>;
  readonly play: (clip: C, volume: number, onended: () => void) => Playing;
}

export interface Timer {
  readonly every: (ms: number, fn: () => void) => () => void;
}

const windowTimer: Timer = {
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => {
      clearInterval(id);
    };
  },
};

/** How often a playing clip reports its progress to the lip-sync clock. */
export const PROGRESS_MS = 100;

interface Queued<C extends Clip> {
  readonly item: SpeakItem;
  readonly hooks: SpeakHooks;
  readonly clip: Promise<C | null>;
}

/** The character the voice has reached: the played fraction of the clip times the text's length. */
export function charAt(text: string, elapsed: number, duration: number): number {
  if (duration <= 0) return text.length;
  return Math.min(text.length, Math.max(0, Math.floor((elapsed / duration) * text.length)));
}

export function createGeminiEngine<C extends Clip>(port: AudioPort<C>, fallback: VoiceEngine, timer: Timer = windowTimer): VoiceEngine & { readonly usingFallback: () => boolean } {
  const queue: Queued<C>[] = [];
  let current: { readonly entry: Queued<C>; stop: () => void } | null = null;
  let epoch = 0;
  let failed = false;

  const finish = (entry: Queued<C>) => {
    if (current?.entry !== entry) return;
    current = null;
    entry.hooks.onend();
    pump();
  };

  const pump = (): void => {
    if (current !== null) return;
    const entry = queue.shift();
    if (entry === undefined) return;
    const mine = epoch;
    current = { entry, stop: () => undefined };
    // The clip never rejects: `speak` turns a failed fetch into null.
    void entry.clip.then(
      (clip) => {
        if (mine !== epoch) return;
        if (clip === null) {
          failed = true;
          // Still this item's turn (a cancel would have changed the epoch): the fallback speaks it.
          if (current !== null) current.stop = fallback.cancel;
          fallback.speak(entry.item, { ...entry.hooks, onend: () => { finish(entry); } });
          return;
        }
        let stopTimer: () => void = () => undefined;
        let playing: Playing;
        try {
          playing = port.play(clip, entry.item.volume, () => {
            stopTimer();
            finish(entry);
          });
        } catch {
          // The audio would not start: the fallback speaks this line and every later one.
          failed = true;
          if (current !== null) current.stop = fallback.cancel;
          fallback.speak(entry.item, { ...entry.hooks, onend: () => { finish(entry); } });
          return;
        }
        entry.hooks.onstart();
        stopTimer = timer.every(PROGRESS_MS, () => {
          entry.hooks.onprogress(charAt(entry.item.text, playing.elapsed(), clip.duration));
        });
        if (current !== null)
          current.stop = () => {
            stopTimer();
            playing.stop();
          };
      },
    );
  };

  return {
    speak(item, hooks) {
      const clip = failed ? Promise.resolve(null) : port.fetchClip(item.voice.gemini, item.text).catch(() => null);
      queue.push({ item, hooks, clip });
      pump();
    },
    cancel() {
      epoch += 1;
      const dropped = [...(current === null ? [] : [current.entry]), ...queue.splice(0)];
      const handle = current;
      current = null;
      handle?.stop();
      for (const entry of dropped) entry.hooks.onend();
    },
    usingFallback: () => failed,
  };
}
