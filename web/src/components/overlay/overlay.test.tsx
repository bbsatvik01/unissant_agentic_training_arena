// @vitest-environment jsdom
/**
 * Overlay smoke tests: untrusted text stays text (FE-ROOM-2), the coach region is a placeholder in assessment
 * (FE-ROOM-3), an unverifiable quote is marked as such (FE-COACH-3), and the finding form keeps Confirm disabled
 * until the draft is complete (FE-FIND-1) and always shows the EX-4 text (FE-FIND-3).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EX4_TEXT } from "../../lib/copy/ex4";
import { initialTrialState, trialReducer, type TrialView } from "../../lib/trial/trialReducer";
import { LogBuilder, snapshot } from "../../test/trial-log";
import { CoachPanel } from "./CoachPanel";
import { FindingPanel } from "./FindingPanel";
import { Transcript } from "./Transcript";

beforeAll(() => {
  // jsdom has no layout, so no scrolling; the transcript scrolls its newest turn into view.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
});

function viewOf(log: LogBuilder, mode: "practice" | "assessment" = "practice"): TrialView {
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot({ mode }) });
  for (const frame of log.frames) state = trialReducer(state, { type: "frame", frame });
  if (state.view === null) throw new Error("no view");
  return state.view;
}

describe("overlay", () => {
  it("renders subject text as literal text, never as HTML", () => {
    const hostile = '<img src=x onerror="alert(1)"> [link](http://x)';
    const view = render(
      <Transcript
        turns={[{ turn_no: 1, question: "Q?", source: "investigator", answer: hostile, partial: false, committed_at: null }]}
        released={[]}
        subjectName="S"
        highlighted={new Set()}
        quote={null}
        focusTurn={null}
      />,
    );
    expect(view.container.querySelector("img")).toBe(null);
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(screen.getByRole("log")).toBeTruthy();
  });

  it("shows only the placeholder in assessment", () => {
    const view = viewOf(new LogBuilder("assessment").ask(), "assessment");
    render(<CoachPanel view={view} released={[]} documents={[]} onCite={() => undefined} onUseQuestion={null} />);
    expect(screen.getByText("Coaching is saved for your debrief.")).toBeTruthy();
  });

  it("marks a flag whose quote is not in the cited answer", () => {
    const view = viewOf(new LogBuilder("practice").ask());
    expect(view.cards).toHaveLength(1);
    render(<CoachPanel view={view} released={[]} documents={[]} onCite={() => undefined} onUseQuestion={null} />);
    expect(screen.getByRole("button", { name: /Quote not found in T1/ })).toBeTruthy();
    expect(screen.getByText("Evasive wording alone does not prove a violation.")).toBeTruthy();
  });

  it("keeps Confirm disabled until the draft is complete, and shows EX-4", () => {
    const turns = [{ turn_no: 1, question: "Q?", source: "investigator" as const, answer: "A.", partial: false, committed_at: null }];
    render(<FindingPanel committed={null} hash={null} turns={turns} records={[]} onConfirm={() => undefined} disabledReason="" />);
    const confirm = screen.getByRole("button", { name: "Confirm finding" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(EX4_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Truthful" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unlikely" } });
    fireEvent.click(screen.getByRole("radio", { name: "moderate" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "T1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale" }), { target: { value: "Corroborated by the log." } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });
});
