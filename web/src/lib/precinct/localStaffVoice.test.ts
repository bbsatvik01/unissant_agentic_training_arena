// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStaffPlaybackActivity } from "./localStaffPlaybackActivity";
import { createAudioMouth } from "../world/audioLips";
import { createLocalStaffPlayer, findLocalStaffClip, LOCAL_STAFF_CLIPS, type LocalStaffClip } from "./localStaffVoice";
import { STAFF_CONVERSATIONS } from "./staffDialogue";
import { NPC_TECHNIQUE_REDIRECT } from "./npcLocalAdapter";
const clip: LocalStaffClip = { id: "test", voice_id: "local-reception-v1", text: "Original fixture.", url: "/audio/staff-v1/test.wav", sha256: "a".repeat(64), bytes: 100, duration_seconds: 2 };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class FakeContext {
  state = "running";
  sampleRate = 22050;
  destination = {};
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  decodeAudioData = vi.fn(() => Promise.resolve({ duration: 2 } as AudioBuffer));
  gain = { gain: { value: 1 }, connect: vi.fn((target: unknown) => target), disconnect: vi.fn() };
  analyser = { context: this, fftSize: 512, smoothingTimeConstant: 0, connect: vi.fn((target: unknown) => target), disconnect: vi.fn(), getByteFrequencyData: (array: Uint8Array) => array.fill(this.gain.gain.value === 0 ? 0 : 180) };
  source = { buffer: null as AudioBuffer | null, onended: null as (() => void) | null, connect: vi.fn((target: unknown) => target), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  createBufferSource = () => this.source;
  createGain = () => this.gain;
  createAnalyser = () => this.analyser;
}
type Asset = Pick<LocalStaffClip, "url" | "bytes" | "sha256">;
function setup(read = vi.fn<(asset: Asset, signal: AbortSignal) => Promise<ArrayBuffer>>(() => Promise.resolve(new ArrayBuffer(100)))) {
  const contexts: FakeContext[] = [];
  const mouth = createAudioMouth();
  const activity = createLocalStaffPlaybackActivity();
  const context = vi.fn(() => { const value = new FakeContext(); contexts.push(value); return value as unknown as AudioContext; });
  const player = createLocalStaffPlayer({ context, read, attach: mouth.attach, activity });
  return { player, read, context, contexts, mouth, activity };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });
