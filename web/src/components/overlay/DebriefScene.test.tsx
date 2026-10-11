// @vitest-environment jsdom
/**
 * The debrief scene renders the published document's own figures (S6 4.7; FE-DEB-2, FE-DEB-3): detection true
 * positives against flags and against events (zero denominators as "undefined"), subject-realism failures by check,
 * the provenance line, the subject's role, and the annotated transcript with answers, flags and releases.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import type { Debrief, ScoredDebrief, TrialSnapshot } from "../../lib/contracts/generated/types";
import { initialTrialState, trialReducer } from "../../lib/trial/trialReducer";
import { fixture } from "../../test/wire-fixtures";
import { cardFor, snapshot } from "../../test/trial-log";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { debriefExport, exportName } from "../../lib/world/debrief";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor } from "../../lib/world/recording";
import { DebriefScene } from "./DebriefScene";

beforeAll(() => {
  // jsdom has no layout, so no scrolling.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
});

const result = parseRecording(structuredClone(raw));
if (!result.ok) throw new Error("fixture");
const rec = result.recording;
const view = seek(rec, startCursor(rec), rec.durationMs).state.view;
const base = rec.debrief as ScoredDebrief;

const debrief: ScoredDebrief = {
  ...base,
  scorecards: {
    ...base.scorecards,
    detection: { ...base.scorecards.detection, evasion_strict: { tp: 1, flags: 4, events: 2 }, evasion_broad: { tp: 0, flags: 3, events: 0 } },
    subject_realism: { turns: 7, compliant: 5, failures: { F1: 2, F2_F4: 1, F3: 0, F5: 0, F6: 3 } },
  },
  provenance: { ...base.provenance, referee_model_ids: ["gemini-referee-a", "gemini-referee-b"] },
};

function show() {
  render(<DebriefScene debrief={debrief} view={view} documents={rec.case.initial_documents} reducedMotion onClose={() => undefined} />);
}

describe("DebriefScene", () => {
  it("shows detection against flags and against events, zero denominators as undefined", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Detection" }));
    expect(screen.getByText("1 of 2 labeled events; 1 of 4 of its flags matched")).toBeTruthy();
    expect(screen.getByText("undefined labeled events; 0 of 3 of its flags matched")).toBeTruthy();
  });

  it("shows subject-realism failures by check", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Learning" }));
    expect(screen.getByText("5 of 7 turns within its role")).toBeTruthy();
    expect(screen.getByText(/F1 canonical consistency 2, F2\/F4 disclosure policy 1, F3 knowledge bounds 0, F5 platform integrity 0, F6 in character 3/)).toBeTruthy();
  });

  it("shows the provenance line, the role and the server's total", () => {
    show();
    expect(screen.getByText("gemini-referee-a, gemini-referee-b")).toBeTruthy();
    expect(screen.getByText(debrief.outcome.role)).toBeTruthy();
    expect(document.querySelector(".total [data-count]")?.textContent).toBe(String(debrief.rubric.total));
  });

  it("annotates the transcript with answers, flags with citation chips and the records released after a turn", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
    const first = view?.turns[0];
    expect(first?.answer).toBeTruthy();
    expect(screen.getByText(first?.answer ?? "")).toBeTruthy();
    expect(document.querySelectorAll(".review .flag .chip").length).toBeGreaterThan(0);
    const released = view?.released[0];
    expect(released).toBeDefined();
    expect(document.querySelector(`#review-T${String(released?.released_at_turn)} .release-marker`)?.textContent).toContain(released?.record_id ?? "?");
  });

  it("a citation chip moves focus to its turn and marks the quote there", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
    const chip = document.querySelector<HTMLButtonElement>('.review .chip[data-cite="ok"]');
    if (chip === null) throw new Error("no verified chip");
    fireEvent.click(chip);
    const target = document.activeElement;
    expect(target?.classList.contains("review-item")).toBe(true);
    expect(target?.getAttribute("data-cited")).toBe("true");
    const mark = target?.querySelector("mark");
    expect(mark?.textContent).toBeTruthy();
    expect(target?.textContent).toContain(mark?.textContent ?? "?");
  });

  it("shows a voice session's stored exchanges, not scored (FE-DEB-6)", () => {
    const snapshot = fixture("snapshot:voice") as TrialSnapshot;
    const voiceView = trialReducer(initialTrialState(), { type: "snapshot", snapshot }).view;
    const unscored = fixture("debrief:unscored") as Debrief;
    render(<DebriefScene debrief={unscored} view={voiceView} documents={[]} reducedMotion onClose={() => undefined} />);
    expect(screen.getAllByText("Voice practice: not scored.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Exchanges" }));
    const firstLine = snapshot.voice_exchanges[0]?.lines[0];
    expect(firstLine).toBeDefined();
    expect(screen.getByText(firstLine?.text ?? "?")).toBeTruthy();
    expect(screen.queryByText("No questions were asked.")).toBeNull();
  });

  it("exports the published document with EX-4, named by session", () => {
    const parsed = JSON.parse(debriefExport(debrief)) as { ex4: string; debrief: unknown };
    expect(parsed.ex4).toBe(EX4_TEXT);
    expect(parsed.debrief).toEqual(debrief);
    expect(exportName(debrief)).toBe(`debrief-${debrief.session_id}.json`);
  });

  it("prints all four views under the EX-4 header, and only while printing", () => {
    show();
    let printed = "";
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      printed = document.querySelector(".debrief-print")?.textContent ?? "";
    });
    expect(document.querySelector(".debrief-print")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(printed.startsWith(EX4_TEXT)).toBe(true);
    for (const heading of ["Scores", "Questions", "Detection", "Learning"]) expect(printed).toContain(heading);
    expect(printed).toContain("1 of 2 labeled events");
    expect(document.querySelector(".debrief-print")).toBeNull();
    print.mockRestore();
  });

  it("shows an assessment's withheld coaching once the trial has ended (FE-DEB-4)", () => {
    const turn = { turn_no: 1, question: "What brought you to B-12?", source: "investigator", answer: "A humidity alarm.", partial: false, committed_at: "2026-10-24T14:00:00Z", answer_version: 1, question_seq: 1 } as const;
    const card = { turn_no: 1, card: cardFor(1, 1), event_seq: 3 };
    const ended = snapshot({ mode: "assessment", status: "completed", turns: [turn], cards: [card] });
    const view = trialReducer(initialTrialState(), { type: "snapshot", snapshot: ended }).view;
    expect(view?.cards).toHaveLength(1);
    render(<DebriefScene debrief={debrief} view={view} documents={[]} reducedMotion onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
    expect(screen.getByText("Coach suggested next")).toBeTruthy();
    expect(screen.getByText(card.card.follow_up.question)).toBeTruthy();
  });
});
