// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useEffect, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioMouth } from "../../lib/world/audioLips";
import { roomEngine, webAudioPort } from "./voiceEngines";

const response = () => ({ audio: new ArrayBuffer(8), silent: false });
const item = { voice: { gemini: "subject:Jordan Pell", prefer: [], pitch: 1, rate: 1 }, text: "Original synthetic test line.", volume: 1, line: null };
const hooks = () => ({ onstart: vi.fn(), onprogress: vi.fn(), onend: vi.fn() });
function deferred<T>() { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
class Context {
  state = "suspended";
  currentTime = 0;
  sampleRate = 24_000;
  resume = vi.fn(() => { this.state = "running"; return Promise.resolve(); });
  close = vi.fn(() => { this.state = "closed"; return Promise.resolve(); });
  decodeAudioData = vi.fn((): Promise<AudioBuffer> => Promise.resolve({ duration: 1 } as AudioBuffer));
  destination = {};
  nodes: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  source = { buffer: null as AudioBuffer | null, start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null, connect: vi.fn((value: unknown) => value), disconnect: vi.fn() };
  createBufferSource = () => { this.nodes.push(this.source); return this.source; };
  createGain = () => { const node = { gain: { value: 1 }, connect: vi.fn((value: unknown) => value), disconnect: vi.fn() }; this.nodes.push(node); return node; };
  createAnalyser = () => { const node = { context: this, fftSize: 512, smoothingTimeConstant: 0.5, getByteFrequencyData: (into: Uint8Array) => into.fill(200), disconnect: vi.fn() }; this.nodes.push(node); return node; };
}
const contexts: Context[] = [], releases: (() => void)[] = [];
const fallback = vi.fn();
beforeEach(() => {
  contexts.length = 0; fallback.mockReset();
  vi.stubGlobal("AudioContext", vi.fn(function makeContext() { const context = new Context(); contexts.push(context); return context; }));
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak: fallback, cancel: vi.fn(), getVoices: () => [] } });
});
afterEach(() => { cleanup(); for (const release of releases.splice(0)) release(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function activate(owner: { activate: () => () => void }) { const release = owner.activate(); releases.push(release); return release; }

describe("committed room audio lifecycle", () => {
  it("constructs no context/listener and never fetches or speaks before activation", async () => {
    const add = vi.spyOn(window, "addEventListener"), api = { speak: vi.fn(() => Promise.resolve(response())) };
    const port = webAudioPort(api), engine = roomEngine(api), events = hooks();
    window.dispatchEvent(new Event("pointerdown")); window.dispatchEvent(new Event("keydown"));
    expect(contexts).toHaveLength(0); expect(add).not.toHaveBeenCalled();
    expect(await port.fetchClip("subject:Jordan Pell", "test")).toBeNull(); engine.speak(item, events);
    expect(api.speak).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expect(events.onend).toHaveBeenCalledOnce();
  });

  it.each(["pointerdown", "keydown"])("StrictMode setup/cleanup/re-setup owns one %s unlock and removes both listeners", (event) => {
    const api = { speak: vi.fn(() => Promise.resolve(response())) };
    const { unmount } = renderHook(() => { const engine = useMemo(() => roomEngine(api), []); useEffect(() => engine.activate(), [engine]); return engine; }, { wrapper: StrictMode });
    expect(contexts).toHaveLength(0);
    act(() => { window.dispatchEvent(new Event(event)); window.dispatchEvent(new Event(event === "keydown" ? "pointerdown" : "keydown")); });
    expect(contexts).toHaveLength(1); expect(contexts[0]?.resume).toHaveBeenCalledOnce();
    unmount(); expect(contexts[0]?.close).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pointerdown")); window.dispatchEvent(new Event("keydown")); expect(contexts).toHaveLength(1);
  });

  it("removes both unconsumed unlock listeners and ignores duplicate/obsolete cleanup", () => {
    const port = webAudioPort({ speak: () => Promise.resolve(response()) });
    const first = activate(port); expect(() => port.activate()).toThrow("already has"); first(); first();
    window.dispatchEvent(new Event("pointerdown")); window.dispatchEvent(new Event("keydown")); expect(contexts).toHaveLength(0);
    const second = activate(port); first();
    window.dispatchEvent(new Event("keydown")); expect(contexts).toHaveLength(1);
    second(); second(); expect(contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it("drops late fetches from a disposed activation even after reactivation", async () => {
    const pending = deferred<ReturnType<typeof response>>(), api = { speak: vi.fn(() => pending.promise) };
    const port = webAudioPort(api), first = activate(port);
    const clip = port.fetchClip("subject:Jordan Pell", "test"); first(); activate(port);
    pending.resolve(response()); expect(await clip).toBeNull(); expect(contexts).toHaveLength(0);
    expect(await port.fetchClip("subject:Jordan Pell", "test")).not.toBeNull(); expect(api.speak).toHaveBeenCalledTimes(2);
  });

  it("drops a decode that completes after disposal and cannot restart its closed context", async () => {
    const port = webAudioPort({ speak: () => Promise.resolve(response()) }), release = activate(port);
    window.dispatchEvent(new Event("pointerdown")); const context = contexts[0]; if (context === undefined) throw new Error("Missing context");
    const decode = deferred<AudioBuffer>(); context.decodeAudioData.mockImplementation(() => decode.promise);
    const clip = port.fetchClip("subject:Jordan Pell", "test"); await Promise.resolve(); expect(context.decodeAudioData).toHaveBeenCalledOnce();
    release(); activate(port); decode.resolve({ duration: 1 } as AudioBuffer);
    expect(await clip).toBeNull(); expect(context.resume).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });

  it("cancels pending engine hooks without fallback or a late context", async () => {
    const pending = deferred<ReturnType<typeof response>>(), engine = roomEngine({ speak: () => pending.promise }), events = hooks();
    const release = activate(engine); engine.speak(item, events); release(); release(); pending.resolve(response());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(events.onend).toHaveBeenCalledOnce(); expect(events.onstart).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); expect(contexts).toHaveLength(0);
  });

  it("stops actual playing sources, detaches mouth/nodes and refuses stale cached clips", async () => {
    const port = webAudioPort({ speak: () => Promise.resolve(response()) }), release = activate(port);
    const clip = await port.fetchClip("subject:Jordan Pell", "test"); if (clip === null) throw new Error("Missing clip");
    const onended = vi.fn(), playing = port.play(clip, 1, onended), context = contexts[0];
    expect(audioMouth.active("subject:Jordan Pell")).toBe(true);
    release(); release(); playing.stop();
    expect(context?.source.stop).toHaveBeenCalledOnce(); expect(context?.close).toHaveBeenCalledOnce();
    expect(context?.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(audioMouth.active("subject:Jordan Pell")).toBe(false); expect(onended).not.toHaveBeenCalled();
    activate(port); expect(() => port.play(clip, 1, onended)).toThrow("inactive owner");
  });
});
