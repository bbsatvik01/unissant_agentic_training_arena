// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrialView } from "../../lib/trial/trialReducer";
import type { WorldState } from "../../lib/world/worldState";
import type { SpeakHooks, SpeakItem, VoiceEngine } from "../../lib/voice/gemini";
import { speechSync } from "../../lib/voice/speechSync";
import { useVoice } from "./useVoice";

afterEach(() => { cleanup(); speechSync.clear(); });
const answer = { turn: 1, text: "The delivery arrived at nine.", startedAt: 1000 };
function world(subject: typeof answer | null = null, question: typeof answer | null = null, handing = false): WorldState {
  return { subject: { pose: subject === null ? "idle" : "speaking", speech: subject }, investigator: { speech: question }, coaches: handing ? [{ pose: "handing" }] : [] } as unknown as WorldState;
}
function practice(question = "Which delivery record confirms that?", turn = 1): TrialView {
  return { mode: "practice", cards: [{ turn_no: turn, card: { follow_up: { question } } }] } as unknown as TrialView;
}
function engine() {
  const queued: { readonly item: SpeakItem; readonly hooks: SpeakHooks }[] = [];
  // A browser may report cancellation late, or omit its callbacks entirely.
  const voice: VoiceEngine = { speak: (item, hooks) => { queued.push({ item, hooks }); }, cancel: vi.fn() };
  const entry = (index: number) => { const value = queued[index]; if (value === undefined) throw new Error(`Missing voice item ${String(index)}`); return value; };
  return { voice, queued, entry };
}
function base(voice: VoiceEngine) {
  return { world: world(answer), view: null as TrialView | null, subjectName: "Jordan Pell", clock: { current: 1000 }, active: true, scope: "recording:one", engine: voice, earpiece: true };
}

