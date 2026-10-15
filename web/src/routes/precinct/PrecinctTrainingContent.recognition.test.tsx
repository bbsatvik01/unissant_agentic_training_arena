// @vitest-environment jsdom
/** The physical surface receives the same opened canonical publication, with no parallel data request. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import boards from "../../fixtures/leaderboard.example.json";
import { CASES } from "../../lib/world/cases";
import { createPrecinctStationReads, type PrecinctStationReads } from "../../lib/api/precinctStationReads";
import type { TournamentPoll } from "../../lib/contracts/generated/types";
import type { RecognitionRead } from "../../lib/precinct/boardSurfaces";
import { PrecinctTrainingContent, type TrainingStationSession } from "./PrecinctTrainingContent";
import { usePrecinctStations } from "./usePrecinctStations";
import type { RecognitionSink } from "./useRecognitionReadBridge";

const tournamentId = "7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f";
function poll(state: "sealed" | "revealed"): TournamentPoll {
  return { visibility: "events", last: 1, frames: [{ v: 1, seq: 1, scope: "tournament", scope_id: tournamentId, ts: "2026-10-15T09:00:00Z", type: "tournament.status", data: { state } }] };
}
function Harness({ session, recognition, assessment = false }: { readonly session: TrainingStationSession; readonly recognition: RecognitionSink; readonly assessment?: boolean }) {
  const stations = usePrecinctStations({ caseId: null, panel: "trophies", assessmentActive: assessment, paused: false });
  return <MemoryRouter><PrecinctTrainingContent kind="trophies" session={session} stations={stations} assessmentActive={assessment} motionOff recognition={recognition}
    onSelectCase={() => undefined} onNavigate={() => undefined} onReplay={() => undefined} onDesk={() => undefined} /></MemoryRouter>;
}
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("canonical trophy read to physical recognition bridge", () => {
  it("withholds an accidental published body until reveal and clears it before another publication resolves", async () => {
    let revealed = false;
    const api = {
      progress: vi.fn<PrecinctStationReads["progress"]>(), readDebrief: vi.fn<PrecinctStationReads["readDebrief"]>(),
      tournaments: vi.fn<PrecinctStationReads["tournaments"]>().mockResolvedValue({ tournaments: [{ id: tournamentId, name: "Contract test tournament", split: "hidden", status: "sealed" }] }),
      tournament: vi.fn<PrecinctStationReads["tournament"]>().mockResolvedValue({ status: "sealed" }),
      tournamentEvents: vi.fn<PrecinctStationReads["tournamentEvents"]>().mockImplementation(() => Promise.resolve(poll(revealed ? "revealed" : "sealed"))),
      leaderboard: vi.fn<PrecinctStationReads["leaderboard"]>().mockImplementation((_id, board) => Promise.resolve(board === "assistant" ? boards.assistant : boards.subject)),
    } satisfies PrecinctStationReads;
    const onRead = vi.fn<(read: RecognitionRead) => void>();
    const session: TrainingStationSession = { backend: "connected", me: { user_id: "owned-test-user" }, stationReads: createPrecinctStationReads(api), cases: CASES, selectedCase: null };
    const { rerender, unmount } = render(<Harness session={session} recognition={{ scope: "current-source", onRead }} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.tournaments).toHaveBeenCalledTimes(1); expect(api.tournament).not.toHaveBeenCalled(); expect(api.leaderboard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Published tournament"), { target: { value: tournamentId } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onRead.mock.lastCall?.[0].ledger).toBe("sealed"); expect(onRead.mock.lastCall?.[0].assistant).toBeNull();
    revealed = true; await act(() => vi.advanceTimersByTimeAsync(2000));
    const publication = onRead.mock.lastCall?.[0];
    expect(publication?.ledger).toBe("revealed"); expect(publication?.state).toEqual({ kind: "published", tournamentId, label: null });
    expect(publication?.assistant?.board).toBe("assistant"); expect(publication?.scope).toBe("current-source");
    api.leaderboard.mockImplementation(() => new Promise(() => undefined));
    onRead.mockClear(); fireEvent.change(screen.getByLabelText("Board publication"), { target: { value: "original" } });
    expect(onRead.mock.calls[0]?.[0]).toEqual({ scope: "current-source", tournamentId, label: "original", ledger: "pending", state: null, assistant: null });
    expect(onRead.mock.lastCall?.[0].assistant).toBeNull();
    const previousReads = api.leaderboard.mock.calls.length;
    onRead.mockClear(); rerender(<Harness session={session} recognition={{ scope: "next-source", onRead }} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onRead.mock.lastCall?.[0].tournamentId).toBeNull(); expect(onRead.mock.lastCall?.[0].assistant).toBeNull();
    expect(api.leaderboard).toHaveBeenCalledTimes(previousReads); expect(api.tournaments).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText<HTMLSelectElement>("Published tournament").value).toBe("");
    rerender(<Harness session={session} recognition={{ scope: "assessment-source", onRead }} assessment />);
    await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(api.leaderboard).toHaveBeenCalledTimes(previousReads);
    expect(api.progress).not.toHaveBeenCalled(); expect(api.readDebrief).not.toHaveBeenCalled();
    unmount();
  });
});
