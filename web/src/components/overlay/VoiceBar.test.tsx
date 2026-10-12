// @vitest-environment jsdom
/** The voice pill bar (S6 3.3, 6.2): consent before the microphone, the bar's words per state, the ended copy by
 * close code, and Reconnect only after a transport drop. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialVoiceState, voiceReducer, type VoiceEvent, type VoiceState } from "../../lib/voice/voiceMachine";
import { VoiceBar } from "./VoiceBar";

afterEach(() => {
  cleanup();
});

function fold(events: readonly VoiceEvent[]): VoiceState {
  return events.reduce(voiceReducer, initialVoiceState("live"));
}

const OPEN: VoiceEvent[] = [{ type: "open_consent" }, { type: "connect" }, { type: "socket_open" }];

function bar(state: VoiceState, handlers: Partial<Record<"onOpen" | "onConsent" | "onDecline" | "onStop" | "onInterrupt" | "onReconnect", () => void>> = {}) {
  const noop = () => undefined;
  return render(
    <VoiceBar
      state={state}
      captureAboveFloor={false}
      subjectName="Jordan"
      error={null}
      talk={0}
      onOpen={handlers.onOpen ?? noop}
      onConsent={handlers.onConsent ?? noop}
      onDecline={handlers.onDecline ?? noop}
      onStop={handlers.onStop ?? noop}
      onInterrupt={handlers.onInterrupt ?? noop}
      onReconnect={handlers.onReconnect ?? noop}
    />,
  );
}

describe("VoiceBar", () => {
  it("asks for consent before the microphone opens", () => {
    const onOpen = vi.fn();
    bar(initialVoiceState("live"), { onOpen });
    fireEvent.click(screen.getByRole("button", { name: "Start speaking" }));
    expect(onOpen).toHaveBeenCalledOnce();
    cleanup();
    const onConsent = vi.fn();
    const onDecline = vi.fn();
    bar(fold([{ type: "open_consent" }]), { onConsent, onDecline });
    expect(screen.getByRole("dialog").textContent).toContain("not scored");
    fireEvent.click(screen.getByRole("button", { name: "Allow the microphone and start" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onConsent).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it("says who is talking, shows unpaired captions and offers interrupt while the subject speaks", () => {
    const onInterrupt = vi.fn();
    const speaking = fold([...OPEN, { type: "utterance_start", utterance: 1 }, { type: "transcription", role: "investigator", text: "Where were you?", partial: false }, { type: "transcription", role: "subject", text: "At my desk.", partial: true }, { type: "playback", utterance: 1 }, { type: "exchange_count", used: 2, cap: 12 }, { type: "timer_tick", timeRemaining: 125 }]);
    bar(speaking, { onInterrupt });
    expect(screen.getByRole("status").textContent).toBe("Jordan is speaking");
    expect(screen.getByText("2/12 exchanges, 2:05 left")).toBeTruthy();
    expect(screen.getByLabelText("Live captions").textContent).toContain("You: Where were you?");
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onInterrupt).toHaveBeenCalledOnce();
    cleanup();
    bar(fold(OPEN));
    expect(screen.getByRole("status").textContent).toBe("Listening");
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBe(null);
  });

  it("ends with the close code's words and offers Reconnect only after a drop", () => {
    const onReconnect = vi.fn();
    bar(fold([...OPEN, { type: "socket_closed", code: 1006 }]), { onReconnect });
    expect(screen.getByRole("status").textContent).toContain("dropped");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
    cleanup();
    bar(fold([...OPEN, { type: "socket_closed", code: 4409 }]));
    expect(screen.getByRole("status").textContent).toContain("platform check");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Hang up" })).toBe(null);
  });

  it("warns a minute before the audio cap and hangs up on request", () => {
    const onStop = vi.fn();
    bar(fold([...OPEN, { type: "warning", reason: "ending_soon", seconds: 60 }]), { onStop });
    expect(screen.getByText(/Voice ends in 60 s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hang up" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
