// @vitest-environment jsdom
/**
 * The room's voice engines (stage 5): the browser engine speaks through speech synthesis with the persona's voice
 * and reports start, boundaries and one end; the Web Audio port fetches a line once, decodes it, plays it at the
 * item's volume and stops it; the server's silence or refusal yields no clip, so the browser speaks instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audioMouth } from "../../lib/world/audioLips";
import { browserEngine, EARPIECE, isEarpiece, RESUME_WAIT_MS, roomEngine, webAudioPort } from "./voiceEngines";

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
    // "never": the browser keeps playback blocked and the promise does not settle.
    if (resumeMode === "never") return new Promise<void>(() => undefined);
    this.state = "running";
    return Promise.resolve();
  });
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 2.5 } as AudioBuffer));
  destination = {};
  sampleRate = 24_000;
  gainNode = { gain: { value: 1 }, connect: vi.fn((d: unknown) => d) };
  /** Every node made, in order, with what it connected to. */
  made: { kind: string; node: Record<string, unknown> }[] = [];
  node(kind: string, extra: Record<string, unknown> = {}) {
    const n: Record<string, unknown> = { kind, ...extra, connected: [] as unknown[] };
    n["connect"] = vi.fn((d: unknown) => {
      (n["connected"] as unknown[]).push(d);
      return d;
    });
    this.made.push({ kind, node: n });
    return n;
  }
  source = this.node("source", { buffer: null as unknown, start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null }) as unknown as {
    buffer: unknown;
    connect: (d: unknown) => unknown;
    start: () => void;
    stop: () => void;
    onended: (() => void) | null;
  };
  createBufferSource = () => this.source;
  createGain = () => this.gainNode;
  createAnalyser = () => this.node("analyser", { fftSize: 2048, smoothingTimeConstant: 0.8, context: this, getByteFrequencyData: vi.fn((into: Uint8Array) => into.fill(200)) });
  createBiquadFilter = () => this.node("biquad", { type: "", frequency: { value: 0 } });
  createStereoPanner = () => this.node("panner", { pan: { value: 0 } });
}

let lastContext: FakeContext | null = null;
let resumeMode: "ok" | "never" = "ok";

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
  resumeMode = "ok";
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

  it("drives the speaker's mouth from the playing clip, and plays the coach as a quiet earpiece aside to one side", async () => {
    const api = { speak: vi.fn(() => Promise.resolve({ audio: new ArrayBuffer(8), silent: false })) };
    const port = webAudioPort(api);
    const subject = await port.fetchClip("subject:Jordan Pell", "Hi.");
    if (subject === null) throw new Error("no clip");
    expect(audioMouth.weightsFor("subject:Jordan Pell")).toBeNull();
    const playing = port.play(subject, 1, vi.fn());
    expect(audioMouth.weightsFor("subject:Jordan Pell")?.aa ?? 0).toBeGreaterThan(0);
    expect(lastContext?.made.filter((m) => m.kind === "biquad")).toHaveLength(0);
    expect(lastContext?.gainNode.gain.value).toBe(1);
    lastContext?.source.onended?.();
    expect(audioMouth.weightsFor("subject:Jordan Pell")).toBeNull();
    playing.stop();

    const coach = await port.fetchClip("coach:follow_up", "Ask about the door.");
    if (coach === null) throw new Error("no clip");
    const aside = port.play(coach, 0.8, vi.fn());
    const kinds = lastContext?.made.map((m) => m.kind) ?? [];
    expect(kinds.filter((k) => k === "biquad")).toHaveLength(2);
    const [lo, hi] = (lastContext?.made.filter((m) => m.kind === "biquad") ?? []).map((m) => m.node as { type: string; frequency: { value: number } });
    expect([lo?.type, lo?.frequency.value, hi?.type, hi?.frequency.value]).toEqual(["highpass", EARPIECE.lowCutHz, "lowpass", EARPIECE.highCutHz]);
    const pan = lastContext?.made.find((m) => m.kind === "panner")?.node as { pan: { value: number } } | undefined;
    expect(pan?.pan.value).toBe(EARPIECE.pan);
    expect(lastContext?.gainNode.gain.value).toBeCloseTo(0.8 * EARPIECE.gain);
    expect(audioMouth.active("coach:follow_up")).toBe(true);
    aside.stop();
    expect(audioMouth.active("coach:follow_up")).toBe(false);
    expect(isEarpiece("coach:question")).toBe(true);
    expect(isEarpiece("subject:Jordan Pell")).toBe(false);
  });

  it("gives no clip when the browser keeps audio suspended past the wait, and unlocks audio on the first gesture", async () => {
    resumeMode = "never";
    vi.useFakeTimers();
    try {
      const port = webAudioPort({ speak: () => Promise.resolve({ audio: new ArrayBuffer(8), silent: false }) });
      const pending = port.fetchClip("Kore", "Hi.");
      await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    resumeMode = "ok";
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
