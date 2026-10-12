// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_COPY } from "../../lib/demo/demo";
import { DemoGuide } from "./DemoGuide";

afterEach(() => {
  cleanup();
});

function props(over: Partial<Parameters<typeof DemoGuide>[0]> = {}): Parameters<typeof DemoGuide>[0] {
  return {
    step: "interview",
    startedAt: Date.now(),
    recordingLoaded: false,
    nextDisabled: false,
    canLive: false,
    onNext: vi.fn(),
    onBack: vi.fn(),
    onClose: vi.fn(),
    onRecorded: vi.fn(),
    onFile: vi.fn(),
    onLive: vi.fn(),
    ...over,
  };
}

describe("DemoGuide", () => {
  it("leads with the recorded run and offers a live interview only when one can start", () => {
    const p = props();
    const { rerender } = render(<DemoGuide {...p} />);
    expect(screen.getByText(DEMO_COPY.interview.title)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play the recorded run" }).className).toBe("btn-primary");
    expect(screen.queryByRole("button", { name: "Interview live instead" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play the recorded run" }));
    expect(p.onRecorded).toHaveBeenCalled();
    rerender(<DemoGuide {...p} canLive nextDisabled />);
    fireEvent.click(screen.getByRole("button", { name: "Interview live instead" }));
    expect(p.onLive).toHaveBeenCalled();
    // A live interview reaches the debrief by finishing it.
    expect(screen.getByRole("button", { name: "Go to the debrief" }).hasAttribute("disabled")).toBe(true);
  });

  it("names the next place and finishes on the arena", () => {
    const p = props({ step: "precinct", onBack: null });
    const { rerender } = render(<DemoGuide {...p} />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the interview room" }));
    expect(p.onNext).toHaveBeenCalled();
    rerender(<DemoGuide {...p} step="arena" />);
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(p.onClose).toHaveBeenCalled();
    expect(screen.getByText(/0:0\d \/ 4:00/)).toBeTruthy();
  });

  it("passes a chosen recording file on", () => {
    const p = props();
    render(<DemoGuide {...p} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["{}"], "run.json", { type: "application/json" });
    if (input === null) throw new Error("no input");
    fireEvent.change(input, { target: { files: [file] } });
    expect(p.onFile).toHaveBeenCalledWith(file);
  });
});
