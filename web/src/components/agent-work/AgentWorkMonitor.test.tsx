// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogBuilder, snapshot } from "../../test/trial-log";
import { deriveAgentWork, STYLE_NAMES, WORK_STYLES, type WorkFrame } from "../../lib/agent-work/model";
import { initialTrialState, trialReducer } from "../../lib/trial/trialReducer";
import { AgentWorkMonitor } from "./AgentWorkMonitor";

function frame(): WorkFrame {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
  for (const event of new LogBuilder().ask({ releaseAfter: "r:01" }).update(1, "truthful").frames) state = trialReducer(state, { type: "frame", frame: event });
  return deriveAgentWork({ view: state.view, arrivals: new Map([["coach.card:1", 1000]]), nowMs: 1300, paused: false, reducedMotion: false });
}
afterEach(cleanup);

describe("four accessible agent-work screens", () => {
  it.each(WORK_STYLES)("renders %s as its own composition with the same accessible factual record", (style) => {
    const { container } = render(<AgentWorkMonitor frame={frame()} style={style} />);
    expect(screen.getByRole("heading", { name: STYLE_NAMES[style] })).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-labelledby")).toBeTruthy();
    expect(container.querySelector(`[data-scene="${style}"]`)).toBeTruthy();
    expect(screen.getByText("Coaching card · turn 1")).toBeTruthy();
    expect(screen.getByText("Deep review updated · turn 1")).toBeTruthy();
    expect(screen.getByText(/Nervousness, demeanor, accent and stress are never evidence/)).toBeTruthy();
    expect(container.querySelectorAll("animate,animateTransform")).toHaveLength(0);
  });
  it("keeps thumbnail controls named and delegates expansion and style selection", () => {
    const expand = vi.fn();
    const choose = vi.fn();
    const { rerender } = render(<AgentWorkMonitor frame={frame()} style="office" size="thumbnail" onExpand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Agent office" }));
    expect(expand).toHaveBeenCalledOnce();
    expect(screen.queryByText("Recorded work")).toBeNull();
    rerender(<AgentWorkMonitor frame={frame()} style="office" onStyleChange={choose} />);
    fireEvent.click(screen.getByRole("button", { name: "Case board" }));
    expect(choose).toHaveBeenCalledWith("case-board");
    expect(screen.getByRole("button", { name: "Agent office" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("opens the exact existing work item and preserves a text fallback without an inspect callback", () => {
    const inspect = vi.fn();
    const { rerender } = render(<AgentWorkMonitor frame={frame()} style="tower" onInspect={inspect} />);
    fireEvent.click(screen.getByText(/Recorded work/));
    fireEvent.click(screen.getByRole("button", { name: "Coaching card · turn 1" }));
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ id: "card:1", kind: "card", turn: 1 }));
    rerender(<AgentWorkMonitor frame={frame()} style="tower" />);
    expect(screen.queryByRole("button", { name: "Coaching card · turn 1" })).toBeNull();
    expect(screen.getByText("Coaching card · turn 1")).toBeTruthy();
  });
  it("gives each simultaneous thumbnail unique SVG titles and pattern identifiers", () => {
    const value = frame();
    const { container } = render(<>{WORK_STYLES.map((style) => <AgentWorkMonitor key={style} frame={value} style={style} size="thumbnail" />)}</>);
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      for (const id of svg.getAttribute("aria-labelledby")?.split(" ") ?? []) expect(container.querySelector(`[id="${id}"]`)).toBeTruthy();
    }
  });
  it("has no local ticking, and explicitly represents paused and reduced-motion modes", () => {
    vi.useFakeTimers();
    try {
      const value = { ...frame(), paused: true, reducedMotion: true };
      const { container } = render(<AgentWorkMonitor frame={value} style="playhouse" />);
      const before = container.innerHTML;
      vi.advanceTimersByTime(60_000);
      expect(container.innerHTML).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
      expect(container.querySelector("figure")?.dataset['paused']).toBe("true");
      expect(container.querySelector("figure")?.dataset['reducedMotion']).toBe("true");
    } finally { vi.useRealTimers(); }
  });
  it("shows an honest empty state and never invents placeholder work", () => {
    const empty = deriveAgentWork({ view: null, arrivals: new Map(), nowMs: 0, paused: false, reducedMotion: false });
    render(<AgentWorkMonitor frame={empty} style="case-board" />);
    expect(screen.getByText(/No session loaded. Agent work/, { selector: ".awm-caption" })).toBeTruthy();
    expect(screen.getByText("No public work has been filed yet.")).toBeTruthy();
  });
});
