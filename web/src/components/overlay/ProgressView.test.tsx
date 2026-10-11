// @vitest-environment jsdom
/**
 * Progress (S6 4.8): the study steps with the next one, KPI-1 cells "KPI-1 not measured" until the server reports
 * them and "undefined" relative change at a zero baseline (FE-PRG-1), sessions with their published scores and a
 * way to watch them again, the missing-route state, and none of the retention words (FE-PRG-2).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProgressLoad } from "../../lib/progress/progress";
import { ProgressView } from "./ProgressView";

afterEach(() => {
  cleanup();
});

const STUDY = { counterbalance: "AB", ended: { pre: 2, practice: 1, post: 0 }, next_phase: "practice" } as const;
const session = (id: string, phase: "pre" | "practice" | "post", status = "finalized") => ({ session_id: id, trial_id: `t-${id}`, phase, mode: phase === "practice" ? "practice" : "assessment", voice: false, status, created_at: "2026-10-24T14:00:00Z", case_title: null }) as const;
const READY: ProgressLoad = { state: "ready", progress: { sessions: [session("a", "pre"), session("b", "pre"), session("c", "practice"), session("d", "practice", "running")], kpi1: null } };

describe("ProgressView", () => {
  it("shows the study steps, KPI-1 not measured, each session's published score, and Watch again", () => {
    const replay = vi.fn();
    render(
      <ProgressView
        load={READY}
        scores={{ a: { kind: "scored", total: 62, dimensions: [{ id: "D1", score: 3 }], reason: null }, b: "scoring" }}
        study={STUDY}
        onReplay={replay}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("Study: Practice 2 of 3")).toBeTruthy();
    expect(screen.getAllByText("KPI-1 not measured")).toHaveLength(4);
    expect(screen.getByText("62")).toBeTruthy();
    expect(screen.getByText("Scoring")).toBeTruthy();
    expect(screen.getByText("Not finished")).toBeTruthy();
    expect(screen.getAllByText("Pre-test 1").length).toBeGreaterThan(0);
    const watch = screen.getAllByRole("button", { name: "Watch again" });
    expect(watch).toHaveLength(3);
    fireEvent.click(watch[0] as HTMLElement);
    expect(replay).toHaveBeenCalledWith("t-a");
    expect(document.body.textContent).not.toMatch(/streak|don't lose|caught|liars/i);
  });

  it("reads relative change as undefined at a zero baseline (FE-PRG-1)", () => {
    const load: ProgressLoad = { state: "ready", progress: { sessions: [], kpi1: { pre: 0, post: 35, absolute_change: 35, relative_change: null } } };
    render(<ProgressView load={load} scores={{}} study={{ ...STUDY, next_phase: "done", ended: { pre: 2, practice: 3, post: 2 } }} onReplay={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("undefined (baseline 0)")).toBeTruthy();
    expect(screen.getByText("+35")).toBeTruthy();
  });

  it("says plainly when the server has no session history yet", () => {
    render(<ProgressView load={{ state: "missing" }} scores={{}} study={null} onReplay={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Your session history will appear here once the server offers it.")).toBeTruthy();
    expect(screen.queryByText(/Study:/)).toBeNull();
  });
});
