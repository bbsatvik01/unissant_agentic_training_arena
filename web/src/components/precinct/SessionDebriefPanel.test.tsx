// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor } from "../../lib/world/recording";
import { SessionDebriefPanel } from "./SessionDebriefPanel";

const parsed = parseRecording(raw);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const recording = parsed.recording;
afterEach(cleanup);
describe("station debrief content", () => {
  it("does not invent a score while no published debrief exists", () => {
    render(<SessionDebriefPanel debrief={null} view={null} recorded={false} />);
    expect(screen.getByText("No score has been computed for your current exploration.")).toBeTruthy();
    expect(screen.queryByText("/ 100")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("labels a saved score as belonging to that run and leaves modal focus to the parent", () => {
    const end = seek(recording, startCursor(recording), recording.durationMs);
    render(<SessionDebriefPanel debrief={recording.debrief} view={end.state.view} recorded />);
    expect(screen.getByText("Published debrief from this recorded run")).toBeTruthy();
    expect(screen.getByText(/These scores belong only to the loaded recording/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download this debrief JSON" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("renders a missing committed label without assigning a finding", () => {
    if (recording.debrief === null) throw new Error("fixture has no debrief");
    render(<SessionDebriefPanel debrief={{ ...recording.debrief, outcome: { ...recording.debrief.outcome, committed_label: null } }} view={null} recorded={false} />);
    expect(screen.getByText("None committed")).toBeTruthy();
    expect(screen.getByText("The transcript is unavailable.")).toBeTruthy();
  });
});
