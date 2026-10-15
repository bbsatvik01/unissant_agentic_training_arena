// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import boards from "../../fixtures/leaderboard.example.json";
import { CASES, RECORDED_CASE_ID } from "../../lib/world/cases";
import { parseRecording } from "../../lib/world/parseRecording";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { ApiError } from "../../lib/api/client";
import { createPrecinctStationReads, type PrecinctStationReads } from "../../lib/api/precinctStationReads";
import type { TournamentPoll } from "../../lib/contracts/generated/types";
import type { TrainingStationId } from "../../lib/precinct/stationSources";
import { PrecinctTrainingContent, type TrainingStationSession, type StationReplayRequest } from "./PrecinctTrainingContent";
import { usePrecinctStations } from "./usePrecinctStations";

const parsed = parseRecording(raw);
if (!parsed.ok || parsed.recording.debrief === null) throw new Error("Expected validated test fixture");
const published = parsed.recording.debrief;
const row = { session_id: published.session_id, trial_id: "owned-trial", phase: "practice", mode: "practice", voice: false, status: "finalized", created_at: "2026-10-15", case_title: "Owned synthetic case" };
const T = "7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f";
function poll(state: "sealed" | "revealed"): TournamentPoll { return { visibility: "events", last: 1, frames: [{ v: 1, seq: 1, scope: "tournament", scope_id: T, ts: "2026-10-15T09:00:00Z", type: "tournament.status", data: { state } }] }; }
function api() {
  return {
    progress: vi.fn<PrecinctStationReads["progress"]>().mockResolvedValue({ sessions: [row], kpi1: null }),
    readDebrief: vi.fn<PrecinctStationReads["readDebrief"]>().mockResolvedValue(published),
    tournaments: vi.fn<PrecinctStationReads["tournaments"]>().mockResolvedValue({ tournaments: [{ id: T, name: "Local test tournament", split: "hidden", status: "sealed" }] }),
    tournament: vi.fn<PrecinctStationReads["tournament"]>().mockResolvedValue({ status: "sealed" }),
    tournamentEvents: vi.fn<PrecinctStationReads["tournamentEvents"]>().mockResolvedValue(poll("sealed")),
    leaderboard: vi.fn<PrecinctStationReads["leaderboard"]>().mockRejectedValue(new ApiError(409, "not_revealed", "/api/leaderboards/test")),
  };
}
const offline: TrainingStationSession = { backend: "offline", me: null, stationReads: null, cases: CASES, selectedCase: null };
const onSelect = vi.fn(); const onNavigate = vi.fn(); const onReplay = vi.fn<(request: StationReplayRequest) => void>(); const onDesk = vi.fn();
function Harness({ kind, session = offline, assessment = false }: { readonly kind: TrainingStationId; readonly session?: TrainingStationSession; readonly assessment?: boolean }) {
  const stations = usePrecinctStations({ caseId: session.selectedCase?.case_id ?? null, panel: kind, assessmentActive: assessment, paused: false });
  return <MemoryRouter><div role="dialog"><PrecinctTrainingContent kind={kind} session={session} stations={stations} assessmentActive={assessment} motionOff onSelectCase={onSelect} onNavigate={onNavigate} onReplay={onReplay} onDesk={onDesk} /></div></MemoryRouter>;
}
const connected = (reads: PrecinctStationReads, userId = "local-user"): TrainingStationSession => ({ ...offline, backend: "connected", me: { user_id: userId }, stationReads: createPrecinctStationReads(reads) });
beforeEach(() => { onSelect.mockReset(); onNavigate.mockReset(); onReplay.mockReset(); onDesk.mockReset(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native-dialog training station integration", () => {
  it("opens every offline station without probing a backend, starting audio, loading a recording or adding another dialog", () => {
    const network = vi.fn(); const audio = vi.fn(); vi.stubGlobal("fetch", network); vi.stubGlobal("speechSynthesis", { speak: audio });
    const get = vi.spyOn(Storage.prototype, "getItem"); const set = vi.spyOn(Storage.prototype, "setItem");
    const { rerender } = render(<Harness kind="cases" />);
    for (const kind of ["cases", "trophies", "archive", "skills", "coach_lab", "instructor", "drill", "methodology"] as const) {
      rerender(<Harness kind={kind} />); expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(screen.getAllByText(EX4_TEXT).length).toBeGreaterThan(0);
    }
    expect(network).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled(); expect(onReplay).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Read trust & methodology" }).getAttribute("href")).toBe("/trust/methodology");
  });
  it("replaces the temporary board while preserving the route selectCase wrapper and desk navigation", () => {
    const { rerender } = render(<Harness kind="cases" />);
    expect(screen.getAllByRole("button", { name: "Select case" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Select case" })); expect(onSelect).toHaveBeenCalledWith(RECORDED_CASE_ID); expect(onReplay).not.toHaveBeenCalled();
    expect(screen.getAllByText("Preview only").length).toBeGreaterThan(0);
    rerender(<Harness kind="cases" session={{ ...offline, selectedCase: CASES.find((card) => card.case_id === RECORDED_CASE_ID) ?? null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to your desk" })); expect(onDesk).toHaveBeenCalledOnce();
    rerender(<Harness kind="cases" assessment />);
    fireEvent.click(screen.getByRole("button", { name: "Select case" })); expect(onSelect).toHaveBeenCalledOnce();
  });
  it("offers the actual two neutral bundled tapes separately from empty own history, only after a click", () => {
    render(<Harness kind="archive" />);
    expect(screen.getByText(/They are not your sessions and never count/)).toBeTruthy();
    expect(screen.getByText(/Dates are not supplied/)).toBeTruthy(); expect(onReplay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load Recorded coached interview · Gemini" }));
    expect(onReplay).toHaveBeenCalledWith({ kind: "bundled", tape: "coached" });
    fireEvent.click(screen.getByRole("button", { name: "Load Bundled example interview" }));
    expect(onReplay).toHaveBeenCalledWith({ kind: "bundled", tape: "example" });
    fireEvent.click(screen.getByRole("button", { name: "Recorded sessions" })); expect(screen.queryByRole("button", { name: "Play recording" })).toBeNull();
  });
  it("never substitutes a bundled score for the user's skill progress and routes primers to records", () => {
    render(<Harness kind="skills" />);
    expect(screen.getAllByText("Not measured")).toHaveLength(5); expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/Bundled and imported recordings never count/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Read the technique primer/ })[3] as HTMLButtonElement);
    expect(onNavigate).toHaveBeenCalledWith("archive");
  });
  it("reads only when a connected data station is opened and shows one matching own published debrief", async () => {
    const reads = api(); const session = connected(reads);
    const { rerender } = render(<Harness kind="cases" session={session} />);
    expect(reads.progress).not.toHaveBeenCalled(); expect(reads.tournaments).not.toHaveBeenCalled();
    rerender(<Harness kind="skills" session={session} />);
    await waitFor(() => { expect(screen.getAllByRole("meter")).toHaveLength(5); });
    expect(reads.readDebrief).toHaveBeenCalledWith(published.session_id);
    expect(screen.getByText(`Your local session ${published.session_id}. Values appear only when its own debrief is published.`)).toBeTruthy();
    expect(reads.tournaments).not.toHaveBeenCalled();
  });
  it("refuses a different session's valid published score and shows scoring without manufactured zeroes", async () => {
    const reads = api(); reads.progress.mockResolvedValue({ sessions: [{ ...row, session_id: "other-owned-session" }], kpi1: null });
    const { rerender } = render(<Harness kind="skills" session={connected(reads)} />);
    await waitFor(() => { expect(reads.readDebrief).toHaveBeenCalledWith("other-owned-session"); });
    await act(async () => { await Promise.resolve(); }); expect(screen.queryByRole("meter")).toBeNull(); expect(screen.getAllByText("Not measured")).toHaveLength(5);
    rerender(<Harness kind="skills" />); reads.readDebrief.mockResolvedValue({ status: "scoring" });
    rerender(<Harness kind="skills" session={connected(reads)} />);
    await waitFor(() => { expect(screen.getAllByText("Scoring in progress")).toHaveLength(5); }); expect(screen.queryByRole("meter")).toBeNull();
  });
  it("drops late own-history replies on disconnect or account change and reopens with a fresh read", async () => {
    const reads = api(); let resolve: (value: unknown) => void = () => undefined;
    reads.progress.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<Harness kind="skills" session={connected(reads, "first-user")} />);
    rerender(<Harness kind="skills" />);
    await act(async () => { resolve({ sessions: [row], kpi1: null }); await Promise.resolve(); }); expect(reads.readDebrief).not.toHaveBeenCalled();
    const second = api(); second.progress.mockResolvedValue({ sessions: [], kpi1: null });
    rerender(<Harness kind="skills" session={connected(second, "second-user")} />);
    await waitFor(() => { expect(screen.getByText("You have no local sessions yet.")).toBeTruthy(); });
    expect(screen.queryByText(new RegExp(published.session_id))).toBeNull(); expect(screen.queryByRole("meter")).toBeNull();
    rerender(<Harness kind="cases" session={connected(second, "second-user")} />);
    rerender(<Harness kind="skills" session={connected(second, "second-user")} />); expect(second.progress).toHaveBeenCalledTimes(2);
  });
  it.each([404, 500])("reports history failure %i without demonstration scores", async (status) => {
    const reads = api(); reads.progress.mockRejectedValue(new ApiError(status, null, "/api/progress"));
    render(<Harness kind="skills" session={connected(reads)} />);
    await waitFor(() => { expect(screen.getByRole("status").textContent).toContain(status === 404 ? "does not offer session history" : "could not be read"); });
    expect(screen.queryByRole("meter")).toBeNull();
  });
  it("plays only actual ended text sessions from the participant's own history", async () => {
    const reads = api(); reads.progress.mockResolvedValue({ sessions: [row, { ...row, session_id: "unfinished", trial_id: "unfinished", status: "running" }, { ...row, session_id: "voice", trial_id: "voice", voice: true }], kpi1: null });
    render(<Harness kind="archive" session={connected(reads)} />);
    await waitFor(() => { expect(reads.readDebrief).toHaveBeenCalled(); });
    fireEvent.click(screen.getByRole("button", { name: "Recorded sessions" }));
    expect(screen.getAllByRole("button", { name: "Recording unavailable" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Play recording" })); expect(onReplay).toHaveBeenCalledWith({ kind: "local", trialId: "owned-trial" });
  });
  it("requires tournament choice, keeps sealed scores hidden, and uses canonical reveal/published boards", async () => {
    vi.useFakeTimers(); const reads = api(); let revealed = false;
    reads.tournamentEvents.mockImplementation(() => Promise.resolve(poll(revealed ? "revealed" : "sealed")));
    // Even an accidental published response cannot override the sealed ledger.
    reads.leaderboard.mockImplementation((_id, board) => Promise.resolve(board === "assistant" ? boards.assistant : boards.subject));
    const { unmount } = render(<Harness kind="trophies" session={connected(reads)} />);
    await act(() => vi.advanceTimersByTimeAsync(0)); expect(reads.tournament).not.toHaveBeenCalled(); expect(reads.leaderboard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Published tournament"), { target: { value: T } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Results are sealed until reveal.")).toBeTruthy(); expect(screen.queryByRole("table")).toBeNull();
    revealed = true; await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("Eligibility gates, before any rank")).toBeTruthy(); expect(screen.queryByText("Example data. Not a result.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Board publication"), { target: { value: "original" } });
    await act(() => vi.advanceTimersByTimeAsync(0)); expect(reads.leaderboard).toHaveBeenCalledWith(T, "assistant", "original");
    unmount(); const calls = reads.tournamentEvents.mock.calls.length; await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(reads.tournamentEvents).toHaveBeenCalledTimes(calls);
  });
  it.each(["archive", "skills", "trophies", "coach_lab", "instructor", "drill"] as const)("withholds %s during assessment before any hook read or demo control", (kind) => {
    const reads = api(); render(<Harness kind={kind} session={connected(reads)} assessment />);
    expect(screen.getByRole("status").textContent).toContain("unavailable during an assessment"); expect(screen.queryByRole("button")).toBeNull();
    expect(reads.progress).not.toHaveBeenCalled(); expect(reads.tournaments).not.toHaveBeenCalled(); expect(onReplay).not.toHaveBeenCalled();
  });
  it("keeps Coach Lab and instructor explicit local demos even with a connected backend", () => {
    const reads = api(); const session = connected(reads); const { rerender } = render(<Harness kind="coach_lab" session={session} />);
    expect(screen.getByText("Coach Lab is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Explore a local demonstration" })); expect(screen.getByRole("status").textContent).toContain("fictional display examples");
    rerender(<Harness kind="instructor" session={session} />); expect(screen.getByText("Instructor access is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the local instructor demo" })); expect(screen.getByText(/No instructor permission is implied/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Practice objective"), { target: { value: "Ask neutrally" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare local assignment draft" }));
    expect(screen.getByRole("status").textContent).toContain("Nothing was assigned or sent");
    expect(reads.progress).not.toHaveBeenCalled(); expect(reads.tournaments).not.toHaveBeenCalled();
  });
});
