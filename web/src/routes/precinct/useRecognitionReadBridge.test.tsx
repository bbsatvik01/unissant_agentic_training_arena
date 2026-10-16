// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecognitionRead } from "../../lib/precinct/boardSurfaces";
import { clearRecognitionRead, useRecognitionReadBridge, type RecognitionSink } from "./useRecognitionReadBridge";

afterEach(cleanup);
const pending: Omit<RecognitionRead, "scope"> = { tournamentId: "selected", label: null, ledger: "pending", state: null, assistant: null };
describe("canonical trophy read reflection", () => {
  it("does nothing without an explicit sink and performs no fetch", () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const { rerender } = renderHook<undefined, { sink: RecognitionSink | undefined; read: Omit<RecognitionRead, "scope"> }>(({ sink, read }) => { useRecognitionReadBridge(sink, read); return undefined; }, { initialProps: { sink: undefined, read: pending } });
    clearRecognitionRead(undefined, null, null);
    const onRead = vi.fn(); rerender({ sink: { scope: "source", onRead }, read: pending });
    expect(onRead).toHaveBeenCalledExactlyOnceWith({ ...pending, scope: "source" });
    expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
  it("deduplicates fresh sealed/error objects with identical primitive state", () => {
    const onRead = vi.fn(); const sink = { scope: "source", onRead };
    const { rerender } = renderHook<undefined, { read: Omit<RecognitionRead, "scope"> }>(({ read }) => { useRecognitionReadBridge(sink, read); return undefined; }, { initialProps: { read: { ...pending, ledger: "sealed", state: { kind: "sealed" } } } });
    rerender({ read: { ...pending, ledger: "sealed", state: { kind: "sealed" } } });
    expect(onRead).toHaveBeenCalledOnce();
    rerender({ read: { ...pending, ledger: "error", state: { kind: "error" } } }); expect(onRead).toHaveBeenCalledTimes(2);
  });
  it("reports changed source before paint and clears selected publication synchronously", () => {
    const onRead = vi.fn();
    const { rerender, unmount } = renderHook(({ scope }) => { useRecognitionReadBridge({ scope, onRead }, pending); }, { initialProps: { scope: "first" } });
    rerender({ scope: "second" }); expect(onRead.mock.lastCall?.[0]).toEqual({ ...pending, scope: "second" });
    clearRecognitionRead({ scope: "second", onRead }, "another", "original");
    expect(onRead.mock.lastCall?.[0]).toEqual({ scope: "second", tournamentId: "another", label: "original", ledger: "pending", state: null, assistant: null });
    const calls = onRead.mock.calls.length; unmount(); expect(onRead).toHaveBeenCalledTimes(calls);
  });
  it("reflects canonical publication identity without inventing a correction label", () => {
    const onRead = vi.fn(); const read: Omit<RecognitionRead, "scope"> = { ...pending, ledger: "revealed", state: { kind: "published", tournamentId: "selected", label: "corrected" } };
    renderHook(() => { useRecognitionReadBridge({ scope: "source", onRead }, read); });
    expect(onRead.mock.lastCall?.[0]).toEqual({ ...read, scope: "source" });
  });
});
