// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASES } from "../../lib/world/cases";
import type { RecognitionRead } from "../../lib/precinct/boardSurfaces";
import { createPrecinctStationReads, type PrecinctStationReads } from "../../lib/api/precinctStationReads";
import { usePrecinctBoardSurfaces, type BoardSurfaceSession } from "./usePrecinctBoardSurfaces";

const offline: BoardSurfaceSession = { backend: "offline", me: null, stationReads: null, source: "idle", sessionKey: "idle", cases: CASES, selectedCase: null, packetState: "empty", assessmentActive: false };
const api = { progress: vi.fn<PrecinctStationReads["progress"]>(), readDebrief: vi.fn<PrecinctStationReads["readDebrief"]>(), tournaments: vi.fn<PrecinctStationReads["tournaments"]>(), tournament: vi.fn<PrecinctStationReads["tournament"]>(), tournamentEvents: vi.fn<PrecinctStationReads["tournamentEvents"]>(), leaderboard: vi.fn<PrecinctStationReads["leaderboard"]>() } satisfies PrecinctStationReads;
const local: BoardSurfaceSession = { ...offline, backend: "connected", stationReads: createPrecinctStationReads(api), me: { user_id: "local-user", display_name: "Trainee", roles: [], ex4_acknowledged: "2026-10-15T09:00:00Z", study: null, console: false, csrf_token: "test-only" } };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("route-owned physical board projection", () => {
  it("mounts offline without any API read and keeps callbacks stable within a source", () => {
    const { result, rerender } = renderHook(({ session }) => usePrecinctBoardSurfaces(session), { initialProps: { session: offline } });
    const sink = result.current.recognitionSink;
    expect(result.current.model.recognition.heading).toBe("No connected publication");
    rerender({ session: { ...offline } }); expect(result.current.recognitionSink).toBe(sink);
    rerender({ session: local });
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    expect(result.current.model.recognition.heading).toBe("Choose a supplied tournament");
  });
  it("retains only matching published data and rejects late reads from another run", () => {
    const { result, rerender } = renderHook(({ session }) => usePrecinctBoardSurfaces(session), { initialProps: { session: local } });
    const sink = result.current.recognitionSink;
    const published: RecognitionRead = { scope: sink.scope, tournamentId: "selected", label: null, ledger: "revealed", state: { kind: "published", tournamentId: "selected", label: null }, assistant: { board: "assistant", status: "definitive", notRanked: false, rows: [], pairwise: [], manifestHash: null, manifestVersion: null, isolationHash: null } };
    act(() => { sink.onRead(published); }); expect(result.current.model.recognition.heading).toBe("Published assistant board");
    const oldKey = result.current.model.recognition.key;
    rerender({ session: { ...local, source: "recording", sessionKey: "recorded-source" } });
    expect(result.current.model.recognition.heading).toBe("Choose a supplied tournament"); expect(result.current.model.recognition.key).not.toBe(oldKey);
    act(() => { sink.onRead(published); }); expect(result.current.model.recognition.heading).toBe("Choose a supplied tournament");
    rerender({ session: { ...local, assessmentActive: true } }); expect(result.current.model.recognition.heading).toBe("Assessment in progress");
    expect(result.current.model.cases.every((entry) => entry.heading === "Assessment in progress")).toBe(true);
    rerender({ session: offline }); expect(result.current.model.recognition.heading).toBe("No connected publication");
    rerender({ session: local }); expect(result.current.model.recognition.heading).toBe("Choose a supplied tournament");
    act(() => { sink.onRead(published); }); expect(result.current.model.recognition.heading).toBe("Choose a supplied tournament");
    act(() => { result.current.recognitionSink.onRead({ ...published, scope: result.current.recognitionSink.scope }); });
    expect(result.current.model.recognition.heading).toBe("Published assistant board");
    act(() => { sink.onRead({ ...published, ledger: "sealed" }); }); expect(result.current.model.recognition.heading).toBe("Published assistant board");
  });
  it("withholds stale offered titles when case packet or connection becomes pending", () => {
    const { result, rerender } = renderHook(({ session }) => usePrecinctBoardSurfaces(session), { initialProps: { session: local } });
    const shown = result.current.model.cases[0]?.key;
    rerender({ session: { ...local, packetState: "loading" } }); expect(result.current.model.cases[0]?.heading).toBe("Public source pending"); expect(result.current.model.cases[0]?.key).not.toBe(shown);
    rerender({ session: { ...local, backend: "connecting" } }); expect(result.current.model.cases[0]?.heading).toBe("Public source pending");
    rerender({ session: { ...local, stationReads: null } }); expect(result.current.model.cases[0]?.heading).toBe("Public source unavailable");
  });
});
