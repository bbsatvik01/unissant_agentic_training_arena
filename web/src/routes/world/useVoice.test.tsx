// @vitest-environment jsdom
/**
 * Voices (stage 2): a line is voiced when it starts live, once per pass; Replay or a seek back voices it again; the
 * voice's start, boundaries and end drive the mouth through speechSync.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { speechSync } from "../../lib/voice/speechSync";
import { speechDurationMs } from "../../lib/world/cadence";
import type { WorldState } from "../../lib/world/worldState";
import { useVoice } from "./useVoice";

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

beforeEach(() => {
  speak.mockReset();
  speechSync.clear();
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel: vi.fn(), getVoices: () => [] } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINE = { turn: 1, text: "I was at the depot until nine.", startedAt: 1000 };

function world(answer: typeof LINE | null): WorldState {
  return { subject: { pose: answer === null ? "idle" : "speaking", speech: answer }, investigator: { speech: null }, coaches: [] } as unknown as WorldState;
}

describe("useVoice", () => {
  it("voices a line once per pass, and again after a Replay", () => {
    const clock = { current: 1100 };
    const props = { world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-1" };
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
      useVoice({ world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-2" });
    });
    expect(speak).not.toHaveBeenCalled();
  });

  it("reports the voice's start, boundaries and end to the mouth", () => {
    const clock = { current: 1000 };
    renderHook(() => {
      useVoice({ world: world(LINE), view: null, subjectName: "Jordan Pell", clock, active: true, scope: "rec-3" });
    });
    const u = speak.mock.calls[0]?.[0];
    expect(u).toBeDefined();
    clock.current = 1300;
    u?.onstart?.();
    expect(speechSync.elapsedFor(LINE, 1350)).toBe(50);
    u?.onend?.();
    expect(speechSync.elapsedFor(LINE, 1400)).toBe(speechDurationMs(LINE.text));
  });
});
