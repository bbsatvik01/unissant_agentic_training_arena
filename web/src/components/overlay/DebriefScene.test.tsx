// @vitest-environment jsdom
/**
 * The debrief scene renders the published document's own figures (S6 4.7; FE-DEB-2, FE-DEB-3): detection true
 * positives against flags and against events (zero denominators as "undefined"), subject-realism failures by check,
 * the provenance line, the subject's role, and the annotated transcript with answers, flags and releases.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import raw from "../../fixtures/recordings/F01-truthful.json";
import type { ScoredDebrief } from "../../lib/contracts/generated/types";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor } from "../../lib/world/recording";
import { DebriefScene } from "./DebriefScene";

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
});
