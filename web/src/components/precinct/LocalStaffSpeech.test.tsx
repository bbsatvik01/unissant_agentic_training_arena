// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStaffSpeech } from "./LocalStaffSpeech";
import type { LocalStaffVoiceStatus } from "../../lib/precinct/localStaffVoice";
const fake = vi.hoisted(() => ({ play: vi.fn(), find: vi.fn(), stop: vi.fn(), mute: vi.fn(), callback: null as ((status: LocalStaffVoiceStatus) => void) | null }));
vi.mock("../../lib/precinct/localStaffVoice", () => ({
  LOCAL_SPEECH_STARTED: "arena-local-speech-started",
  findLocalStaffClip: fake.find,
  localStaffPlayer: { play: fake.play },
}));
beforeEach(() => {
  fake.play.mockReset(); fake.find.mockReset(); fake.stop.mockReset(); fake.mute.mockReset(); fake.callback = null;
  fake.find.mockImplementation((voice: string, text: string) => ({ voice_id: voice, text }));
  fake.play.mockImplementation((_clip: unknown, callback: (status: LocalStaffVoiceStatus) => void) => {
    fake.callback = callback; callback("loading");
    return { stop: fake.stop.mockImplementation(() => { callback("idle"); }), setMuted: fake.mute };
  });
});
afterEach(cleanup);
describe("explicit scripted staff speech", () => {
  it("never starts on mount, reads the exact full subtitle, then exposes stop and mute", () => {
    const text = "A complete, exact original authored subtitle.";
    render(<StrictMode><LocalStaffSpeech text={text} voiceId="local-reception-v1" /></StrictMode>);
    expect(fake.play).not.toHaveBeenCalled(); expect(screen.getByText(/Fixed local dialogue/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play scripted staff voice" }));
    expect(fake.play.mock.calls[0]?.[0]).toEqual({ voice_id: "local-reception-v1", text });
    expect(screen.getByRole("button", { name: "Stop staff voice" })).toBeTruthy();
    act(() => { fake.callback?.("speaking"); });
    fireEvent.click(screen.getByRole("button", { name: "Mute staff voice" })); expect(fake.mute).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute staff voice" })); expect(fake.mute).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop staff voice" })); expect(fake.stop).toHaveBeenCalled();
  });
  it("cancels on changed text, room/panel unmount and another local speaker", () => {
    const view = render(<LocalStaffSpeech text="First." voiceId="local-reception-v1" />);
    fireEvent.click(screen.getByRole("button", { name: "Play scripted staff voice" })); const late = fake.callback;
    view.rerender(<LocalStaffSpeech text="Second." voiceId="local-sergeant-v1" />);
    expect(fake.stop).toHaveBeenCalledTimes(1); act(() => { late?.("speaking"); });
    expect(screen.queryByRole("button", { name: "Stop staff voice" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play scripted staff voice" }));
    act(() => { window.dispatchEvent(new CustomEvent("arena-local-speech-started", { detail: "another-speaker" })); });
    expect(fake.stop).toHaveBeenCalledTimes(2); view.unmount(); expect(fake.stop).toHaveBeenCalledTimes(3);
  });
  it("does not substitute speech for a personalized or otherwise unmatched line", () => {
    fake.find.mockReturnValue(undefined);
    render(<LocalStaffSpeech text="Welcome, Alex." voiceId="local-reception-v1" />);
    const button = screen.getByRole("button", { name: "Play scripted staff voice" });
    expect(button.getAttribute("disabled")).not.toBeNull(); fireEvent.click(button); expect(fake.play).not.toHaveBeenCalled();
    expect(screen.getByText(/Audio is unavailable for this exact line/u)).toBeTruthy();
  });
  it("reports failures truthfully and permits an explicit retry", () => {
    render(<LocalStaffSpeech text="Exact." voiceId="local-reception-v1" />);
    fireEvent.click(screen.getByRole("button", { name: "Play scripted staff voice" })); act(() => { fake.callback?.("error"); });
    expect(screen.getByText(/Audio could not play/u)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Play scripted staff voice" })); expect(fake.play).toHaveBeenCalledTimes(2);
  });
});
