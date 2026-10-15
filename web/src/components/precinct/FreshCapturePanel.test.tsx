// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreshCapturePanel, type FreshCapturePanelProps } from "./FreshCapturePanel";
afterEach(cleanup);
function props(): FreshCapturePanelProps {
  return { state: { phase: "idle", reason: null, captureId: null, sessionId: null, trialId: null, frames: 0, worldSamples: 0 },
    canArm: true, assessmentActive: false, onArm: vi.fn(), onStop: vi.fn(), onExport: vi.fn(), error: null };
}
describe("fresh capture controls", () => {
  it("requires an explicit arm action and discloses absent audio and sampled fidelity", () => {
    const p = props(); render(<FreshCapturePanel {...p} />); expect(p.onArm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Arm next new text run" })); expect(p.onArm).toHaveBeenCalledOnce();
    expect(screen.getByText(/Original audio is absent/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export captured text run" }).disabled).toBe(true);
  });
  it("does not export during active or pending assessment and labels incomplete exports", () => {
    const p = props(); const state = { ...p.state, phase: "incomplete" as const, reason: "resync" as const };
    const { rerender } = render(<FreshCapturePanel {...p} state={state} assessmentActive />);
    expect(screen.getByText(/Incomplete capture/).textContent).toContain("not an exact interview recording");
    expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export incomplete capture" })); expect(p.onExport).not.toHaveBeenCalled();
    rerender(<FreshCapturePanel {...p} state={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Export incomplete capture" })); expect(p.onExport).toHaveBeenCalledOnce();
  });
  it("requires confirmation before replacing a saved in-memory journal", () => {
    const p = props(); render(<FreshCapturePanel {...p} state={{ ...p.state, phase: "complete" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Arm next new text run" })); expect(p.onArm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep capture" })); expect(p.onArm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Arm next new text run" })); fireEvent.click(screen.getByRole("button", { name: "Replace and arm" }));
    expect(p.onArm).toHaveBeenCalledOnce(); expect(screen.getByText(/Whole-world fidelity is not verified/)).toBeTruthy();
  });
});
