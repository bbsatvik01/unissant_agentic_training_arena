// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivePanel, CaseBoardPanel, SkillProgressPanel } from "./TrainingStations";
import { CoachLabPanel, InstructorPanel, type LocalTimelineDraft } from "./LabStations";
import { DailyDrillPanel } from "./DailyDrillPanel";
import { TrophyWallPanel } from "./TrophyWallPanel";
import { INITIAL_DRILL } from "../../lib/precinct/dailyDrill";
import { LOCAL_COACH_LAB, type LocalAssignmentDraft } from "../../lib/precinct/stationLab";
import type { CaseBoardEntry, ArchiveTape } from "../../lib/precinct/trainingStations";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { parseBoard } from "../../lib/arena/leaderboard";
import boards from "../../fixtures/leaderboard.example.json";

const card = { case_id: "PUBLIC-A", title: "Public test case", objective: "Establish the documented sequence.", domain: "Access", difficulty_level: 1, subject: { display_name: "Sample subject", position: "Staff" }, facility: "Training site", initial_documents: 2, requestable_records: 1 };
const entries: readonly CaseBoardEntry[] = [
  { card, availability: { kind: "available", detail: "Bundled recording available" } },
  { card: { ...card, case_id: "PUBLIC-B", title: "Locked case", difficulty_level: 2 }, availability: { kind: "locked", detail: "Complete the assigned prerequisite, as supplied by the training source." } },
  { card: { ...card, case_id: "PUBLIC-C", title: "Preview case", difficulty_level: 3 }, availability: { kind: "preview", detail: "No local recording" } },
];
const tape: ArchiveTape = { session: { session_id: "session", trial_id: "trial", phase: "practice", mode: "practice", voice: false, status: "finalized", created_at: "2026-10-15", case_title: "Recorded practice" }, replayAvailable: true, sourceLabel: "Bundled recording" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("training station panels", () => {
  it("uses the parent's dialog and exact ground rule, and selects only explicitly available cases", () => {
    const onSelect = vi.fn();
    render(<div role="dialog"><CaseBoardPanel entries={entries} selectedCaseId={null} onSelect={onSelect} /></div>);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText(EX4_TEXT).textContent).toBe(EX4_TEXT);
    fireEvent.click(screen.getByRole("button", { name: "Case locked" }));
    fireEvent.click(screen.getByRole("button", { name: "Session unavailable" }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Select case" }));
    expect(onSelect).toHaveBeenCalledWith("PUBLIC-A");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "locked" } });
    expect(screen.queryByText("Public test case")).toBeNull();
    expect(screen.getByText("Locked case")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Difficulty"), { target: { value: "1" } });
    expect(screen.getByText(/No cases match/)).toBeTruthy();
  });
  it("does not change cases during assessment, or invent available cases", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<CaseBoardPanel entries={entries} selectedCaseId={null} onSelect={onSelect} assessmentActive />);
    fireEvent.click(screen.getByRole("button", { name: "Select case" }));
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<CaseBoardPanel entries={[]} selectedCaseId={null} onSelect={onSelect} />);
    expect(screen.getByText(/No public case files/)).toBeTruthy();
  });
  it("leaves all five skill scores unmeasured when no published debrief exists", () => {
    const onOpenPrimer = vi.fn();
    render(<SkillProgressPanel score={undefined} sourceLabel="No published debrief" onOpenPrimer={onOpenPrimer} />);
    expect(screen.getAllByText("Not measured")).toHaveLength(5);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getAllByText("KPI-1 not measured")).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: /Read the technique primer/ })[0] as HTMLButtonElement);
    expect(onOpenPrimer).toHaveBeenCalledWith("D1");
  });
  it("withholds skill guidance during assessment", () => {
    render(<SkillProgressPanel score={{ kind: "scored", total: 75, dimensions: [{ id: "D1", score: 3 }], reason: null }} sourceLabel="Published practice debrief" onOpenPrimer={vi.fn()} assessmentActive />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("unavailable during an assessment");
  });
  it("shows only the supplied debrief figures and anchors", () => {
    render(<SkillProgressPanel score={{ kind: "scored", total: 75, dimensions: [{ id: "D1", score: 3 }], reason: null }} sourceLabel="Published practice debrief" onOpenPrimer={vi.fn()} />);
    expect(screen.getByRole("meter").getAttribute("value")).toBe("3");
    expect(screen.getByText(/One kind of lapse/)).toBeTruthy();
    expect(screen.queryByText("75")).toBeNull();
  });
  it("offers primers and only supplied playable recordings without starting playback automatically", () => {
    const onReplay = vi.fn();
    render(<ArchivePanel tapes={[tape, { ...tape, session: { ...tape.session, session_id: "running", status: "running", case_title: "Unfinished run" } }]} onReplay={onReplay} selectedPrimer="D4" />);
    expect(screen.getByText("What record could help us check that explanation?", { exact: false })).toBeTruthy();
    expect(onReplay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recorded sessions" }));
    fireEvent.click(screen.getByRole("button", { name: "Recording unavailable" }));
    expect(onReplay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
    expect(onReplay).toHaveBeenCalledWith("trial");
  });
  it("withholds primers and archived replay during assessment", () => {
    render(<ArchivePanel tapes={[tape]} onReplay={vi.fn()} assessmentActive />);
    fireEvent.click(screen.getByRole("button", { name: "Recorded sessions" }));
    expect(screen.queryByRole("button", { name: "Play recording" })).toBeNull();
    expect(screen.queryByText("Walk me through what you did when you arrived.")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("unavailable during an assessment");
  });
  it("renders a sealed trophy wall without leaking supplied board rows", () => {
    render(<TrophyWallPanel state={{ kind: "sealed" }} assistant={parseBoard(boards.assistant)} subject={parseBoard(boards.subject)} motionOff />);
    expect(screen.getByText("Results are sealed until reveal.")).toBeTruthy();
    expect(screen.queryByText("Evidence Strategist")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("reuses published gate, rank, interval and detail content with gates first", () => {
    render(<TrophyWallPanel state={{ kind: "example" }} assistant={parseBoard(boards.assistant)} subject={parseBoard(boards.subject)} motionOff />);
    expect(screen.getByText("Example data. Not a result.")).toBeTruthy();
    const gate = screen.getByText("Eligibility gates, before any rank");
    const rank = screen.getByRole("columnheader", { name: "Rank" });
    expect(gate.compareDocumentPosition(rank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/subjects are compared, not ranked/)).toBeTruthy();
  });
  it.each(["missing", "error"] as const)("states %s leaderboard data honestly", (kind) => {
    render(<TrophyWallPanel state={{ kind }} assistant={null} subject={null} motionOff />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(kind === "missing" ? "No leaderboard has been published for this tournament." : "The leaderboards could not be read. Try again later.")).toBeTruthy();
  });
  it("shows unavailable Coach Lab before an explicitly requested local demo", () => {
    const show = vi.fn();
    const { rerender } = render(<CoachLabPanel source={{ kind: "unavailable", reason: "No verified local adapter." }} onShowLocalDemo={show} />);
    expect(screen.queryByText("Neutral inquiry / v1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Explore a local demonstration" }));
    expect(show).toHaveBeenCalledOnce();
    rerender(<CoachLabPanel source={{ kind: "local-demo", view: LOCAL_COACH_LAB }} onShowLocalDemo={show} />);
    expect(screen.getByRole("status").textContent).toContain("fictional display examples");
    fireEvent.click(screen.getByRole("button", { name: /Neutral inquiry \/ v2/ }));
    expect(screen.getByText("Test the alternative")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Questioning quality after: 68" })).toBeTruthy();
    rerender(<CoachLabPanel source={{ kind: "local-demo", view: LOCAL_COACH_LAB }} onShowLocalDemo={show} assessmentActive />);
    expect(screen.queryByText("Test the alternative")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });
  it("keeps instructor demo actions as local drafts with exact annotation fields", () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      const [assignments, setAssignments] = useState<readonly LocalAssignmentDraft[]>([]);
      const [annotations, setAnnotations] = useState<readonly LocalTimelineDraft[]>([]);
      return <InstructorPanel demoEnabled={enabled} cases={[card]} assignments={assignments} annotations={annotations} onEnableDemo={() => { setEnabled(true); }} onAssignmentDraft={(draft) => { setAssignments([...assignments, draft]); }} onAnnotationDraft={(draft) => { setAnnotations([...annotations, draft]); }} />;
    }
    render(<Harness />);
    expect(screen.queryByLabelText("Sample trainee")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the local instructor demo" }));
    fireEvent.change(screen.getByLabelText("Practice objective"), { target: { value: "Ask one neutral follow-up" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare local assignment draft" }));
    expect(screen.getByRole("status").textContent).toContain("Nothing was assigned or sent");
    fireEvent.change(screen.getByLabelText("Timestamp in milliseconds"), { target: { value: "1250" } });
    fireEvent.change(screen.getByLabelText("Note for the sample timeline"), { target: { value: "Check the released record" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare local timeline draft" }));
    expect(screen.getByText(/1250 ms/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Nothing was posted");
    fireEvent.click(screen.getByRole("button", { name: "Preview observation" }));
    expect(screen.getByText("LOCAL-DEMO-TRIAL · NOT LIVE")).toBeTruthy();
    expect(network).not.toHaveBeenCalled();
  });
  it("leaves daily-drill lifecycle to the owner and blocks it during assessments", () => {
    const onAction = vi.fn();
    const { rerender } = render(<DailyDrillPanel caseCard={card} state={INITIAL_DRILL} nowMs={1000} onAction={onAction} />);
    expect(screen.getByText("3:00")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start 3-minute warm-up" }));
    expect(onAction).toHaveBeenCalledWith({ type: "start", nowMs: 1000 });
    fireEvent.change(screen.getByLabelText("Your neutral opening question"), { target: { value: "What happened?" } });
    expect(onAction).toHaveBeenLastCalledWith({ type: "write", field: "question", text: "What happened?" });
    rerender(<DailyDrillPanel caseCard={card} state={INITIAL_DRILL} nowMs={1000} onAction={onAction} assessmentActive />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(within(screen.getByRole("status")).getByText(/unavailable during an assessment/)).toBeTruthy();
  });
});
