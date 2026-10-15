// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TrialView } from "../../lib/trial/trialReducer";
import type { SpeakHooks, SpeakItem, VoiceEngine } from "../../lib/voice/gemini";
import { createGeminiEngine } from "../../lib/voice/gemini";
import { speechSync } from "../../lib/voice/speechSync";
import type { WorldState } from "../../lib/world/worldState";
import { useVoice } from "./useVoice";
import { browserEngine } from "./voiceEngines";

afterEach(() => { cleanup(); speechSync.clear(); vi.unstubAllGlobals(); });

it("plays the accepted question before its same-batch authored answer without replacing canonical arrival times", async () => {
  const question = { turn: 1, text: "Which record could independently corroborate that account?", startedAt: 1000 };
  const answer = { turn: 1, text: "Original synthetic subject reply, independent of the question.", startedAt: 1000 };
  const scene = { subject: { pose: "speaking", speech: answer }, investigator: { speech: question }, coaches: [] } as unknown as WorldState;
  const started: { text: string; stop: ReturnType<typeof vi.fn>; ended: () => void }[] = [];
  const fallback = { speak: vi.fn(), cancel: vi.fn() };
  const engine = createGeminiEngine({
    fetchClip: (voice, text) => Promise.resolve({ voice, text, duration: 1 }),
    play: (clip, _volume, ended) => { const entry = { text: clip.text, stop: vi.fn(), ended }; started.push(entry); return { stop: entry.stop, elapsed: () => 0 }; },
  }, fallback, { every: () => () => undefined });
  renderHook(() => useVoice({ world: scene, view: null, subjectName: "Jordan Pell", clock: { current: 1000 }, active: true, scope: "synthetic-same-batch", engine }));
  await act(async () => { await Promise.resolve(); });
  expect(started.map((entry) => entry.text)).toEqual([question.text]);
  await act(async () => { started[0]?.ended(); await Promise.resolve(); });
  expect(started.map((entry) => entry.text)).toEqual([question.text, answer.text]);
  expect(started[0]?.stop).not.toHaveBeenCalled(); expect(fallback.speak).not.toHaveBeenCalled();
  expect(question.startedAt).toBe(1000); expect(answer.startedAt).toBe(1000);
});

function pair(turn = 1, at = 1000) {
  return { question: { turn, text: `Accepted neutral question ${String(turn)}?`, startedAt: at }, answer: { turn, text: `Authored synthetic reply ${String(turn)}.`, startedAt: at } };
}
function sceneFor(lines: ReturnType<typeof pair> | null, handing = false): WorldState {
  return { subject: { pose: lines === null ? "idle" : "speaking", speech: lines?.answer ?? null }, investigator: { speech: lines?.question ?? null }, coaches: handing ? [{ pose: "handing" }] : [] } as unknown as WorldState;
}
function practice(partial = false, mode: "practice" | "assessment" = "practice", coach = false) {
  return { mode, turns: [{ turn_no: 1, partial }], cards: coach ? [{ turn_no: 1, card: { follow_up: { question: "Which public record can confirm that?" } } }] : [] } as unknown as TrialView;
}
function playback() {
  const started: { text: string; stop: ReturnType<typeof vi.fn>; ended: () => void }[] = [];
  const fetchClip = vi.fn((voice: string, text: string) => Promise.resolve({ voice, text, duration: 1 }));
  const fallback = { speak: vi.fn(), cancel: vi.fn() };
  const engine = createGeminiEngine({ fetchClip, play: (clip, _volume, ended) => {
    const entry = { text: clip.text, stop: vi.fn(), ended }; started.push(entry); return { stop: entry.stop, elapsed: () => 0 };
  } }, fallback, { every: () => () => undefined });
  const entry = (index: number) => { const value = started[index]; if (value === undefined) throw new Error(`Missing playback ${String(index)}`); return value; };
  return { engine, fetchClip, started, entry, fallback };
}
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