describe("captions follow actual queue starts and ends", () => {
  it("shows exact public speaker/text only after start, with no progress-driven text changes", () => {
    const audio = engine(); const props = base(audio.voice);
    const { result } = renderHook(() => useVoice(props));
    expect(result.current.currentSpeech).toBeNull();
    act(() => { audio.entry(0).hooks.onstart(); });
    expect(result.current.currentSpeech).toMatchObject({ role: "subject", speaker: "Jordan Pell", text: answer.text });
    const caption = result.current.currentSpeech;
    act(() => { audio.entry(0).hooks.onprogress(10); audio.entry(0).hooks.onprogress(20); });
    expect(result.current.currentSpeech).toBe(caption);
    act(() => { audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull();
    act(() => { audio.entry(0).hooks.onstart(); });
    expect(result.current.currentSpeech).toBeNull();
  });

  it("keeps the actually speaking coach suggestion when a newer card arrives, and ignores stale ends", () => {
    const audio = engine(); const props = { ...base(audio.voice), world: world(null, null, true), view: practice() };
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    const first = result.current.currentSpeech;
    rerender({ ...props, view: practice("A different later suggestion.", 2) });
    expect(result.current.currentSpeech).toBe(first);
    expect(first?.text).toBe(audio.entry(0).item.text);
    expect(first?.speaker).toBe("Coach · Follow-up desk");
    act(() => { audio.entry(1).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech?.text).toBe("Try asking: A different later suggestion.");
    expect(result.current.coachSpeaking).toBe(true);
    act(() => { audio.entry(1).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull(); expect(result.current.coachSpeaking).toBe(false);
  });

  it("clears before dialogue replacement, then ignores the cancelled item's late start/end", () => {
    const audio = engine(); const props = base(audio.voice);
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    const question = { turn: 2, text: "Which record did you check?", startedAt: 2000 };
    props.clock.current = 2000;
    rerender({ ...props, world: world(null, question) });
    expect(result.current.currentSpeech).toBeNull();
    act(() => { audio.entry(1).hooks.onstart(); audio.entry(0).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toMatchObject({ role: "investigator", speaker: "You · trainee", text: question.text });
    act(() => { audio.entry(1).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull();
  });

  it.each(["pause", "mute", "leave room"])("clears on %s and cannot be resurrected on resume", () => {
    const audio = engine(); const props = base(audio.voice);
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    rerender({ ...props, active: false });
    expect(result.current.currentSpeech).toBeNull();
    rerender(props);
    act(() => { audio.entry(0).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull();
  });

  it.each(["live:replacement", "idle:reset", "recording:different"])("clears synchronously on scope/source/reset %s", (scope) => {
    const audio = engine(); const props = base(audio.voice);
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    rerender({ ...props, scope });
    expect(result.current.currentSpeech).toBeNull();
    act(() => { audio.entry(0).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull();
  });

  it("drops the coach caption on earpiece cancellation but retains held dialogue and its exact text", () => {
    const audio = engine(); const props = { ...base(audio.voice), world: world(null, null, true), view: practice() };
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    const question = { turn: 2, text: "Please clarify the delivery time.", startedAt: 1500 };
    props.clock.current = 1500;
    rerender({ ...props, world: world(null, question) });
    expect(audio.queued).toHaveLength(1);
    rerender({ ...props, world: world(null, question), earpiece: false });
    expect(result.current.currentSpeech).toBeNull(); expect(audio.entry(1).item.text).toBe(question.text);
    act(() => { audio.entry(1).hooks.onstart(); audio.entry(0).hooks.onend(); audio.entry(0).hooks.onstart(); });
    expect(result.current.currentSpeech?.text).toBe(question.text);
    expect(result.current.coachSpeaking).toBe(false);
  });

  it("withholds and cancels the old coach on pending intent gate or assessment view", () => {
    const audio = engine(); const props = { ...base(audio.voice), world: world(null, null, true), view: practice() };
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    rerender({ ...props, earpiece: false }); // session's pending assessment authority
    expect(result.current.currentSpeech).toBeNull();
    rerender({ ...props, view: { ...practice(), mode: "assessment" } });
    act(() => { audio.entry(0).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull(); expect(result.current.coachSpeaking).toBe(false);
  });

  it("does not clear an aside that starts synchronously as the subject ends", () => {
    const queued: { readonly item: SpeakItem; readonly hooks: SpeakHooks }[] = [];
    const voice: VoiceEngine = { speak: (item, hooks) => { queued.push({ item, hooks }); hooks.onstart(); }, cancel: vi.fn() };
    const props = { ...base(voice), view: practice() };
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    expect(result.current.currentSpeech?.text).toBe(answer.text);
    rerender({ ...props, world: world(answer, null, true) });
    const first = queued[0]; if (first === undefined) throw new Error("Missing subject speech");
    act(() => { first.hooks.onend(); });
    expect(result.current.currentSpeech?.role).toBe("coach");
    expect(result.current.currentSpeech?.text).toBe("Try asking: Which delivery record confirms that?");
  });

  it("clears on engine replacement and rewind without allowing old callbacks to restore text", () => {
    const audio = engine(); const next = engine(); const props = base(audio.voice);
    const { result, rerender } = renderHook((p) => useVoice(p), { initialProps: props });
    act(() => { audio.entry(0).hooks.onstart(); });
    rerender({ ...props, engine: next.voice });
    expect(result.current.currentSpeech).toBeNull();
    act(() => { next.entry(0).hooks.onstart(); audio.entry(0).hooks.onstart(); audio.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech?.text).toBe(answer.text);
    props.clock.current = 0;
    rerender({ ...props, engine: next.voice, world: world() });
    expect(result.current.currentSpeech).toBeNull();
    act(() => { next.entry(0).hooks.onstart(); next.entry(0).hooks.onend(); });
    expect(result.current.currentSpeech).toBeNull();
  });

  it("keeps failed or cancelled-before-start items silent and clears through the engine's error/end path", () => {
    const audio = engine(); const { result } = renderHook(() => useVoice(base(audio.voice)));
    act(() => { audio.entry(0).hooks.onend(); audio.entry(0).hooks.onstart(); });
    expect(result.current.currentSpeech).toBeNull();
  });
});
