// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrophoneRefusedError, openVoiceAudio } from "./voiceAudio";

type Failure = "capture-context" | "playback-context" | "capture-module" | "playback-module" | "capture-resume" | "playback-resume" | "source" | "capture-analyser" | "capture-worklet" | "gain" | "connect" | "playback-worklet" | "playback-analyser" | null;
let failure: Failure = null;
const contexts: FakeContext[] = [];
const nodes: FakeNode[] = [];
const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
const stream = { getTracks: () => tracks };
const hooks = () => ({ onFrame: vi.fn(), onPlayback: vi.fn() });
const error = new Error("Partial setup failed");
function fail(point: Failure) { if (failure === point) throw error; }
class FakeNode {
  port = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn(), postMessage: vi.fn() };
  gain = { value: 1 };
  fftSize = 512;
  disconnect = vi.fn();
  connect = vi.fn((target: unknown) => { fail("connect"); return target; });
  constructor(readonly kind: string) { nodes.push(this); }
}
class FakeContext {
  destination = {};
  kind: "capture" | "playback";
  close = vi.fn(() => Promise.resolve());
  audioWorklet = { addModule: vi.fn(() => { return failure === `${this.kind}-module` ? Promise.reject(error) : Promise.resolve(); }) };
  resume = vi.fn(() => { return failure === `${this.kind}-resume` ? Promise.reject(error) : Promise.resolve(); });
  createMediaStreamSource = vi.fn(() => { fail("source"); return new FakeNode("source"); });
  createAnalyser = vi.fn(() => { fail(`${this.kind}-analyser`); return new FakeNode(`${this.kind}-analyser`); });
  createGain = vi.fn(() => { fail("gain"); return new FakeNode("gain"); });
  constructor(options: AudioContextOptions) {
    this.kind = options.sampleRate === 16_000 ? "capture" : "playback";
    fail(`${this.kind}-context`); contexts.push(this);
  }
}
beforeEach(() => {
  failure = null; contexts.length = 0; nodes.length = 0;
  for (const track of tracks) track.stop.mockReset();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) } });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", class extends FakeNode {
    constructor(_context: unknown, name: string) { fail(name === "arena-capture" ? "capture-worklet" : "playback-worklet"); super(name); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("openVoiceAudio resource ownership", () => {
  it.each<Exclude<Failure, null>>(["capture-context", "playback-context", "capture-module", "playback-module", "capture-resume", "playback-resume", "source", "capture-analyser", "capture-worklet", "gain", "connect", "playback-worklet", "playback-analyser"])("releases acquired tracks and every partial context on %s failure", async (point) => {
    failure = point;
    await expect(openVoiceAudio(hooks())).rejects.toBe(error);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    for (const context of contexts) expect(context.close).toHaveBeenCalledTimes(1);
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
    for (const node of nodes.filter((node) => node.kind.startsWith("arena-"))) {
      expect(node.port.onmessage).toBeNull(); expect(node.port.close).toHaveBeenCalledTimes(1);
    }
  });
  it("distinguishes denied acquisition without constructing contexts", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => Promise.reject(new Error("Permission denied"))) } });
    await expect(openVoiceAudio(hooks())).rejects.toBeInstanceOf(MicrophoneRefusedError);
    expect(contexts).toHaveLength(0);
    for (const track of tracks) expect(track.stop).not.toHaveBeenCalled();
  });
  it("stops capture independently, then closes playback exactly once and suppresses stale callbacks", async () => {
    const events = hooks(); const audio = await openVoiceAudio(events);
    const tap = nodes.find((node) => node.kind === "arena-capture");
    const player = nodes.find((node) => node.kind === "arena-playback");
    const lateCapture = tap?.port.onmessage;
    const event = new MessageEvent("message", { data: { pcm: new ArrayBuffer(2), level: 0.5 } });
    lateCapture?.(event); expect(events.onFrame).toHaveBeenCalledTimes(1);
    audio.stopCapture(); audio.stopCapture(); lateCapture?.(event);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1); expect(contexts[1]?.close).not.toHaveBeenCalled();
    audio.play(1, new Int16Array([0, 32767, -32768]).buffer);
    expect(player?.port.postMessage).toHaveBeenCalledTimes(1);
    audio.close(); audio.close(); audio.stopCapture(); audio.play(2, new ArrayBuffer(2)); audio.flush();
    expect(player?.port.postMessage).toHaveBeenCalledTimes(1); expect(audio.busy()).toBe(false);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    for (const context of contexts) expect(context.close).toHaveBeenCalledTimes(1);
  });
  it("still releases the remaining tracks and contexts when cleanup throws or rejects", async () => {
    tracks[0]?.stop.mockImplementationOnce(() => { throw new Error("Device vanished"); });
    const audio = await openVoiceAudio(hooks());
    contexts[0]?.close.mockImplementationOnce(() => { throw new Error("Already closed"); });
    contexts[1]?.close.mockRejectedValueOnce(new Error("Driver closed"));
    expect(() => { audio.close(); }).not.toThrow();
    expect(tracks[1]?.stop).toHaveBeenCalledTimes(1); expect(contexts[1]?.close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
