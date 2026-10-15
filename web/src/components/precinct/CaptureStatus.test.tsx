// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreshCaptureState } from "../../lib/world/freshClientCapture";
import type { CaptureSnapshot } from "../../lib/world/worldCapture";
import { CaptureStatus } from "./CaptureStatus";
afterEach(cleanup);
const fresh: FreshCaptureState = { phase: "recording", reason: null, captureId: "private-identity", sessionId: "actual-session", trialId: "actual-trial", frames: 0, worldSamples: 0 };
const local: CaptureSnapshot = { status: "empty", issue: null, sessionKey: null, trialId: null, count: 0, bytes: 13, pending: 0, transport: "off" };
describe("one finite capture announcement", () => {
  it("does not mutate the live region for count updates or expose identities and payloads", async () => {
    const { rerender } = render(<CaptureStatus fresh={fresh} local={local} modal={false} />);
    const status = screen.getByRole("status", { name: "Capture status" }); const changed = vi.fn();
    const observer = new MutationObserver(changed); observer.observe(status, { childList: true, characterData: true, subtree: true });
    for (let count = 1; count <= 20; count += 1) {
      const countedFresh = { ...fresh, frames: count, worldSamples: count * 20 };
      const countedLocal = { ...local, count, bytes: count * 100 };
      rerender(<CaptureStatus fresh={countedFresh} local={countedLocal} modal={false} />);
    }
    await Promise.resolve(); expect(changed).not.toHaveBeenCalled(); expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).not.toContain("private-identity"); expect(status.textContent).not.toContain("actual-session");
    rerender(<CaptureStatus fresh={{ ...fresh, phase: "incomplete", reason: "bounds" }} local={local} modal={false} />);
    await Promise.resolve(); expect(changed).toHaveBeenCalledOnce(); expect(status.textContent).toContain("incomplete (bounds)"); observer.disconnect();
  });
  it("announces uncaptured audio as an incomplete local prefix without payloads", () => {
    render(<CaptureStatus fresh={{ phase: "idle", reason: null }} local={{ ...local, status: "blocked", issue: "audio-enabled", trialId: "private-id" }} modal={false} />);
    const status = screen.getByRole("status", { name: "Capture status" });
    expect(status.textContent).toContain("incomplete (audio-enabled)"); expect(status.textContent).not.toContain("private-id");
  });
  it("keeps idle announcements empty and both capture kinds finite inside a modal", () => {
    const { rerender } = render(<CaptureStatus fresh={{ phase: "idle", reason: null }} local={local} modal={false} />);
    expect(screen.getByRole("status").textContent).toBe("");
    rerender(<CaptureStatus fresh={{ phase: "complete", reason: null }} local={{ ...local, trialId: "never-render-this-id", status: "blocked", issue: "memory-limit" }} modal />);
    const status = screen.getByRole("status"); expect(status.classList.contains("precinct-capture-status--modal")).toBe(true);
    expect(status.textContent).toContain("World replay is sampled"); expect(status.textContent).toContain("memory-limit");
    expect(status.textContent).not.toContain("never-render-this-id"); expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
