// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAgentWork, STYLE_NAMES, WORK_STYLES } from "../../lib/agent-work/model";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { initialTrialState, trialReducer } from "../../lib/trial/trialReducer";
import { LogBuilder, snapshot } from "../../test/trial-log";
import { ObservationStationPanel } from "./ObservationStationPanel";

afterEach(cleanup);
function frame() {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
  for (const event of new LogBuilder().ask({ releaseAfter: "public-record" }).frames) state = trialReducer(state, { type: "frame", frame: event });
  return deriveAgentWork({ view: state.view, arrivals: new Map(), nowMs: 1234, paused: true, reducedMotion: true });
}

describe("observation station", () => {
  it("offers all four named native expand buttons against the same frame", () => {
    const expand = vi.fn(), returnToRoom = vi.fn();
    const { container } = render(<ObservationStationPanel frame={frame()} assessment={false} onExpandMonitor={expand} onReturnToInterview={returnToRoom} />);
    expect(screen.getByText(EX4_TEXT)).toBeTruthy();
    expect(container.querySelector("canvas, iframe, dialog")).toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(4);
    for (const [index, style] of WORK_STYLES.entries()) {
      const button = screen.getByRole("button", { name: `Expand ${STYLE_NAMES[style]}` });
      button.focus(); expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      expect(expand).toHaveBeenNthCalledWith(index + 1, style);
    }
    fireEvent.click(screen.getByRole("button", { name: "Return to interview room" }));
    expect(returnToRoom).toHaveBeenCalledOnce();
  });
  it("suppresses a stale practice frame with the explicit assessment boundary", () => {
    const stale = frame();
    expect(stale.cards).toBe(1);
    const { container } = render(<ObservationStationPanel frame={stale} assessment onExpandMonitor={vi.fn()} onReturnToInterview={vi.fn()} />);
    expect(screen.getByText("Assessment: coaching activity and content are withheld.")).toBeTruthy();
    expect(screen.getAllByText("Coaching withheld in assessment")).toHaveLength(4);
    expect(container.textContent).not.toContain("1 cards");
    expect(container.textContent).not.toContain("1 coaching cards");
    expect(container.querySelectorAll("[data-status='withheld']")).toHaveLength(4);
  });
});
