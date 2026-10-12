import { describe, expect, it, vi } from "vitest";

import { charAt, createGeminiEngine, PROGRESS_MS, type AudioPort, type Clip, type SpeakHooks, type SpeakItem, type Timer, type VoiceEngine } from "./gemini";

const VOICE = { gemini: "Kore", prefer: [], pitch: 1, rate: 1 };

interface FakeClip extends Clip {
  readonly text: string;
}

function setup(available: (text: string) => boolean = () => true) {
  const log: string[] = [];
  let elapsed = 0;
  const playing: { text: string; ended: () => void; stopped: boolean }[] = [];
  const fetches: string[] = [];
  const port: AudioPort<FakeClip> = {
    fetchClip: (voice, text) => {
      fetches.push(`${voice}:${text}`);
      return Promise.resolve(available(text) ? { duration: 2, text } : null);
    },
    play: (clip, volume, onended) => {
      log.push(`play ${clip.text} at ${String(volume)}`);
      const entry = { text: clip.text, ended: onended, stopped: false };
      playing.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
        },
        elapsed: () => elapsed,
      };
    },
  };
  const ticks: (() => void)[] = [];
  const timer: Timer = {
    every: (ms, fn) => {
      expect(ms).toBe(PROGRESS_MS);
      ticks.push(fn);
      return () => {
        ticks.splice(ticks.indexOf(fn), 1);
      };
    },
  };
  const fallbackSpoken: { item: SpeakItem; hooks: SpeakHooks }[] = [];
  const fallback: VoiceEngine = {
    speak: (item, hooks) => {
      fallbackSpoken.push({ item, hooks });
      hooks.onstart();
    },
    cancel: vi.fn(() => {
      for (const s of fallbackSpoken.splice(0)) s.hooks.onend();
    }),
  };
  const engine = createGeminiEngine(port, fallback, timer);
  const hooks = (name: string): SpeakHooks => ({
    onstart: () => log.push(`start ${name}`),
    onprogress: (i) => log.push(`at ${name} ${String(i)}`),
    onend: () => log.push(`end ${name}`),
  });
  const item = (text: string): SpeakItem => ({ voice: VOICE, text, volume: 1, line: null });
  return { engine, hooks, item, log, playing, ticks, fetches, fallback, fallbackSpoken, setElapsed: (s: number) => (elapsed = s) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Gemini voice engine", () => {
  it("maps the played fraction of a clip onto the text", () => {
    expect(charAt("abcdefghij", 1, 2)).toBe(5);
    expect(charAt("abcdefghij", 5, 2)).toBe(10);
    expect(charAt("abcdefghij", -1, 2)).toBe(0);
    expect(charAt("abc", 1, 0)).toBe(3);
  });

  it("fetches every queued line at once, plays them in order, and reports progress from the audio's clock", async () => {
    const t = setup();
    t.engine.speak(t.item("first"), t.hooks("A"));
    t.engine.speak(t.item("second"), t.hooks("B"));
    expect(t.fetches).toEqual(["Kore:first", "Kore:second"]);
    await flush();
    // The audio starts, then the mouth: a start that fails never reports one.
    expect(t.log).toEqual(["play first at 1", "start A"]);
    t.setElapsed(1);
    t.ticks[0]?.();
    expect(t.log.at(-1)).toBe("at A 2");
    t.playing[0]?.ended();
    await flush();
    expect(t.ticks).toHaveLength(1);
    expect(t.log.slice(2)).toEqual(["at A 2", "end A", "play second at 1", "start B"]);
  });

  it("cancel stops the line speaking and drops the queue, ending every item once", async () => {
    const t = setup();
    t.engine.speak(t.item("first"), t.hooks("A"));
    t.engine.speak(t.item("second"), t.hooks("B"));
    await flush();
    t.engine.cancel();
    expect(t.playing[0]?.stopped).toBe(true);
    expect(t.ticks).toHaveLength(0);
    expect(t.log.filter((l) => l.startsWith("end"))).toEqual(["end A", "end B"]);
    // A late end from the stopped clip changes nothing.
    t.playing[0]?.ended();
    await flush();
    expect(t.log.filter((l) => l.startsWith("end"))).toEqual(["end A", "end B"]);
    expect(t.playing).toHaveLength(1);
  });

  it("drops a line cancelled before its audio arrived", async () => {
    const t = setup();
    t.engine.speak(t.item("first"), t.hooks("A"));
    t.engine.cancel();
    await flush();
    expect(t.playing).toHaveLength(0);
    expect(t.log).toEqual(["end A"]);
  });

  it("speaks a line with the fallback when its audio cannot be had, and stops asking after that", async () => {
    const t = setup((text) => text !== "first");
    expect(t.engine.usingFallback()).toBe(false);
    t.engine.speak(t.item("first"), t.hooks("A"));
    await flush();
    expect(t.fallbackSpoken.map((s) => s.item.text)).toEqual(["first"]);
    expect(t.engine.usingFallback()).toBe(true);
    t.engine.speak(t.item("second"), t.hooks("B"));
    expect(t.fetches).toEqual(["Kore:first"]);
    // The fallback's end moves the queue on.
    t.fallbackSpoken[0]?.hooks.onend();
    await flush();
    expect(t.fallbackSpoken.map((s) => s.item.text)).toEqual(["first", "second"]);
    t.engine.cancel();
    expect(t.fallback.cancel).toHaveBeenCalled();
    expect(t.log.filter((l) => l.startsWith("end"))).toEqual(["end A", "end B"]);
  });

  it("treats a failed fetch like a missing clip", async () => {
    const t = setup();
    const engine = createGeminiEngine(
      { fetchClip: () => Promise.reject(new Error("offline")), play: () => ({ stop: () => undefined, elapsed: () => 0 }) },
      { speak: (_i, h) => { h.onstart(); }, cancel: () => undefined },
    );
    const started = vi.fn();
    engine.speak(t.item("x"), { onstart: started, onprogress: () => undefined, onend: () => undefined });
    await flush();
    expect(started).toHaveBeenCalled();
    expect(engine.usingFallback()).toBe(true);
  });

  it("reports progress on the window's own interval by default, and stops it when the clip ends", async () => {
    vi.useFakeTimers();
    try {
      let ended: () => void = () => undefined;
      const progress: number[] = [];
      const engine = createGeminiEngine(
        {
          fetchClip: () => Promise.resolve({ duration: 1 }),
          play: (_c, _v, onended) => {
            ended = onended;
            return { stop: () => undefined, elapsed: () => 0.5 };
          },
        },
        { speak: () => undefined, cancel: () => undefined },
      );
      engine.speak({ voice: VOICE, text: "abcd", volume: 1, line: null }, { onstart: () => undefined, onprogress: (i) => progress.push(i), onend: () => undefined });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
      expect(progress).toEqual([2, 2]);
      ended();
      await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
      expect(progress).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks a line with the fallback when its audio will not start, and every line after", async () => {
    const spoken: string[] = [];
    const engine = createGeminiEngine(
      {
        fetchClip: () => Promise.resolve({ duration: 1 }),
        play: () => {
          throw new Error("NotAllowedError");
        },
      },
      {
        speak: (item, hooks) => {
          spoken.push(item.text);
          hooks.onend();
        },
        cancel: () => undefined,
      },
    );
    const ends: string[] = [];
    engine.speak({ voice: VOICE, text: "one", volume: 1, line: null }, { onstart: () => undefined, onprogress: () => undefined, onend: () => ends.push("one") });
    engine.speak({ voice: VOICE, text: "two", volume: 1, line: null }, { onstart: () => undefined, onprogress: () => undefined, onend: () => ends.push("two") });
    await flush();
    await flush();
    expect(spoken).toEqual(["one", "two"]);
    expect(ends).toEqual(["one", "two"]);
    expect(engine.usingFallback()).toBe(true);
  });
});
