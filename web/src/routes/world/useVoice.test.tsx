// @vitest-environment jsdom
/**
 * Voices (stage 2): a line is voiced when it starts live, once per pass; Replay or a seek back voices it again; the
 * voice's start, boundaries and end drive the mouth through speechSync.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { speechSync } from "../../lib/voice/speechSync";
import { speechDurationMs } from "../../lib/world/cadence";
import type { TrialView } from "../../lib/trial/trialReducer";
import type { WorldState } from "../../lib/world/worldState";
import { useVoice } from "./useVoice";
import { browserEngine } from "./voiceEngines";

const ENGINE = browserEngine();

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

beforeEach(() => {
  speak.mockReset();
  cancel.mockReset();
  speechSync.clear();
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel, getVoices: () => [] } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINE = { turn: 1, text: "I was at the depot until nine.", startedAt: 1000 };

function world(answer: typeof LINE | null, question: typeof LINE | null = null, handing = false): WorldState {
  return { subject: { pose: answer === null ? "idle" : "speaking", speech: answer }, investigator: { speech: question }, coaches: handing ? [{ pose: "handing" }] : [] } as unknown as WorldState;
}

const PRACTICE = { mode: "practice", cards: [{ turn_no: 1, card: { follow_up: { question: "What time did you leave?" } } }] } as unknown as TrialView;

describe("useVoice", () => {
  it("voices a line once per pass, and again after a Replay", () => {
    const clock = { current: 1100 };
    const props = { world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-1", engine: ENGINE };
    const { rerender } = renderHook((p: typeof props) => {
      useVoice(p);
    }, { initialProps: props });
    expect(speak).toHaveBeenCalledTimes(1);
    clock.current = 1200;
    rerender({ ...props, world: world({ ...LINE }) });
    expect(speak).toHaveBeenCalledTimes(1);
    // Replay: the clock goes back to the start, then the same line starts again.
    clock.current = 0;
    rerender({ ...props, world: world(null) });
    clock.current = 1100;
    rerender({ ...props, world: world({ ...LINE }) });
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it("stays silent when a line is joined after it started (a seek into it)", () => {
    const clock = { current: 2500 };
    renderHook(() => {
      useVoice({ world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-2", engine: ENGINE });
    });
    expect(speak).not.toHaveBeenCalled();
  });

  it("reports the voice's start, boundaries and end to the mouth", () => {
    const clock = { current: 1000 };
    renderHook(() => {
      useVoice({ world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-3", engine: ENGINE });
    });
    const u = speak.mock.calls[0]?.[0];
    expect(u).toBeDefined();
    clock.current = 1300;
    u?.onstart?.();
    expect(speechSync.elapsedFor(LINE, 1350)).toBe(50);
    u?.onend?.();
    expect(speechSync.elapsedFor(LINE, 1400)).toBe(speechDurationMs(LINE.text));
  });

  it("never cuts the coach's suggestion: the next line waits behind it, its mouth closed until its voice starts", () => {
    const clock = { current: 5000 };
    const props = { world: world(null, null, true), view: PRACTICE, subjectName: "Jordan Pell", clock, active: true, scope: "rec-4", engine: ENGINE };
    const { rerender } = renderHook((p: typeof props) => {
      useVoice(p);
    }, { initialProps: props });
    const coach = speak.mock.calls[0]?.[0];
    expect(coach?.text).toBe("Suggested follow-up: What time did you leave?");
    coach?.onstart?.();
    cancel.mockReset();
    const question = { turn: 2, text: "What time did you leave B-12?", startedAt: 5800 };
    clock.current = 5850;
    rerender({ ...props, world: world(null, question, false) });
    expect(cancel).not.toHaveBeenCalled();
    const queued = speak.mock.calls[1]?.[0];
    expect(queued?.text).toBe(question.text);
    expect(speechSync.activeFor(question, 7000)).toBe(true);
    expect(speechSync.elapsedFor(question, 7000)).toBeLessThan(0);
    coach?.onend?.();
    clock.current = 9000;
    queued?.onstart?.();
    expect(speechSync.elapsedFor(question, 9100)).toBe(100);
  });

  it("lets a newer line supersede the dialogue being spoken", () => {
    const clock = { current: 1000 };
    const props = { world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-5", engine: ENGINE };
    const { rerender } = renderHook((p: typeof props) => {
      useVoice(p);
    }, { initialProps: props });
    speak.mock.calls[0]?.[0].onstart?.();
    cancel.mockReset();
    const next = { turn: 2, text: "Then I went home.", startedAt: 3000 };
    clock.current = 3050;
    rerender({ ...props, world: world(next) });
    expect(cancel).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it("keeps a coach suggestion queued behind the answer when the next question comes", () => {
    const clock = { current: 1000 };
    const props = { world: world(LINE), view: PRACTICE, subjectName: "Jordan Pell", clock, active: true, scope: "rec-6", engine: ENGINE };
    const { rerender } = renderHook((p: typeof props) => {
      useVoice(p);
    }, { initialProps: props });
    speak.mock.calls[0]?.[0].onstart?.();
    clock.current = 1200;
    rerender({ ...props, world: world(LINE, null, true) });
    expect(speak.mock.calls[1]?.[0].text).toBe("Suggested follow-up: What time did you leave?");
    cancel.mockReset();
    const question = { turn: 2, text: "What time did you leave B-12?", startedAt: 1400 };
    clock.current = 1450;
    rerender({ ...props, world: world(null, question, false) });
    expect(cancel).not.toHaveBeenCalled();
    expect(speak.mock.calls[2]?.[0].text).toBe(question.text);
    // Once the coach has spoken, dialogue supersedes dialogue again.
    speak.mock.calls[1]?.[0].onend?.();
    const next = { turn: 3, text: "And then?", startedAt: 3000 };
    clock.current = 3050;
    rerender({ ...props, world: world(null, next, false) });
    expect(cancel).toHaveBeenCalled();
  });
});
