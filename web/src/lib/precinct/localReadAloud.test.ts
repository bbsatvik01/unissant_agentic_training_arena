// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitRate } from "../voice/tts";
import { createLocalReadAloud } from "./localReadAloud";

class Utterance {
  constructor(readonly text: string) {}
  voice: unknown = null;
  pitch = 1;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
}
const local = { name: "Local English", lang: "en-GB", localService: true };
const remote = { name: "Preferred Remote", lang: "en-US", localService: false };
const speak = vi.fn<(utterance: Utterance) => void>();
const cancel = vi.fn();
const getVoices = vi.fn(() => [remote, local]);
const item = { voice: { gemini: "Kore", prefer: ["Preferred Remote"], pitch: 1.1, rate: 1 }, text: "Hello there.", volume: 0.8, line: null };
const hooks = () => ({ onstart: vi.fn(), onprogress: vi.fn(), onend: vi.fn() });

beforeEach(() => {
  speak.mockReset(); cancel.mockReset(); getVoices.mockReset(); getVoices.mockReturnValue([remote, local]);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel, getVoices } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("precinct installed-voice read-aloud", () => {
  it("does not play automatically and chooses an explicit local voice even when the preferred voice is remote", () => {
    const unavailable = vi.fn();
    const engine = createLocalReadAloud(unavailable);
    expect(engine.available()).toBe(true); expect(speak).not.toHaveBeenCalled();
    const callbacks = hooks();
    engine.speak(item, callbacks);
    const utterance = speak.mock.calls[0]?.[0];
    expect(utterance?.voice).toBe(local);
    expect(utterance?.pitch).toBe(1.1); expect(utterance?.volume).toBe(0.8);
    utterance?.onstart?.(); utterance?.onboundary?.({ charIndex: 6 }); utterance?.onerror?.(); utterance?.onend?.();
    expect(callbacks.onstart).toHaveBeenCalledTimes(1); expect(callbacks.onprogress).toHaveBeenCalledWith(6);
    expect(callbacks.onend).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
  });

  it.each([{ voices: [] }, { voices: [remote] }, { voices: [{ name: "French local", lang: "fr-FR", localService: true }] }])("fails closed for unavailable local English voices", ({ voices }) => {
    getVoices.mockReturnValue(voices);
    const unavailable = vi.fn(); const engine = createLocalReadAloud(unavailable); const callbacks = hooks();
    expect(engine.available()).toBe(false);
    engine.speak(item, callbacks);
    expect(unavailable).toHaveBeenCalledOnce(); expect(speak).not.toHaveBeenCalled();
    expect(callbacks.onstart).not.toHaveBeenCalled(); expect(callbacks.onprogress).not.toHaveBeenCalled();
    expect(callbacks.onend).toHaveBeenCalledOnce();
  });

  it("rechecks voices before speaking instead of falling back to the browser default", () => {
    const unavailable = vi.fn(); const engine = createLocalReadAloud(unavailable); const callbacks = hooks();
    expect(engine.available()).toBe(true);
    getVoices.mockReturnValue([remote]);
    engine.speak(item, callbacks);
    expect(unavailable).toHaveBeenCalledOnce(); expect(speak).not.toHaveBeenCalled(); expect(callbacks.onend).toHaveBeenCalledOnce();
  });

  it("keeps the existing fitted rate for a timed line without inventing an audio analyser", () => {
    const engine = createLocalReadAloud(vi.fn());
    const text = "A longer answer. ".repeat(30);
    engine.speak({ ...item, text, line: { turn: 1, text, startedAt: 0 } }, hooks());
    expect(speak.mock.calls[0]?.[0].rate).toBe(fitRate(text, item.voice.rate));
  });

  it("refuses unsupported synthesis and never constructs a replacement audio engine", () => {
    Reflect.deleteProperty(window, "speechSynthesis");
    const unavailable = vi.fn(); const engine = createLocalReadAloud(unavailable); const callbacks = hooks();
    expect(engine.available()).toBe(false); engine.speak(item, callbacks); engine.cancel();
    expect(unavailable).toHaveBeenCalledOnce(); expect(speak).not.toHaveBeenCalled(); expect(callbacks.onend).toHaveBeenCalledOnce();
  });

  it("also stays silent when the utterance API or window is absent", () => {
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    expect(createLocalReadAloud(vi.fn()).available()).toBe(false);
    vi.stubGlobal("window", undefined);
    expect(createLocalReadAloud(vi.fn()).available()).toBe(false);
    expect(speak).not.toHaveBeenCalled();
  });

  it("settles each canceled item once and ignores stale start and progress callbacks", () => {
    const engine = createLocalReadAloud(vi.fn()); const callbacks = hooks();
    engine.speak(item, callbacks);
    const utterance = speak.mock.calls[0]?.[0];
    engine.cancel(); engine.cancel();
    utterance?.onstart?.(); utterance?.onboundary?.({ charIndex: 6 }); utterance?.onend?.();
    expect(cancel).toHaveBeenCalledTimes(2); expect(callbacks.onend).toHaveBeenCalledOnce();
    expect(callbacks.onstart).not.toHaveBeenCalled(); expect(callbacks.onprogress).not.toHaveBeenCalled();
  });
});
