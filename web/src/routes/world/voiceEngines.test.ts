// @vitest-environment jsdom
/**
 * The room's voice engines (stage 5): the browser engine speaks through speech synthesis with the persona's voice
 * and reports start, boundaries and one end; the Web Audio port fetches a line once, decodes it, plays it at the
 * item's volume and stops it; the server's silence or refusal yields no clip, so the browser speaks instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserEngine, roomEngine, webAudioPort } from "./voiceEngines";

class Utterance {
  text: string;
  voice: unknown = null;
  pitch = 1;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onboundary: ((e: { charIndex: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const speak = vi.fn<(u: Utterance) => void>();
const cancel = vi.fn();
const VOICE = { gemini: "Kore", prefer: ["Daniel"], pitch: 1.1, rate: 1 };

class FakeContext {
  state = "suspended";
  currentTime = 10;
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 2.5 } as AudioBuffer));
  destination = {};
  gainNode = { gain: { value: 1 }, connect: vi.fn((d: unknown) => d) };
  source = { buffer: null as unknown, connect: vi.fn(() => this.gainNode), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
  createBufferSource = () => this.source;
  createGain = () => this.gainNode;
}

let lastContext: FakeContext | null = null;

beforeEach(() => {
  speak.mockReset();
  cancel.mockReset();
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel, getVoices: () => [{ name: "Daniel", lang: "en-GB" }] } });
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function makeContext() {
      lastContext = new FakeContext();
      return lastContext;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  lastContext = null;
});

describe("browserEngine", () => {
  it("speaks with the persona's voice and reports start, boundaries and one end", () => {
    const hooks = { onstart: vi.fn(), onprogress: vi.fn(), onend: vi.fn() };
    const engine = browserEngine();
    engine.speak({ voice: VOICE, text: "Hello there.", volume: 0.8, line: null }, hooks);
    const u = speak.mock.calls[0]?.[0];
    expect(u).toBeDefined();
    expect(u?.voice).toEqual({ name: "Daniel", lang: "en-GB" });
    expect(u?.pitch).toBe(1.1);
    expect(u?.volume).toBe(0.8);
    u?.onstart?.();
    u?.onboundary?.({ charIndex: 6 });
    u?.onerror?.();
    u?.onend?.();
    expect(hooks.onstart).toHaveBeenCalledTimes(1);
    expect(hooks.onprogress).toHaveBeenCalledWith(6);
    expect(hooks.onend).toHaveBeenCalledTimes(1);
    engine.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  it("ends at once where the browser has no speech synthesis", () => {
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    Reflect.deleteProperty(window, "speechSynthesis");
    const onend = vi.fn();
    browserEngine().speak({ voice: VOICE, text: "Hi.", volume: 1, line: null }, { onstart: vi.fn(), onprogress: vi.fn(), onend });
    expect(onend).toHaveBeenCalled();
  });
});

describe("webAudioPort", () => {
  it("fetches a line once per voice and text, decodes it, and plays and stops it at the item's volume", async () => {
    const api = { speak: vi.fn(() => Promise.resolve({ audio: new ArrayBuffer(8), silent: false })) };
    const port = webAudioPort(api);
    const first = port.fetchClip("Kore", "Hello.");
    expect(port.fetchClip("Kore", "Hello.")).toBe(first);
    const clip = await first;
    expect(api.speak).toHaveBeenCalledTimes(1);
    expect(clip?.duration).toBe(2.5);
    expect(lastContext?.resume).toHaveBeenCalled();
    if (clip === null) throw new Error("no clip");
    const ended = vi.fn();
    const playing = port.play(clip, 0.7, ended);
    expect(lastContext?.gainNode.gain.value).toBe(0.7);
    expect(lastContext?.source.start).toHaveBeenCalled();
    if (lastContext !== null) lastContext.currentTime = 11.5;
    expect(playing.elapsed()).toBeCloseTo(1.5);
    lastContext?.source.onended?.();
    expect(ended).toHaveBeenCalled();
    playing.stop();
    expect(lastContext?.source.stop).toHaveBeenCalled();
    expect(lastContext?.source.onended).toBeNull();
  });

  it("gives no clip when the browser keeps audio suspended, and unlocks audio on the first gesture", async () => {
    const port = webAudioPort({ speak: () => Promise.resolve({ audio: new ArrayBuffer(8), silent: false }) });
    const pending = port.fetchClip("Kore", "Hi.");
    // The context exists once the line is decoded; make its resume a no-op that leaves it suspended.
    await Promise.resolve();
    if (lastContext !== null) lastContext.resume = vi.fn(() => Promise.resolve());
    expect(await pending).toBeNull();
    const fresh = webAudioPort({ speak: () => Promise.resolve({ audio: new ArrayBuffer(8), silent: false }) });
    window.dispatchEvent(new Event("pointerdown"));
    expect(lastContext?.resume).toHaveBeenCalled();
    expect(await fresh.fetchClip("Kore", "Hi.")).not.toBeNull();
  });

  it("gives no clip for the server's silence or a refusal", async () => {
    const silent = webAudioPort({ speak: () => Promise.resolve({ audio: new ArrayBuffer(8), silent: true }) });
    expect(await silent.fetchClip("Kore", "Hi.")).toBeNull();
    const refused = webAudioPort({ speak: () => Promise.reject(new Error("503")) });
    expect(await refused.fetchClip("Kore", "Hi.")).toBeNull();
  });
});

describe("roomEngine", () => {
  it("is the browser's own without the server", () => {
    const engine = roomEngine(null);
    engine.speak({ voice: VOICE, text: "Hi.", volume: 1, line: null }, { onstart: vi.fn(), onprogress: vi.fn(), onend: vi.fn() });
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("falls back to the browser's voice when the server answers with silence", async () => {
    const engine = roomEngine({ speak: () => Promise.resolve({ audio: new ArrayBuffer(8), silent: true }) });
    engine.speak({ voice: VOICE, text: "Hi.", volume: 1, line: null }, { onstart: vi.fn(), onprogress: vi.fn(), onend: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
