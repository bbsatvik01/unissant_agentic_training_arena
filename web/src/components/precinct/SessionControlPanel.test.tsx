// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRecordingsPanel } from "./SessionControlPanel";

afterEach(cleanup);

describe("recorded interview choices", () => {
  it("offers the neutral real coached recording as an explicit one-click choice with no automatic load", () => {
    const session = {
      backend: "offline", recordingState: "empty", recordingError: null, recordingTrialId: null,
      loadCoachedRecording: vi.fn(() => Promise.resolve()), loadBundledRecording: vi.fn(() => Promise.resolve()),
      importRecording: vi.fn(() => Promise.resolve()), loadLocalRecording: vi.fn(() => Promise.resolve()),
    } satisfies ComponentProps<typeof SessionRecordingsPanel>["session"];
    const { container } = render(<SessionRecordingsPanel session={session} />);
    expect(session.loadCoachedRecording).not.toHaveBeenCalled();
    expect(session.loadBundledRecording).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/deceptive|truthful|real-F01/i);
    expect(screen.getByText(/Loading it does not contact Gemini or produce a new score/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recorded coached interview · Gemini" }));
    expect(session.loadCoachedRecording).toHaveBeenCalledTimes(1);
    expect(session.loadBundledRecording).not.toHaveBeenCalled();
    expect(session.loadLocalRecording).not.toHaveBeenCalled();
    expect(session.importRecording).not.toHaveBeenCalled();
  });
});
