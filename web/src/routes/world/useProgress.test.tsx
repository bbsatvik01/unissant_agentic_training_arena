// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api/client";
import { useProgress } from "./useProgress";

afterEach(() => {
  cleanup();
});

const row = (id: string, status: string) => ({ session_id: id, trial_id: `t-${id}`, phase: "practice", mode: "practice", voice: false, status, created_at: "2026-10-24T14:00:00Z" });

describe("useProgress", () => {
  it("reads the list when opened, then each ended session's debrief", async () => {
    const readDebrief = vi.fn(() => Promise.resolve({ status: "scoring" } as never));
    const progress = vi.fn(() => Promise.resolve({ sessions: [row("a", "finalized"), row("b", "running")], kpi1: null }));
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useProgress({ progress, readDebrief }, open), { initialProps: { open: false } });
    expect(progress).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => {
      expect(result.current.scores["a"]).toBe("scoring");
    });
    expect(result.current.load.state).toBe("ready");
    expect(readDebrief).toHaveBeenCalledTimes(1);
  });

  it("reads a 404 as the route not being there yet, other failures as an error", async () => {
    const readDebrief = vi.fn();
    const missing = renderHook(() => useProgress({ progress: () => Promise.reject(new ApiError(404, null, "/api/progress")), readDebrief }, true));
    await waitFor(() => {
      expect(missing.result.current.load.state).toBe("missing");
    });
    const failed = renderHook(() => useProgress({ progress: () => Promise.reject(new ApiError(500, null, "/api/progress")), readDebrief }, true));
    await waitFor(() => {
      expect(failed.result.current.load.state).toBe("error");
    });
    const malformed = renderHook(() => useProgress({ progress: () => Promise.resolve({ sessions: "x" }), readDebrief }, true));
    await waitFor(() => {
      expect(malformed.result.current.load.state).toBe("error");
    });
  });
});
