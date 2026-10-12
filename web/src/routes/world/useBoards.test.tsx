// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import boards from "../../fixtures/leaderboard.example.json";
import { ApiError } from "../../lib/api/client";
import { REVEAL_TRIES, useBoards } from "./useBoards";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sealed = () => Promise.reject(new ApiError(409, "not_revealed", "/api/leaderboards/t"));

describe("useBoards", () => {
  it("reads the sealed state, then the published boards once the poll reports the tournament revealed", async () => {
    vi.useFakeTimers();
    let published = false;
    const leaderboard = vi.fn((_t: string, board: "assistant" | "subject") => (published ? Promise.resolve(board === "assistant" ? boards.assistant : boards.subject) : sealed()));
    const api = { leaderboard };
    const { result, rerender } = renderHook(({ revealed }: { revealed: boolean }) => useBoards(api, "t", null, true, revealed), { initialProps: { revealed: false } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current?.state.kind).toBe("sealed");
    // Not revealed: no retry.
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(leaderboard).toHaveBeenCalledTimes(2);
    // Revealed, but the boards trail the reveal by one read: tried again in 2 s.
    rerender({ revealed: true });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current?.state.kind).toBe("sealed");
    published = true;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(result.current?.state.kind).toBe("published");
    expect(result.current?.assistant).not.toBeNull();
  });

  it("stops retrying after REVEAL_TRIES reads, and reads nothing without a tournament", async () => {
    vi.useFakeTimers();
    const leaderboard = vi.fn(() => Promise.reject(new ApiError(404, null, "/api/leaderboards/t")));
    const api = { leaderboard };
    const { result } = renderHook(() => useBoards(api, "t", null, true, true));
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(leaderboard).toHaveBeenCalledTimes(REVEAL_TRIES * 2);
    expect(result.current?.state.kind).toBe("missing");
    const none = renderHook(() => useBoards(api, null, null, true, true));
    expect(none.result.current).toBe(null);
  });

  it("reads a board in another shape as an error, and the label it was asked for", async () => {
    const leaderboard = vi.fn(() => Promise.resolve({ nope: true }));
    const api = { leaderboard };
    const { result } = renderHook(() => useBoards(api, "t", "original", true, false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current?.state.kind).toBe("error");
    expect(leaderboard).toHaveBeenCalledWith("t", "assistant", "original");
  });
});
