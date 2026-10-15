// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSpeech } from "./LocalSpeech";

class FakeUtterance {
  readonly text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}
const voice = (name: string, localService: boolean, lang = "en-US"): SpeechSynthesisVoice => ({ name, localService, lang, default: false, voiceURI: name });
function device(voices: SpeechSynthesisVoice[] = [voice("remote", false), voice("installed", true)]) {
  const speech = { getVoices: vi.fn(() => voices), cancel: vi.fn(), speak: vi.fn<(line: FakeUtterance) => void>() };
  vi.stubGlobal("speechSynthesis", speech);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return speech;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("explicit device-local speech", () => {
  it("does not inspect voices or play on mount and selects only an installed voice after a click", () => {
    const speech = device();
    render(<StrictMode><LocalSpeech text="A visible subtitle." /></StrictMode>);
    expect(speech.getVoices).not.toHaveBeenCalled();
    expect(speech.speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    const line = speech.speak.mock.calls[0]?.[0];
    expect(line?.text).toBe("A visible subtitle.");
    expect(line?.voice?.name).toBe("installed");
    expect(line?.voice?.localService).toBe(true);
    expect(line?.lang).toBe("en-US");
    expect(screen.getByRole("button", { name: "Stop voice" })).toBeTruthy();
  });

  it("never selects a remote-only voice and leaves the subtitle fallback available", () => {
    const speech = device([voice("remote-only", false)]);
    render(<LocalSpeech text="Keep reading this." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    expect(speech.speak).not.toHaveBeenCalled();
    expect(speech.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("No installed local voice");
  });

  it("uses a non-English installed voice when that is the only local option and bounds playback text", () => {
    const speech = device([voice("installed-fr", true, "fr-FR")]);
    render(<LocalSpeech text={"a".repeat(6000)} />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    expect(speech.speak.mock.calls[0]?.[0].text).toHaveLength(5000);
    expect(speech.speak.mock.calls[0]?.[0].lang).toBe("fr-FR");
  });

  it("cancels on explicit stop and suppresses callbacks from a stopped utterance", () => {
    const speech = device();
    render(<LocalSpeech text="A subtitle." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    const line = speech.speak.mock.calls[0]?.[0];
    const staleEnd = line?.onend;
    fireEvent.click(screen.getByRole("button", { name: "Stop voice" }));
    expect(speech.cancel).toHaveBeenCalledTimes(2);
    expect(line?.onend).toBeNull();
    expect(line?.onerror).toBeNull();
    act(() => { staleEnd?.(); });
    expect(screen.getByRole("button", { name: "Read aloud locally" })).toBeTruthy();
  });

  it("cancels old playback when the response key changes and when a panel closes", () => {
    const speech = device();
    const { rerender, unmount } = render(<LocalSpeech key="first" text="First reply." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    const first = speech.speak.mock.calls[0]?.[0];
    rerender(<LocalSpeech key="second" text="Second reply." />);
    expect(speech.cancel).toHaveBeenCalledTimes(2);
    expect(first?.onend).toBeNull();
    expect(speech.speak).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    const second = speech.speak.mock.calls[1]?.[0];
    unmount();
    expect(speech.cancel).toHaveBeenCalledTimes(4);
    expect(second?.onend).toBeNull();
  });

  it("updates status on normal completion or playback error", () => {
    const speech = device();
    render(<LocalSpeech text="Subtitle stays on screen." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    act(() => { speech.speak.mock.calls[0]?.[0].onend?.(); });
    expect(screen.getByRole("status").textContent).toContain("Optional device-local voice");
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    act(() => { speech.speak.mock.calls[1]?.[0].onerror?.(); });
    expect(screen.getByRole("status").textContent).toContain("Voice playback is unavailable");
  });

  it("catches voice lookup, cancellation, constructor and speak failures without throwing", () => {
    for (const failure of ["lookup", "cancel", "construct", "speak"]) {
      const speech = device();
      if (failure === "lookup") speech.getVoices.mockImplementation(() => { throw new Error("device vanished"); });
      if (failure === "cancel") speech.cancel.mockImplementation(() => { throw new Error("device vanished"); });
      if (failure === "construct") vi.stubGlobal("SpeechSynthesisUtterance", class extends FakeUtterance { constructor(text: string) { super(text); throw new Error("unavailable"); } });
      if (failure === "speak") speech.speak.mockImplementation(() => { throw new Error("unavailable"); });
      render(<LocalSpeech text="The full subtitle remains." />);
      expect(() => { fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" })); }).not.toThrow();
      expect(screen.getByRole("status").textContent).toContain("Voice playback is unavailable");
      cleanup(); vi.unstubAllGlobals();
    }
  });

  it("catches cancellation errors during stop and unmount", () => {
    const speech = device();
    const first = render(<LocalSpeech text="Subtitle." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    speech.cancel.mockImplementation(() => { throw new Error("gone"); });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice" }));
    expect(screen.getByRole("status").textContent).toContain("Voice playback is unavailable");
    first.unmount();
    speech.cancel.mockReset();
    const second = render(<LocalSpeech text="Another subtitle." />);
    fireEvent.click(screen.getByRole("button", { name: "Read aloud locally" }));
    speech.cancel.mockImplementation(() => { throw new Error("gone"); });
    expect(() => { second.unmount(); }).not.toThrow();
  });
});


describe("one local spoken line at a time", () => {
  it("stops the old control when another explicit line starts and does not cancel the new voice on old cleanup", () => {
    const speech = device();
    const { rerender } = render(<><section aria-label="briefing"><LocalSpeech text="Public briefing." /></section><section aria-label="colleague"><LocalSpeech text="Technique greeting." /></section></>);
    const briefing = within(screen.getByRole("region", { name: "briefing" }));
    const colleague = within(screen.getByRole("region", { name: "colleague" }));
    fireEvent.click(briefing.getByRole("button", { name: "Read aloud locally" }));
    const old = speech.speak.mock.calls[0]?.[0];
    fireEvent.click(colleague.getByRole("button", { name: "Read aloud locally" }));
    expect(briefing.getByRole("button", { name: "Read aloud locally" })).toBeTruthy();
    expect(colleague.getByRole("button", { name: "Stop voice" })).toBeTruthy();
    expect(old?.onend).toBeNull();
    expect(old?.onerror).toBeNull();
    const cancellationCount = speech.cancel.mock.calls.length;
    rerender(<><section aria-label="briefing" /><section aria-label="colleague"><LocalSpeech text="Technique greeting." /></section></>);
    expect(speech.cancel).toHaveBeenCalledTimes(cancellationCount);
  });
});
