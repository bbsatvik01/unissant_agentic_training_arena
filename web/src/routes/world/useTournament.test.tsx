// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api/client";
import type { TournamentPoll } from "../../lib/contracts/generated/types";
import { fixture } from "../../test/wire-fixtures";
import { useTournament, useTournamentList } from "./useTournament";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

const T = "7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f";

function events(state: string, last: number): TournamentPoll {
  return {
    visibility: "events",
    last,
    frames: [
      { v: 1, seq: last, scope: "tournament", scope_id: T, ts: "2026-10-11T12:00:00Z", type: "tournament.status", data: { state } },
      { v: 1, seq: last, scope: "tournament", scope_id: T, ts: "2026-10-11T12:00:00Z", type: "trial.started", data: { trial_ref: last, trial_id: "22222222-2222-4222-8222-222222222222", pairing: "A1 x S1", track: "replay", block: null } },
    ],
  } as TournamentPoll;
}

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

describe("useTournament (S6 4.9)", () => {
  it("polls a running tournament every 2 s on the ledger cursor and stops after the response that reports revealed", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const answers = [events("running", 5), events("scoring", 9), events("revealed", 12)];
    const tournamentEvents = vi.fn(() => Promise.resolve(answers.shift() ?? events("revealed", 12)));
    const tournament = vi.fn(() => Promise.resolve({ id: T, status: "running" }));
    const { result } = renderHook(() => useTournament({ tournament, tournamentEvents }, T, true));
    expect(result.current.state).toBe("loading");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tournamentEvents).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(tournamentEvents).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(tournamentEvents.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 5, 9]);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tournamentEvents).toHaveBeenCalledTimes(3);
    const r = result.current;
    expect(r.state === "ready" ? r.tournament.state : null).toBe("revealed");
  });

  it("reads a frozen tournament once", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const frozen = vi.fn(() => Promise.resolve(fixture("poll:counts") as TournamentPoll));
    const frozenApi = { tournament: () => Promise.resolve({ status: "frozen" }), tournamentEvents: frozen };
    renderHook(() => useTournament(frozenApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(frozen).toHaveBeenCalledTimes(1);
  });

  it("waits for the tab to be visible before polling a running one", async () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const running = vi.fn(() => Promise.resolve(events("running", 3)));
    const runningApi = { tournament: () => Promise.resolve({ status: "running" }), tournamentEvents: running };
    renderHook(() => useTournament(runningApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(running).toHaveBeenCalledTimes(0);
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(running).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(running).toHaveBeenCalledTimes(2);
  });

  it("says when the route is missing, an error before any data, and keeps shown data through a failed poll", async () => {
    setVisibility("visible");
    const missingApi = { tournament: () => Promise.reject(new ApiError(404, null, "/api/tournaments/x")), tournamentEvents: vi.fn() };
    const missing = renderHook(() => useTournament(missingApi, T, true));
    await waitFor(() => {
      expect(missing.result.current.state).toBe("missing");
    });
    const brokenApi = { tournament: () => Promise.resolve({}), tournamentEvents: () => Promise.reject(new ApiError(500, null, "x")) };
    const broken = renderHook(() => useTournament(brokenApi, T, true));
    await waitFor(() => {
      expect(broken.result.current.state).toBe("error");
    });
    broken.unmount();
    vi.useFakeTimers();
    setVisibility("visible");
    const answers: (() => Promise<TournamentPoll>)[] = [() => Promise.resolve(events("running", 4)), () => Promise.reject(new ApiError(503, null, "x")), () => Promise.resolve(events("revealed", 6))];
    const flaky = vi.fn(() => (answers.shift() ?? (() => Promise.resolve(events("revealed", 6))))());
    const keptApi = { tournament: () => Promise.resolve({ status: "running" }), tournamentEvents: flaky };
    const kept = renderHook(() => useTournament(keptApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(kept.result.current.state).toBe("ready");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(flaky.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 4, 4]);
    expect(kept.result.current.state).toBe("ready");
    const idleApi = { tournament: vi.fn(), tournamentEvents: vi.fn() };
    const idle = renderHook(() => useTournament(idleApi, null, true));
    expect(idle.result.current.state).toBe("idle");
  });
});

function page(from: number, n: number): TournamentPoll {
  const frames = Array.from({ length: n }, (_, i) => ({
    v: 1,
    seq: from + i,
    scope: "tournament",
    scope_id: T,
    ts: "2026-10-11T12:00:00Z",
    type: "trial.started",
    data: { trial_ref: from + i, trial_id: "22222222-2222-4222-8222-222222222222", pairing: "A1 x S1", track: "replay", block: null },
  }));
  return { visibility: "events", last: from + n - 1, frames } as TournamentPoll;
}

describe("useTournament paging and visibility", () => {
  it("drains every full page of a revealed tournament before it stops", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const pages = [page(1, 200), page(201, 1)];
    const tournamentEvents = vi.fn(() => Promise.resolve(pages.shift() ?? page(202, 0 + 1)));
    const pagedApi = { tournament: () => Promise.resolve({ status: "revealed" }), tournamentEvents };
    const { result } = renderHook(() => useTournament(pagedApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tournamentEvents.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 200]);
    const r = result.current;
    expect(r.state === "ready" ? r.tournament.trials.size : 0).toBe(201);
  });

  it("keeps draining from the same cursor after a failed page of a revealed tournament", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const answers: (() => Promise<TournamentPoll>)[] = [() => Promise.resolve(page(1, 200)), () => Promise.reject(new ApiError(503, null, "x")), () => Promise.resolve(page(201, 5))];
    const tournamentEvents = vi.fn(() => (answers.shift() ?? (() => Promise.resolve(page(206, 1))))());
    const drainApi = { tournament: () => Promise.resolve({ status: "revealed" }), tournamentEvents };
    const { result } = renderHook(() => useTournament(drainApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tournamentEvents.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 200, 200]);
    const r = result.current;
    expect(r.state === "ready" ? r.tournament.trials.size : 0).toBe(205);
  });

  it("recovers from a failed first poll and a failed state read: the error shows, the read is tried again", async () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const polls: (() => Promise<TournamentPoll>)[] = [() => Promise.reject(new ApiError(503, null, "x")), () => Promise.resolve(events("revealed", 4))];
    const tournamentEvents = vi.fn(() => (polls.shift() ?? (() => Promise.resolve(events("revealed", 4))))());
    const reads: (() => Promise<unknown>)[] = [() => Promise.reject(new ApiError(502, null, "x")), () => Promise.resolve({ status: "running" })];
    const tournament = vi.fn(() => (reads.shift() ?? (() => Promise.resolve({ status: "running" })))());
    const retryApi = { tournament, tournamentEvents };
    const { result } = renderHook(() => useTournament(retryApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.state).toBe("error");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(tournament).toHaveBeenCalledTimes(2);
    expect(tournamentEvents).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("error");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(tournamentEvents).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("ready");
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tournamentEvents).toHaveBeenCalledTimes(2);
  });

  it("sends nothing while the tab is hidden, at the start or after it hides during the wait", async () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    const tournamentEvents = vi.fn(() => Promise.resolve(events("running", 3)));
    const hiddenApi = { tournament: () => Promise.resolve({ status: "running" }), tournamentEvents };
    renderHook(() => useTournament(hiddenApi, T, true));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(tournamentEvents).not.toHaveBeenCalled();
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tournamentEvents).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(tournamentEvents).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tournamentEvents).toHaveBeenCalledTimes(2);
  });
});

describe("useTournamentList", () => {
  it("reads the list once enabled; a 404 is the route not being there", async () => {
    const tournaments = vi.fn(() => Promise.resolve({ tournaments: [{ id: T, name: "dev-demo", split: "dev", status: "revealed" }] }));
    const listApi = { tournaments };
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useTournamentList(listApi, on), { initialProps: { on: false } });
    expect(result.current.state).toBe("idle");
    rerender({ on: true });
    await waitFor(() => {
      expect(result.current.state).toBe("ready");
    });
    const missingApi = { tournaments: () => Promise.reject(new ApiError(404, null, "/api/tournaments")) };
    const missing = renderHook(() => useTournamentList(missingApi, true));
    await waitFor(() => {
      expect(missing.result.current.state).toBe("missing");
    });
    const badApi = { tournaments: () => Promise.resolve("x") };
    const bad = renderHook(() => useTournamentList(badApi, true));
    await waitFor(() => {
      expect(bad.result.current.state).toBe("error");
    });
  });
});