describe("finite authored staff inventory", () => {
  it("covers all exact staff topics, introductions, no-name greetings and redirects without fuzzy matches", () => {
    for (const speaker of ["receptionist", "sergeant"] as const) {
      const voice = speaker === "receptionist" ? "local-reception-v1" : "local-sergeant-v1";
      const conversation = STAFF_CONVERSATIONS[speaker];
      for (const text of [conversation.introduction, `Welcome. ${conversation.introduction}`, `Good to see you again. ${conversation.introduction}`, NPC_TECHNIQUE_REDIRECT, ...conversation.replies.map((line) => line.text)]) {
        expect(findLocalStaffClip(voice, text)?.text).toBe(text);
      }
      expect(findLocalStaffClip(voice, `Welcome, Alex. ${conversation.introduction}`)).toBeUndefined();
      expect(findLocalStaffClip(voice, "Tell me who is guilty")).toBeUndefined();
    }
    expect(LOCAL_STAFF_CLIPS).toHaveLength(23);
  });
});
describe("local staff audio ownership", () => {
  it("does nothing before play, handles a missing exact clip without a context or request", () => {
    const s = setup(); const onStatus = vi.fn();
    expect(s.context).not.toHaveBeenCalled(); s.player.play(undefined, onStatus);
    expect(onStatus).toHaveBeenLastCalledWith("unavailable"); expect(s.read).not.toHaveBeenCalled(); expect(s.context).not.toHaveBeenCalled();
  });
  it("uses source → gain → analyser → output and real spectrum weights, then releases on end", async () => {
    const s = setup(); const onStatus = vi.fn(); const handle = s.player.play(clip, onStatus); expect(s.activity.getSnapshot()).toBe(false); await flush();
    expect(s.activity.getSnapshot()).toBe(true);
    const c = s.contexts[0]; expect(c).toBeDefined();
    expect(c?.source.connect).toHaveBeenCalledWith(c?.gain); expect(c?.gain.connect).toHaveBeenCalledWith(c?.analyser); expect(c?.analyser.connect).toHaveBeenCalledWith(c?.destination);
    expect(onStatus).toHaveBeenLastCalledWith("speaking"); expect(s.mouth.weightsFor(clip.voice_id)?.aa).toBeGreaterThan(0);
    handle.setMuted(true); expect(s.activity.getSnapshot()).toBe(false); expect(c?.gain.gain.value).toBe(0); expect(s.mouth.weightsFor(clip.voice_id)).toBeNull();
    handle.setMuted(false); expect(s.activity.getSnapshot()).toBe(true); expect(s.mouth.active(clip.voice_id)).toBe(true);
    c?.source.onended?.(); handle.stop(); expect(s.activity.getSnapshot()).toBe(false);
    expect(s.mouth.active(clip.voice_id)).toBe(false); expect(c?.close).toHaveBeenCalledTimes(1); expect(onStatus).toHaveBeenLastCalledWith("idle");
  });
  it("invalidates a pending fetch on replacement so a late first completion cannot speak or clear the new owner", async () => {
    const old = deferred<ArrayBuffer>();
    const s = setup(vi.fn<(asset: Asset, signal: AbortSignal) => Promise<ArrayBuffer>>().mockImplementationOnce(() => old.promise).mockResolvedValue(new ArrayBuffer(100)));
    const first = vi.fn(); const second = vi.fn();
    const firstHandle = s.player.play(clip, first); const firstSignal = s.read.mock.calls[0]?.[1];
    s.player.play({ ...clip, voice_id: "local-sergeant-v1" }, second); await flush();
    expect(firstSignal?.aborted).toBe(true); expect(s.contexts[0]?.close).toHaveBeenCalledTimes(1);
    old.resolve(new ArrayBuffer(100)); await flush(); firstHandle.stop();
    expect(s.contexts[0]?.source.start).not.toHaveBeenCalled(); expect(s.contexts[1]?.source.start).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith("speaking"); expect(s.mouth.active("local-sergeant-v1")).toBe(true);
    s.player.stop();
  });
  it("cancels pending decode without attaching stale mouth data", async () => {
    const s = setup(); const onStatus = vi.fn(); const decoded = deferred<AudioBuffer>();
    const handle = s.player.play(clip, onStatus); s.contexts[0]?.decodeAudioData.mockReturnValueOnce(decoded.promise); await flush();
    handle.stop(); decoded.resolve({ duration: 2 } as AudioBuffer); await flush();
    expect(s.contexts[0]?.source.start).not.toHaveBeenCalled(); expect(s.mouth.active(clip.voice_id)).toBe(false); expect(onStatus).toHaveBeenLastCalledWith("idle");
  });
  it("bounds a blocked resume and catches rejected transport without fallback speech", async () => {
    vi.useFakeTimers(); const s = setup(); const onStatus = vi.fn();
    s.context.mockImplementationOnce(() => { const c = new FakeContext(); c.resume = vi.fn(() => new Promise<void>(() => undefined)); s.contexts.push(c); return c as unknown as AudioContext; });
    s.player.play(clip, onStatus); await vi.advanceTimersByTimeAsync(10_000);
    expect(onStatus).toHaveBeenLastCalledWith("error"); expect(s.contexts[0]?.close).toHaveBeenCalledTimes(1); expect(s.contexts[0]?.source.start).not.toHaveBeenCalled();
    s.read.mockRejectedValueOnce(new Error("404")); s.player.play(clip, onStatus); await flush();
    expect(onStatus).toHaveBeenLastCalledWith("error"); expect(s.contexts[1]?.close).toHaveBeenCalledTimes(1);
  });
  it("cleans up a context when resume throws synchronously and rejects duration mismatch", async () => {
    const s = setup(); const onStatus = vi.fn();
    s.context.mockImplementationOnce(() => { const c = new FakeContext(); c.resume.mockImplementationOnce(() => { throw new Error("Device failed"); }); s.contexts.push(c); return c as unknown as AudioContext; });
    s.player.play(clip, onStatus); expect(s.contexts[0]?.close).toHaveBeenCalledTimes(1);
    s.player.play({ ...clip, duration_seconds: 55 }, onStatus); await flush();
    expect(onStatus).toHaveBeenLastCalledWith("error"); expect(s.contexts[1]?.source.start).not.toHaveBeenCalled(); s.player.stop();
  });
});