it("bounds repeated and equal-time render arrivals to the current turn's two items", async () => {
  const audio = playback(), lines = pair(), clock = { current: 1000 };
  const props = { world: sceneFor(lines), view: practice(), subjectName: "Jordan Pell", clock, active: true, scope: "bound", engine: audio.engine };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  for (let index = 0; index < 100; index += 1) {
    const revision = pair(1, 1000 + index / 1000); rerender({ ...props, world: sceneFor(revision) });
  }
  expect(audio.fetchClip).toHaveBeenCalledTimes(2); expect(audio.started).toHaveLength(1);
  expect(result.current.currentSpeech?.text).toBe(lines.question.text);
  await act(async () => { audio.entry(0).ended(); await Promise.resolve(); });
  expect(audio.started.map((entry) => entry.text)).toEqual([lines.question.text, lines.answer.text]);
  expect(result.current.currentSpeech?.text).toBe(lines.answer.text);
});

it("waits for the committed answer rather than voicing partial streamed revisions", async () => {
  const audio = playback(), lines = pair(), clock = { current: 1000 };
  const props = { world: sceneFor(lines), view: practice(true), subjectName: "Jordan Pell", clock, active: true, scope: "partial", engine: audio.engine };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  for (const text of ["A", "A partial", "A partial streamed answer"]) rerender({ ...props, world: sceneFor({ ...lines, answer: { ...lines.answer, text } }) });
  expect(audio.fetchClip).toHaveBeenCalledTimes(1); expect(result.current.currentSpeech?.text).toBe(lines.question.text);
  rerender({ ...props, view: practice(false) }); await flush();
  expect(audio.fetchClip).toHaveBeenCalledTimes(2); expect(audio.started).toHaveLength(1);
  await act(async () => { audio.entry(0).ended(); await Promise.resolve(); });
  expect(audio.entry(1).text).toBe(lines.answer.text); expect(result.current.currentSpeech?.text).toBe(lines.answer.text);
});

it("supersedes the old turn once and ignores its late completion while the next question speaks", async () => {
  const audio = playback(), first = pair(), next = pair(2, 2000), clock = { current: 1000 };
  const props = { world: sceneFor(first), view: practice(), subjectName: "Jordan Pell", clock, active: true, scope: "replace", engine: audio.engine };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  clock.current = 2000; rerender({ ...props, world: sceneFor(next) }); await flush();
  expect(audio.entry(0).stop).toHaveBeenCalledOnce(); expect(audio.entry(1).text).toBe(next.question.text);
  act(() => { audio.entry(0).ended(); });
  expect(result.current.currentSpeech?.text).toBe(next.question.text);
  expect(speechSync.activeFor(first.question, 2000)).toBe(false); expect(speechSync.activeFor(first.answer, 2000)).toBe(false);
  await act(async () => { audio.entry(1).ended(); await Promise.resolve(); });
  expect(audio.started.map((entry) => entry.text)).toEqual([first.question.text, next.question.text, next.answer.text]);
});

it.each(["scope", "mute", "rewind"])("cancels the pending same-turn answer on %s without a late resurrection", async (reason) => {
  const audio = playback(), lines = pair(), clock = { current: 1000 };
  const props = { world: sceneFor(lines), view: practice(), subjectName: "Jordan Pell", clock, active: true, scope: "cancel", engine: audio.engine };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  if (reason === "rewind") clock.current = 0;
  rerender({ ...props, world: sceneFor(null), active: reason !== "mute", scope: reason === "scope" ? "replacement" : props.scope });
  act(() => { audio.entry(0).ended(); }); await flush();
  expect(audio.entry(0).stop).toHaveBeenCalledOnce(); expect(audio.started).toHaveLength(1); expect(result.current.currentSpeech).toBeNull();
});

it("preserves a speaking coach but holds only the newest turn's question and answer behind it", async () => {
  const audio = playback(), lines = pair(2), newest = pair(3), clock = { current: 1000 };
  const props = { world: sceneFor(null, true), view: practice(false, "practice", true), subjectName: "Jordan Pell", clock, active: true, scope: "coach", engine: audio.engine, earpiece: true };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  expect(result.current.coachSpeaking).toBe(true);
  rerender({ ...props, world: sceneFor(lines) }); rerender({ ...props, world: sceneFor(newest) });
  expect(audio.fetchClip).toHaveBeenCalledTimes(1); expect(audio.entry(0).stop).not.toHaveBeenCalled();
  expect(speechSync.activeFor(lines.question, 1000)).toBe(false); expect(speechSync.activeFor(lines.answer, 1000)).toBe(false);
  await act(async () => { audio.entry(0).ended(); await Promise.resolve(); });
  expect(audio.fetchClip).toHaveBeenCalledTimes(3); expect(audio.entry(1).text).toBe(newest.question.text);
  await act(async () => { audio.entry(1).ended(); await Promise.resolve(); });
  expect(audio.entry(2).text).toBe(newest.answer.text); expect(result.current.coachSpeaking).toBe(false);
});

it("does not introduce earpiece coaching in assessment", async () => {
  const audio = playback(), lines = pair();
  renderHook(() => useVoice({ world: sceneFor(lines, true), view: practice(false, "assessment", true), subjectName: "Jordan Pell", clock: { current: 1000 }, active: true, scope: "assessment", engine: audio.engine, earpiece: true }));
  await flush(); expect(audio.fetchClip).toHaveBeenCalledTimes(2); expect(audio.entry(0).text).toBe(lines.question.text);
  await act(async () => { audio.entry(0).ended(); await Promise.resolve(); });
  expect(audio.entry(1).text).toBe(lines.answer.text); expect(audio.fetchClip).toHaveBeenCalledTimes(2);
});

class NativeUtterance {
  text: string;
  voice: unknown = null;
  pitch = 1;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

// Models the native Web Speech queue contract, not a substitute engine: production browserEngine
// creates every utterance and owns its native end/error handlers. This is unit evidence, not audio proof.
function nativeSpeechQueue() {
  const queued: NativeUtterance[] = [], started: NativeUtterance[] = [];
  let active: NativeUtterance | null = null;
  const pump = () => {
    if (active !== null) return;
    const next = queued.shift();
    if (next === undefined) return;
    active = next; started.push(next); next.onstart?.();
  };
  const cancel = vi.fn(() => { active = null; queued.length = 0; });
  vi.stubGlobal("SpeechSynthesisUtterance", NativeUtterance);
  vi.stubGlobal("speechSynthesis", { getVoices: () => [], cancel, speak: (utterance: NativeUtterance) => { queued.push(utterance); pump(); } });
  return { started, cancel, finish: (event: "end" | "error") => {
    const prior = active;
    if (prior === null) throw new Error("No native utterance is active.");
    active = null;
    if (event === "error") prior.onerror?.(); else prior.onend?.();
    pump();
  } };
}

it.each([
  ["browser", "end"], ["browser", "error"], ["fallback", "end"], ["fallback", "error"],
] as const)("serializes real %s engine question/answer on native %s and rejects duplicate completion", async (mode, event) => {
  const native = nativeSpeechQueue();
  const browser = browserEngine();
  const engine = mode === "browser" ? browser : createGeminiEngine({
    fetchClip: () => Promise.resolve(null), play: () => { throw new Error("A missing clip cannot play."); },
  }, browser, { every: () => () => undefined });
  const lines = pair();
  const { result } = renderHook(() => useVoice({ world: sceneFor(lines), view: practice(), subjectName: "Jordan Pell", clock: { current: 1000 }, active: true, scope: `native-${mode}-${event}`, engine }));
  await flush();
  expect(native.started.map((utterance) => utterance.text)).toEqual([lines.question.text]);
  expect(result.current.currentSpeech?.text).toBe(lines.question.text);
  await act(async () => { native.finish(event); await Promise.resolve(); });
  expect(native.started.map((utterance) => utterance.text)).toEqual([lines.question.text, lines.answer.text]);
  expect(result.current.currentSpeech?.text).toBe(lines.answer.text);
  act(() => { native.started[0]?.onstart?.(); native.started[0]?.onboundary?.({ charIndex: 8 }); native.started[0]?.onerror?.(); native.started[0]?.onend?.(); });
  expect(result.current.currentSpeech?.text).toBe(lines.answer.text);
  act(() => { native.finish("end"); });
  expect(result.current.currentSpeech).toBeNull(); expect(native.started).toHaveLength(2);
});

it("earpiece mute releases the held question/answer pair without cancelling either dialogue item", async () => {
  const audio = playback(), lines = pair(2), clock = { current: 1000 };
  const props = { world: sceneFor(null, true), view: practice(false, "practice", true), subjectName: "Jordan Pell", clock, active: true, scope: "earpiece", engine: audio.engine, earpiece: true };
  const { rerender, result } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  rerender({ ...props, world: sceneFor(lines) }); expect(audio.fetchClip).toHaveBeenCalledTimes(1);
  rerender({ ...props, world: sceneFor(lines), earpiece: false }); await flush();
  expect(audio.entry(0).stop).toHaveBeenCalledOnce(); expect(audio.entry(1).text).toBe(lines.question.text);
  act(() => { audio.entry(0).ended(); });
  expect(result.current.currentSpeech?.text).toBe(lines.question.text); expect(result.current.coachSpeaking).toBe(false);
  await act(async () => { audio.entry(1).ended(); await Promise.resolve(); });
  expect(audio.entry(2).text).toBe(lines.answer.text); expect(audio.entry(1).stop).not.toHaveBeenCalled();
});

it("rejects late start/progress/end hooks from replaced dialogue even when an engine ignores cancel", () => {
  const queued: { item: SpeakItem; hooks: SpeakHooks }[] = [];
  const engine: VoiceEngine = { speak: (item, hooks) => { queued.push({ item, hooks }); }, cancel: vi.fn() };
  const first = pair(), next = pair(2, 2000), clock = { current: 1000 };
  const props = { world: sceneFor(first), view: practice(), subjectName: "Jordan Pell", clock, active: true, scope: "late-hooks", engine };
  const { result, rerender } = renderHook((value) => useVoice(value), { initialProps: props });
  act(() => { queued[0]?.hooks.onstart(); }); expect(result.current.currentSpeech?.text).toBe(first.question.text);
  clock.current = 2000; rerender({ ...props, world: sceneFor(next) });
  act(() => { queued[2]?.hooks.onstart(); queued[0]?.hooks.onprogress(5); queued[0]?.hooks.onend(); queued[1]?.hooks.onstart(); queued[1]?.hooks.onend(); });
  expect(queued).toHaveLength(4); expect(result.current.currentSpeech?.text).toBe(next.question.text);
  act(() => { queued[2]?.hooks.onend(); queued[3]?.hooks.onstart(); }); expect(result.current.currentSpeech?.text).toBe(next.answer.text);
});

it("does not release an unspoken superseded-turn suggestion after the newer answer", async () => {
  const audio = playback(), first = pair(), next = pair(2, 2000), clock = { current: 1000 };
  const props = { world: sceneFor(first, true), view: practice(false, "practice", true), subjectName: "Jordan Pell", clock, active: true, scope: "stale-aside", engine: audio.engine, earpiece: true };
  const { rerender } = renderHook((value) => useVoice(value), { initialProps: props }); await flush();
  expect(audio.fetchClip).toHaveBeenCalledTimes(2);
  clock.current = 2000; rerender({ ...props, world: sceneFor(next) }); await flush();
  await act(async () => { audio.entry(1).ended(); await Promise.resolve(); });
  await act(async () => { audio.entry(2).ended(); await Promise.resolve(); });
  expect(audio.started.map((entry) => entry.text)).toEqual([first.question.text, next.question.text, next.answer.text]);
  expect(audio.fetchClip).toHaveBeenCalledTimes(4);
});
